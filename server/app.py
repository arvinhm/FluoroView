"""
FluoroView v3 — optional companion backend.

A small FastAPI service that exposes *real* analysis endpoints the web client can
call for model-backed work on the user's own images:

  GET  /api/health          capability probe (what backends are installed)
  POST /api/segment         nuclei segmentation (StarDist/Cellpose if present,
                            else a real scikit-image watershed pipeline)
  POST /api/cluster         standardize -> PCA -> KMeans (+ UMAP if installed)
  POST /api/he2expression   EXPERIMENTAL H&E -> per-cell expression (research only)
  POST /api/spatial/*       CoSMoS spatial statistics — CARE / CAMSE / MOSAIC
                            (research use only; see spatial.py)

The web app works fully without this server (on-device demo). When the server is
running, the client can offload heavy/real computation here.

Run:  uvicorn app:app --host 0.0.0.0 --port 8010     (from the server/ directory)
"""
from __future__ import annotations

import io
import os
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from spatial import router as spatial_router

__version__ = "3.0.0"

# ---- optional heavy backends (probed, never required) ----------------------
def _has(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


CAPS = {
    "cellpose": _has("cellpose"),
    "stardist": _has("stardist"),
    "umap": _has("umap"),
    "torch": _has("torch"),
    "skimage": _has("skimage"),
    "sklearn": _has("sklearn"),
    "scipy": _has("scipy"),
    # CoSMoS ships with the server and needs only numpy, so it is always on.
    "cosmos": True,
}

app = FastAPI(title="FluoroView v3 API", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(spatial_router)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "version": __version__,
        "capabilities": CAPS,
        "segmentation_backend": _preferred_seg_backend(),
    }


def _preferred_seg_backend() -> str:
    if CAPS["stardist"]:
        return "stardist-he"
    if CAPS["cellpose"]:
        return "cellpose-sam"
    if CAPS["skimage"]:
        return "watershed"
    return "unavailable"


# ---- segmentation -----------------------------------------------------------
@app.post("/api/segment")
async def segment(file: UploadFile = File(...), backend: Optional[str] = None):
    from PIL import Image

    raw = await file.read()
    img = np.asarray(Image.open(io.BytesIO(raw)).convert("L"), dtype=np.float32) / 255.0

    chosen = backend or _preferred_seg_backend()
    if chosen == "cellpose-sam" and CAPS["cellpose"]:
        labels = _seg_cellpose(img)
    elif chosen == "stardist-he" and CAPS["stardist"]:
        labels = _seg_stardist(np.stack([img] * 3, -1))
    else:
        chosen = "watershed"
        labels = _seg_watershed(img)

    from skimage import measure

    props = measure.regionprops(labels)
    centroids = [[float(p.centroid[1]), float(p.centroid[0])] for p in props]
    diameters = [float(2.0 * np.sqrt(p.area / np.pi)) for p in props]
    return {
        "backend": chosen,
        "n_cells": int(labels.max()),
        "mean_diameter_px": float(np.mean(diameters)) if diameters else 0.0,
        "centroids": centroids[:5000],
        "width": int(img.shape[1]),
        "height": int(img.shape[0]),
    }


def _seg_watershed(gray: np.ndarray) -> np.ndarray:
    """Classical, dependency-light nuclei segmentation — always available."""
    from scipy import ndimage as ndi
    from skimage import feature, filters, morphology, segmentation

    smooth = filters.gaussian(gray, sigma=1.4)
    thr = filters.threshold_otsu(smooth)
    mask = smooth > thr
    mask = morphology.remove_small_objects(mask, 24)
    mask = morphology.binary_closing(mask, morphology.disk(2))
    distance = ndi.distance_transform_edt(mask)
    coords = feature.peak_local_max(distance, min_distance=6, labels=mask)
    markers = np.zeros(distance.shape, dtype=np.int32)
    for i, (r, c) in enumerate(coords, start=1):
        markers[r, c] = i
    return segmentation.watershed(-distance, markers, mask=mask)


def _seg_cellpose(gray: np.ndarray) -> np.ndarray:
    from cellpose import models

    model = models.Cellpose(model_type="cyto3")
    masks, *_ = model.eval((gray * 255).astype("uint8"), diameter=None, channels=[0, 0])
    return masks.astype(np.int32)


def _seg_stardist(rgb: np.ndarray) -> np.ndarray:
    from stardist.models import StarDist2D

    model = StarDist2D.from_pretrained("2D_versatile_he")
    labels, _ = model.predict_instances((rgb * 255).astype("uint8"))
    return labels.astype(np.int32)


# ---- clustering -------------------------------------------------------------
class ClusterRequest(BaseModel):
    matrix: list[list[float]]
    k: int = 8
    embed: bool = True


@app.post("/api/cluster")
def cluster(req: ClusterRequest):
    from sklearn.cluster import KMeans
    from sklearn.decomposition import PCA
    from sklearn.preprocessing import StandardScaler

    X = np.asarray(req.matrix, dtype=np.float32)
    Xs = StandardScaler().fit_transform(X)
    n_pc = int(min(8, Xs.shape[1]))
    pcs = PCA(n_components=n_pc).fit_transform(Xs)
    labels = KMeans(n_clusters=req.k, n_init=10, random_state=0).fit_predict(pcs)

    embedding = None
    if req.embed:
        if CAPS["umap"]:
            import umap

            embedding = umap.UMAP(n_neighbors=15, min_dist=0.1, random_state=0).fit_transform(pcs)
        else:
            embedding = pcs[:, :2]
        embedding = _unit(np.asarray(embedding))

    return {
        "labels": labels.astype(int).tolist(),
        "embedding": embedding.tolist() if embedding is not None else None,
        "embedding_method": "umap" if CAPS["umap"] else "pca",
        "k": req.k,
    }


def _unit(a: np.ndarray) -> np.ndarray:
    mn = a.min(0)
    rng = np.ptp(a, axis=0)
    rng[rng == 0] = 1
    s = rng.max()
    return (a - mn) / s


# ---- H&E -> single-cell expression (EXPERIMENTAL) ---------------------------
class ExprRequest(BaseModel):
    # per-cell morphology/marker feature vectors
    features: list[list[float]]
    genes: list[str]


@app.post("/api/he2expression")
def he2expression(req: ExprRequest):
    """
    EXPERIMENTAL research preview. Without trained weights this returns a
    transparent morphology-driven estimate rather than a validated prediction.
    NOT for clinical or diagnostic use.
    """
    X = np.asarray(req.features, dtype=np.float32)
    # deterministic linear projection per gene as a documented stand-in
    rng = np.random.default_rng(0)
    preds = {}
    for gi, gene in enumerate(req.genes):
        w = rng.normal(size=X.shape[1])
        raw = X @ w
        raw = (raw - raw.min()) / (np.ptp(raw) or 1)
        preds[gene] = raw.astype(float).tolist()
    return {
        "predictions": preds,
        "experimental": True,
        "validated": False,
        "note": "Morphology-derived estimate; connect trained weights for model-backed prediction.",
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8010"))
    uvicorn.run(app, host="0.0.0.0", port=port)

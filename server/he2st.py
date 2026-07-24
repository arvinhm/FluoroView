"""
H&E → Spatial Transcriptomics for FluoroView v3.

Two code paths, and the response always says which one produced the numbers:

  * `predict_scellst()`  — real per-cell inference via sCellST. Requires the
    `scellst` package, a trained MIL checkpoint (env `SCELLST_MIL_CKPT`) and an
    H&E image, because sCellST embeds an image crop around each nucleus and
    cannot run from coordinates alone. Reference adapter written against the
    upstream API; it has NOT been executed here (no GPU, and no public weights
    exist), so treat it as the integration seam, not a tested path.
  * `predict_fallback()` — a transparent numpy estimate from morphology and
    protein markers. Always available, deterministic, and the DEFAULT.

sCellST: Chadoutaud et al., Nat Commun 2026, DOI 10.1038/s41467-025-67965-1,
https://github.com/sysbio-curie/sCellST — licensed CC BY-NC 4.0
(NON-COMMERCIAL). The upstream repository ships no pretrained weights; enabling
the real path means training the MIL head yourself on gated HEST data.

The fallback's values are arbitrary units, NOT transcript counts. Every output
here is EXPERIMENTAL / research-only and NOT for clinical or diagnostic use.

The fallback algorithm is the validated reference `demo_he2st.py`, vendored
unchanged in substance.
"""
from __future__ import annotations

import base64
import io
import os
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

UNITS = "log1p-normalised (arbitrary units, not transcript counts)"
LICENSE = "CC BY-NC 4.0 (non-commercial)"
LICENSE_URL = "https://creativecommons.org/licenses/by-nc/4.0/"
ATTRIBUTION = (
    "Predictions powered by sCellST — Chadoutaud et al., "
    "'Learning single-cell gene expression from H&E images', Nat Commun 2026 "
    "(DOI 10.1038/s41467-025-67965-1). Licensed CC BY-NC 4.0 (non-commercial)."
)
FALLBACK_NOTE = (
    "Transparent morphology/marker-derived ESTIMATE — this is NOT sCellST and NOT a "
    "validated model output. Values are arbitrary units, not transcript counts. "
    "EXPERIMENTAL, research use only; not for clinical or diagnostic use."
)
SCELLST_NOTE = (
    "Per-cell expression predicted by sCellST (instance mode). EXPERIMENTAL / "
    "research-only; not for clinical or diagnostic use."
)

# ---------------------------------------------------------------------------
# Gene panel. Each gene is tagged with the cell-"program" it belongs to.
# This mirrors the biology sCellST is trained to recover (per-cell RNA), and
# the immune/stroma/tumor axes that FluoroView's 12-plex protein panel spans.
# ---------------------------------------------------------------------------
# program keys: tumor, prolif, tcell, bcell, myeloid, nk, fibroblast,
#               endothelial, housekeeping
GENE_PANEL: list[tuple[str, str]] = [
    # epithelial / tumor
    ("EPCAM", "tumor"), ("KRT8", "tumor"), ("KRT18", "tumor"), ("KRT19", "tumor"),
    ("CDH1", "tumor"), ("ERBB2", "tumor"), ("MUC1", "tumor"), ("ELF3", "tumor"),
    ("KRT5", "tumor"), ("EPCAM2", "tumor"),
    # proliferation
    ("MKI67", "prolif"), ("TOP2A", "prolif"), ("PCNA", "prolif"), ("CCNB1", "prolif"),
    # T cell
    ("CD3D", "tcell"), ("CD3E", "tcell"), ("CD2", "tcell"), ("CD8A", "tcell"),
    ("CD4", "tcell"), ("IL7R", "tcell"), ("FOXP3", "tcell"), ("GZMB", "tcell"),
    ("PDCD1", "tcell"), ("CTLA4", "tcell"),
    # B cell / plasma
    ("MS4A1", "bcell"), ("CD79A", "bcell"), ("CD79B", "bcell"), ("MZB1", "bcell"),
    ("IGHG1", "bcell"),
    # myeloid / macrophage
    ("CD68", "myeloid"), ("CD14", "myeloid"), ("LYZ", "myeloid"), ("ITGAX", "myeloid"),
    ("C1QA", "myeloid"), ("APOE", "myeloid"), ("CD274", "myeloid"),
    # NK
    ("NKG7", "nk"), ("KLRD1", "nk"), ("GNLY", "nk"),
    # fibroblast / stroma
    ("COL1A1", "fibroblast"), ("COL1A2", "fibroblast"), ("COL3A1", "fibroblast"),
    ("VIM", "fibroblast"), ("ACTA2", "fibroblast"), ("FN1", "fibroblast"),
    ("PDGFRB", "fibroblast"), ("DCN", "fibroblast"), ("LUM", "fibroblast"),
    # endothelial
    ("PECAM1", "endothelial"), ("VWF", "endothelial"), ("CLDN5", "endothelial"),
    ("CDH5", "endothelial"), ("FLT1", "endothelial"),
    # housekeeping / general
    ("ACTB", "housekeeping"), ("GAPDH", "housekeeping"), ("B2M", "housekeeping"),
    ("MALAT1", "housekeeping"),
]

PROGRAMS = ["tumor", "prolif", "tcell", "bcell", "myeloid", "nk",
            "fibroblast", "endothelial", "housekeeping"]

# FluoroView 12-plex protein panel order (index -> marker name).
MARKER_PANEL = ["DAPI", "PanCK", "Ki67", "PD-L1", "CD45", "CD3",
                "CD8", "CD4", "CD20", "CD68", "SMA", "CD31"]

# How each protein marker contributes to each program (rows: marker, cols: program).
# Used to turn a cell's multiplex protein vector into a soft program-activity vector.
MARKER_TO_PROGRAM: dict[str, dict[str, float]] = {
    "PanCK": {"tumor": 1.0},
    "Ki67": {"prolif": 1.0, "tumor": 0.2},
    "PD-L1": {"myeloid": 0.6, "tumor": 0.4},
    "CD45": {"tcell": 0.4, "bcell": 0.3, "myeloid": 0.4, "nk": 0.3},
    "CD3": {"tcell": 1.0},
    "CD8": {"tcell": 0.8, "nk": 0.4},
    "CD4": {"tcell": 0.8},
    "CD20": {"bcell": 1.0},
    "CD68": {"myeloid": 1.0},
    "SMA": {"fibroblast": 1.0},
    "CD31": {"endothelial": 1.0},
    "DAPI": {"housekeeping": 0.5},
}

# Fallback program mapping when a cell has no protein markers, only a typeIndex.
# (FluoroView's synthetic typeIndex scheme; kept coarse and clearly heuristic.)
TYPEINDEX_TO_PROGRAM = {
    0: "tumor", 1: "tcell", 2: "bcell", 3: "myeloid",
    4: "fibroblast", 5: "endothelial", 6: "fibroblast", 7: "nk",
}


@dataclass
class He2stResult:
    model: str
    experimental: bool
    validated: bool
    genes: list[str]
    units: str
    expression: np.ndarray  # (n_cells, n_genes)
    programs_used: list[str] = field(default_factory=list)


def _softplus(x: np.ndarray) -> np.ndarray:
    # numerically stable softplus
    return np.logaddexp(0.0, x)


def _zscore(x: np.ndarray) -> np.ndarray:
    mu = x.mean(axis=0, keepdims=True)
    sd = x.std(axis=0, keepdims=True)
    sd[sd == 0] = 1.0
    return (x - mu) / sd


def _local_density(xy: np.ndarray, radius: float) -> np.ndarray:
    """Count neighbours within `radius` (O(n^2); fine for a demo field of cells)."""
    n = xy.shape[0]
    if n == 0:
        return np.zeros(0)
    # chunk to keep memory bounded for a few thousand cells
    dens = np.zeros(n, dtype=np.float32)
    chunk = 512
    r2 = radius * radius
    for s in range(0, n, chunk):
        e = min(s + chunk, n)
        d2 = ((xy[s:e, None, :] - xy[None, :, :]) ** 2).sum(-1)
        dens[s:e] = (d2 <= r2).sum(1) - 1  # exclude self
    return dens


def _program_activity(
    n_cells: int,
    markers: np.ndarray | None,
    type_index: np.ndarray | None,
) -> np.ndarray:
    """Return (n_cells, n_programs) soft activity from protein markers or type."""
    A = np.zeros((n_cells, len(PROGRAMS)), dtype=np.float32)
    prog_idx = {p: i for i, p in enumerate(PROGRAMS)}

    if markers is not None and markers.shape[1] == len(MARKER_PANEL):
        mz = _zscore(markers)  # normalise each protein channel across cells
        mz = np.clip(mz, -2.5, 2.5)
        for mi, mname in enumerate(MARKER_PANEL):
            for prog, w in MARKER_TO_PROGRAM.get(mname, {}).items():
                A[:, prog_idx[prog]] += w * mz[:, mi]
    elif type_index is not None:
        for ci in range(n_cells):
            prog = TYPEINDEX_TO_PROGRAM.get(int(type_index[ci]) % 8, "housekeeping")
            A[ci, prog_idx[prog]] += 2.0

    # housekeeping is always modestly on
    A[:, prog_idx["housekeeping"]] += 0.75
    return A


def predict_he2st(
    cells: list[dict],
    genes: list[str] | None = None,
    seed: int = 0,
) -> He2stResult:
    """
    Fallback H&E->ST predictor.

    Parameters
    ----------
    cells : list of {id, x, y, r, typeIndex, markers?}
        markers is the optional 12-plex protein vector (FluoroView panel order).
    genes : optional subset of gene symbols to return (defaults to the full panel).
    seed  : deterministic seed so the same tissue always yields the same map.
    """
    panel = [(g, p) for (g, p) in GENE_PANEL if (genes is None or g in set(genes))]
    if not panel:
        raise ValueError("No requested genes found in the sCellST fallback panel.")
    gene_names = [g for g, _ in panel]
    gene_progs = [p for _, p in panel]
    prog_idx = {p: i for i, p in enumerate(PROGRAMS)}

    n = len(cells)
    xy = np.array([[c["x"], c["y"]] for c in cells], dtype=np.float32)
    r = np.array([c.get("r", 4.0) for c in cells], dtype=np.float32)
    type_index = np.array([c.get("typeIndex", 0) for c in cells], dtype=np.int64)
    has_markers = all("markers" in c and c["markers"] is not None for c in cells)
    markers = (
        np.array([c["markers"] for c in cells], dtype=np.float32) if has_markers else None
    )

    # --- per-cell program activity (the "biological" driver) ---------------
    A = _program_activity(n, markers, type_index)

    # spatial smoothing so the painted map looks tissue-like, not salt & pepper
    span = float(max(xy.ptp(0).max(), 1.0)) if n else 1.0
    dens = _local_density(xy, radius=0.04 * span)
    A_sm = A.copy()
    if n > 1:
        # one pass of neighbour averaging via the same radius
        chunk = 512
        rad2 = (0.05 * span) ** 2
        for s in range(0, n, chunk):
            e = min(s + chunk, n)
            d2 = ((xy[s:e, None, :] - xy[None, :, :]) ** 2).sum(-1)
            w = (d2 <= rad2).astype(np.float32)
            w /= w.sum(1, keepdims=True)
            A_sm[s:e] = 0.5 * A[s:e] + 0.5 * (w @ A)

    # --- morphology feature block ------------------------------------------
    feats = [_zscore(r.reshape(-1, 1)), _zscore(dens.reshape(-1, 1))]
    if markers is not None:
        feats.append(np.clip(_zscore(markers), -2.5, 2.5))
    F = np.concatenate(feats, axis=1)  # (n, d)

    # --- assemble expression -----------------------------------------------
    rng = np.random.default_rng(seed)
    n_genes = len(gene_names)
    W = rng.normal(scale=0.15, size=(F.shape[1], n_genes)).astype(np.float32)
    gene_baseline = rng.uniform(-1.2, -0.2, size=n_genes).astype(np.float32)
    prog_strength = 1.6

    program_term = np.stack(
        [A_sm[:, prog_idx[p]] for p in gene_progs], axis=1
    ) * prog_strength
    morph_term = F @ W
    noise = rng.normal(scale=0.05, size=(n, n_genes)).astype(np.float32)

    logits = program_term + morph_term + gene_baseline[None, :] + noise
    expr = _softplus(logits)          # non-negative
    expr = np.log1p(expr)             # emulate log1p-normalised expression

    return He2stResult(
        model="experimental-fallback",
        experimental=True,
        validated=False,
        genes=gene_names,
        units="log1p-normalized (arbitrary units)",
        expression=expr.astype(np.float32),
        programs_used=sorted(set(gene_progs)),
    )


# ======================================================================================
# Public API used by the endpoint
# ======================================================================================
def gene_panel_names() -> list[str]:
    """Every gene the fallback can produce, with its programme, for the UI picker."""
    return [g for g, _ in GENE_PANEL]


def gene_panel_with_programs() -> list[dict]:
    return [{"gene": g, "program": p} for g, p in GENE_PANEL]


def predict_fallback(cells: list[dict], genes: Optional[list[str]] = None, seed: int = 0) -> dict:
    """Fallback prediction, shaped for the HTTP response."""
    res = predict_he2st(cells, genes, seed=seed)
    return {
        "model": "experimental-fallback",
        "experimental": True,
        "validated": False,
        "genes": res.genes,
        "units": res.units,
        "cells": [
            {"id": int(cells[i].get("id", i)), "expression": [round(float(v), 4) for v in res.expression[i]]}
            for i in range(len(cells))
        ],
        "programs": res.programs_used,
        "license": LICENSE,
        "licenseUrl": LICENSE_URL,
        "attribution": ATTRIBUTION,
        "note": FALLBACK_NOTE,
    }


# ======================================================================================
# Real sCellST path (guarded). Enabled only when sCellST + a trained MIL checkpoint are
# present AND an H&E image is supplied; any failure must let the caller fall back.
# ======================================================================================
def scellst_importable() -> bool:
    try:
        import scellst  # noqa: F401
        import torch  # noqa: F401

        return True
    except Exception:
        return False


def scellst_weights_path() -> Optional[str]:
    """Path to a trained GeneLightningModel checkpoint, if configured and present."""
    p = os.environ.get("SCELLST_MIL_CKPT")
    return p if (p and os.path.exists(p)) else None


def scellst_ready() -> bool:
    return scellst_importable() and scellst_weights_path() is not None


def predict_scellst(cells: list[dict], genes: Optional[list[str]], image_b64: Optional[str], patch_size: int = 48) -> dict:
    """
    Run sCellST's per-cell (instance-mode) inference.

    Mirrors the upstream preprocessing: a `patch_size` crop around each nucleus,
    ImageNet (or MoCo v3) ResNet50 → 2048-d embedding → the trained gene head.
    Confirm the crop size and stain normalisation match the checkpoint you
    trained (see scellst/cellhest_adapter/cell_utils.py upstream).

    NOT EXERCISED in this repository — no GPU and no public weights. Validate it
    against your own checkpoint before trusting a single number.
    """
    import torch
    from PIL import Image
    from torchvision.transforms.v2 import CenterCrop, Compose, Normalize, ToDtype, ToImage

    from scellst.constant import REGISTRY_KEYS
    from scellst.lightning_model.gene_lightning_model import GeneLightningModel
    from scellst.module.image_encoder import InstanceEmbedder

    if not image_b64:
        raise RuntimeError("The sCellST path needs an H&E image (image_b64): it embeds a crop around each nucleus, so coordinates alone are not enough.")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ckpt = scellst_weights_path()
    ssl_weights = os.environ.get("SCELLST_SSL_WEIGHTS", "imagenet")

    model = GeneLightningModel.load_from_checkpoint(ckpt, map_location=device).to(device).eval()
    model.set_test_mode("instance")
    model_genes = list(model.gene_names)

    encoder = InstanceEmbedder("resnet50", ssl_weights).to(device).eval()

    img = np.asarray(Image.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB"))
    half = patch_size // 2
    tf = Compose(
        [
            ToImage(),
            ToDtype(torch.float32, scale=True),
            Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            CenterCrop(patch_size),
        ]
    )

    crops = []
    for c in cells:
        cx, cy = int(round(c["x"])), int(round(c["y"]))
        x0, y0 = max(0, cx - half), max(0, cy - half)
        patch = img[y0 : y0 + patch_size, x0 : x0 + patch_size]
        if patch.shape[0] != patch_size or patch.shape[1] != patch_size:
            patch = np.pad(patch, ((0, patch_size - patch.shape[0]), (0, patch_size - patch.shape[1]), (0, 0)), mode="edge")
        crops.append(tf(patch))
    batch = torch.stack(crops).to(device)

    with torch.inference_mode():
        emb = encoder(batch)
        out = model.model.predict_instance({REGISTRY_KEYS.X_KEY: emb})
        pred = out[REGISTRY_KEYS.OUTPUT_PREDICTION].float().cpu().numpy()

    want = [g for g in (genes or model_genes) if g in model_genes]
    if not want:
        raise RuntimeError("None of the requested genes are in the trained model's panel.")
    cols = [model_genes.index(g) for g in want]
    pred = pred[:, cols]

    return {
        "model": "scellst",
        "experimental": True,
        "validated": False,
        "genes": want,
        "units": UNITS,
        "cells": [{"id": int(cells[i].get("id", i)), "expression": [round(float(v), 4) for v in pred[i]]} for i in range(len(cells))],
        "programs": [],
        "license": LICENSE,
        "licenseUrl": LICENSE_URL,
        "attribution": ATTRIBUTION,
        "note": SCELLST_NOTE,
    }


def predict(cells: list[dict], genes: Optional[list[str]] = None, image_b64: Optional[str] = None, patch_size: int = 48, seed: int = 0) -> dict:
    """
    Prefer real sCellST when it is genuinely available, otherwise fall back.

    A failure in the real path is reported in `fallbackReason` rather than as a
    500, so the feature never breaks the app — but the response always states
    which model produced the numbers.
    """
    if scellst_ready() and image_b64:
        try:
            return predict_scellst(cells, genes, image_b64, patch_size)
        except Exception as e:  # noqa: BLE001 — any failure must degrade, not 500
            out = predict_fallback(cells, genes, seed=seed)
            out["fallbackReason"] = f"sCellST inference failed, used the fallback instead: {e}"
            return out
    out = predict_fallback(cells, genes, seed=seed)
    if not scellst_importable():
        out["fallbackReason"] = "sCellST is not installed in this backend environment (it is an optional, non-commercial, GPU-only dependency)."
    elif scellst_weights_path() is None:
        out["fallbackReason"] = "sCellST is installed but SCELLST_MIL_CKPT points to no checkpoint — upstream ships no pretrained weights, so the MIL head must be trained first."
    elif not image_b64:
        out["fallbackReason"] = "sCellST is ready but no H&E image was supplied; it needs pixels around each nucleus, not just coordinates."
    return out

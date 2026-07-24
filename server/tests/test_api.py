"""Real endpoint tests for the optional FluoroView backend (FastAPI TestClient).

These exercise the always-available code paths (no heavy ML backends required):
health probe, sklearn clustering, and the scikit-image watershed segmentation
on a tiny synthetic image.
"""
import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app import app

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert "capabilities" in data and isinstance(data["capabilities"], dict)
    assert "segmentation_backend" in data


def test_cluster_separates_two_blobs():
    rng = np.random.default_rng(0)
    a = rng.normal(0.0, 0.1, size=(40, 4))
    b = rng.normal(6.0, 0.1, size=(40, 4))
    matrix = np.vstack([a, b]).tolist()

    r = client.post("/api/cluster", json={"matrix": matrix, "k": 2, "embed": True})
    assert r.status_code == 200
    data = r.json()

    assert len(data["labels"]) == 80
    assert set(data["labels"]) == {0, 1}
    # Each true blob is assigned a single (distinct) cluster label.
    assert len(set(data["labels"][:40])) == 1
    assert len(set(data["labels"][40:])) == 1
    assert data["labels"][0] != data["labels"][40]
    assert data["embedding"] is not None
    assert len(data["embedding"]) == 80
    assert data["embedding_method"] in ("umap", "pca")


def _synthetic_blobs_png(size=128):
    yy, xx = np.mgrid[0:size, 0:size]
    img = np.zeros((size, size), dtype=np.float32)
    for cy, cx in [(32, 32), (32, 96), (96, 32), (96, 96), (64, 64)]:
        img += np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * 8.0 ** 2)))
    img = np.clip(img, 0, 1)
    buf = io.BytesIO()
    Image.fromarray((img * 255).astype("uint8")).save(buf, format="PNG")
    buf.seek(0)
    return buf


def test_segment_watershed_on_synthetic_image():
    buf = _synthetic_blobs_png(128)
    r = client.post(
        "/api/segment",
        params={"backend": "watershed"},
        files={"file": ("blobs.png", buf, "image/png")},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["backend"] == "watershed"
    assert data["width"] == 128 and data["height"] == 128
    # Five separated blobs -> several detected objects.
    assert data["n_cells"] >= 3
    assert data["mean_diameter_px"] > 0
    assert isinstance(data["centroids"], list)

"""H&E → spatial transcriptomics endpoint: shape, honesty, and never-500 behaviour."""
from __future__ import annotations

import numpy as np
from fastapi.testclient import TestClient

from app import app

client = TestClient(app)

MARKERS = ["DAPI", "PanCK", "Ki67", "PD-L1", "CD45", "CD3", "CD8", "CD4", "CD20", "CD68", "SMA", "CD31"]


def _tissue():
    """Three separated populations, each high in one lineage marker."""
    cells = []
    groups = {"tumour": [], "tcell": [], "stroma": []}
    spec = [("tumour", (100.0, 100.0), "PanCK", 0), ("tcell", (600.0, 120.0), "CD3", 1), ("stroma", (320.0, 520.0), "SMA", 4)]
    for name, (cx, cy), marker, ti in spec:
        for i in range(40):
            m = [0.05] * 12
            m[MARKERS.index("DAPI")] = 0.6
            m[MARKERS.index(marker)] = 0.9
            a = (i * 2.399963) % (2 * np.pi)
            rad = 12 + (i % 7) * 4
            groups[name].append(len(cells))
            cells.append({"id": len(cells), "x": cx + float(np.cos(a)) * rad, "y": cy + float(np.sin(a)) * rad, "r": 4.0, "typeIndex": ti, "markers": m})
    return cells, groups


def _mean(payload, ids, gene):
    gi = payload["genes"].index(gene)
    rows = {c["id"]: c["expression"] for c in payload["cells"]}
    return float(np.mean([rows[i][gi] for i in ids]))


def test_health_exposes_scellst_flags_and_backend_name():
    h = client.get("/api/health").json()
    caps = h["capabilities"]
    assert "scellst" in caps and "scellst_weights" in caps
    # No weights are shipped anywhere, so a bare install must report the fallback.
    assert h["he2st_backend"] in ("scellst", "experimental-fallback")
    if not caps["scellst_weights"]:
        assert h["he2st_backend"] == "experimental-fallback"


def test_panel_lists_genes_with_licence():
    p = client.get("/api/he2st/panel").json()
    assert len(p["genes"]) >= 50
    assert {"gene", "program"} <= set(p["genes"][0])
    assert "CC BY-NC" in p["license"]
    assert p["licenseUrl"].startswith("https://")
    assert "sCellST" in p["attribution"]


def test_prediction_is_labelled_experimental_and_unvalidated():
    cells, _ = _tissue()
    r = client.post("/api/he2st", json={"cells": cells, "genes": ["EPCAM", "CD3D", "ACTA2"]})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["experimental"] is True
    assert out["validated"] is False
    assert "CC BY-NC" in out["license"]
    assert len(out["cells"]) == len(cells)
    assert len(out["cells"][0]["expression"]) == 3
    # Without weights it must say plainly that this is not sCellST.
    if out["model"] == "experimental-fallback":
        assert "not scellst" in out["note"].lower()
        assert out["fallbackReason"]


def test_lineage_genes_land_in_the_matching_population():
    cells, g = _tissue()
    out = client.post("/api/he2st", json={"cells": cells, "genes": ["EPCAM", "CD3D", "ACTA2", "COL1A1"]}).json()
    assert _mean(out, g["tumour"], "EPCAM") > _mean(out, g["tcell"], "EPCAM")
    assert _mean(out, g["tcell"], "CD3D") > _mean(out, g["tumour"], "CD3D")
    for gene in ("ACTA2", "COL1A1"):
        assert _mean(out, g["stroma"], gene) > _mean(out, g["tumour"], gene)


def test_same_seed_same_numbers():
    cells, _ = _tissue()
    body = {"cells": cells, "genes": ["EPCAM", "CD3D"], "seed": 5}
    a = client.post("/api/he2st", json=body).json()
    b = client.post("/api/he2st", json=body).json()
    assert a["cells"] == b["cells"]


def test_missing_sCellST_never_500s_even_with_an_image():
    """A bogus image must degrade to the fallback, not raise."""
    cells, _ = _tissue()
    r = client.post("/api/he2st", json={"cells": cells[:10], "genes": ["EPCAM"], "image_b64": "not-base64-at-all"})
    assert r.status_code == 200, r.text
    assert r.json()["model"] == "experimental-fallback"


def test_bad_requests_are_rejected_clearly():
    assert client.post("/api/he2st", json={"cells": []}).status_code == 422
    cells, _ = _tissue()
    r = client.post("/api/he2st", json={"cells": cells, "genes": ["NOT_A_GENE"]})
    assert r.status_code == 422
    assert "panel" in r.text.lower()

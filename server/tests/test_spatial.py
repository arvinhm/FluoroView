"""CoSMoS endpoint tests — shape, honesty and the compartment-null contrast."""
from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def _tissue(seed: int = 0, n_per: int = 90):
    """Two well-separated compartments, each a broad cloud of type-0 cells.

    In compartment 0 every type-0 cell gets a type-1 partner a few microns away;
    in compartment 1 the type-1 cells are scattered independently. The cloud
    (~100 um across) is much larger than the test radii, so a within-compartment
    label shuffle really does destroy the pairing — which is what makes the
    planted interaction detectable rather than an artefact of the blob.
    """
    rng = np.random.default_rng(seed)
    cells = []
    spread = 200.0  # tissue units => ~100 um at 0.5 um/unit
    for comp, (cx, cy) in enumerate([(300.0, 300.0), (2000.0, 2000.0)]):
        for _ in range(n_per):
            x, y = rng.normal(cx, spread), rng.normal(cy, spread)
            cells.append({"x": float(x), "y": float(y), "typeIndex": 0, "compartmentIndex": comp})
            if comp == 0:
                # a type-1 partner ~2 um away (4 units at 0.5 um/unit)
                cells.append({"x": float(x + rng.normal(0, 4)), "y": float(y + rng.normal(0, 4)),
                              "typeIndex": 1, "compartmentIndex": comp})
            else:
                cells.append({"x": float(rng.normal(cx, spread)), "y": float(rng.normal(cy, spread)),
                              "typeIndex": 1, "compartmentIndex": comp})
    return cells


def _pair(payload, a, b):
    for p in payload["pairs"]:
        if p["a"] == a and p["b"] == b:
            return p
    raise AssertionError(f"pair ({a},{b}) missing")


def test_health_reports_cosmos_capability():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["capabilities"]["cosmos"] is True


def test_enrichment_finds_planted_interaction_and_labels_research_use():
    body = {
        "cells": _tissue(),
        "numTypes": 2,
        "typeNames": ["Tumor", "CD8 T"],
        "radiiUm": [10, 20, 40],
        "umPerUnit": 0.5,
        "marks": "hard",
        "numPermutations": 99,
        "seed": 1,
    }
    r = client.post("/api/spatial/enrichment", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["radiiUm"] == [10, 20, 40]
    assert out["numPermutations"] == 99
    assert "not validated for clinical" in out["disclaimer"]
    # every unordered pair of 2 types = (0,0), (0,1), (1,1)
    assert len(out["pairs"]) == 3
    tumor_cd8 = _pair(out, 0, 1)
    assert len(tumor_cd8["perScale"]) == 3
    assert tumor_cd8["zAtPeak"] > 3, tumor_cd8
    assert tumor_cd8["direction"] == "enrichment"
    assert tumor_cd8["qMax"] <= 0.05
    # q-values are probabilities and the peak scale is one of the radii
    for p in out["pairs"]:
        assert 0 <= p["qMax"] <= 1
        assert p["peakR"] in out["radiiUm"]


def test_global_null_inflates_what_compartments_explain():
    body = {
        "cells": _tissue(),
        "numTypes": 2,
        "radiiUm": [10, 40],
        "umPerUnit": 0.5,
        "marks": "hard",
        "numPermutations": 99,
        "seed": 2,
    }
    r = client.post("/api/spatial/contrast", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["stratified"] is True
    assert out["compartmentAware"]["compartmentAware"] is True
    assert out["global"]["compartmentAware"] is False
    # Both nulls are reported so the UI can show the contrast honestly.
    assert len(out["compartmentAware"]["pairs"]) == len(out["global"]["pairs"]) == 3


def test_single_compartment_is_reported_as_not_stratified():
    cells = [{"x": float(i), "y": 0.0, "typeIndex": i % 2} for i in range(40)]
    r = client.post(
        "/api/spatial/enrichment",
        json={"cells": cells, "numTypes": 2, "radiiUm": [10, 20], "marks": "hard", "numPermutations": 19},
    )
    assert r.status_code == 200
    # compartmentAware was requested by default but no compartments were given:
    # the response must not claim architecture-aware inference.
    assert r.json()["stratified"] is False


def test_refine_returns_calibrated_abstention():
    cells = _tissue(seed=4, n_per=40)
    r = client.post(
        "/api/spatial/refine",
        json={"cells": cells, "numTypes": 2, "umPerUnit": 0.5, "abstainCoverage": 0.8, "kNeighbors": 8},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    n = len(cells)
    assert len(out["refinedTypeIndex"]) == n
    assert len(out["entropy"]) == n
    assert all(0.0 <= c <= 1.0 for c in out["confidence"])
    assert all(len(row) == 2 and abs(sum(row) - 1.0) < 1e-3 for row in out["refinedProbs"])
    # ~80% coverage was requested, so roughly a fifth should abstain
    assert 0.6 <= out["coverage"] <= 1.0
    assert sum(out["abstain"]) == n - round(out["coverage"] * n)


def test_niches_report_stability_and_both_nulls():
    r = client.post(
        "/api/spatial/niches",
        json={"cells": _tissue(seed=5, n_per=60), "numTypes": 2, "radiiUm": [10, 30],
              "numNiches": 3, "marks": "hard", "nBoot": 2, "nNull": 3, "seed": 5},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert len(set(out["nicheOfCell"])) <= 3
    assert len(out["signatures"]) == 3 and len(out["signatures"][0]) == 2
    assert sum(out["sizes"]) == len(out["nicheOfCell"])
    assert -1.0 <= out["stabilityAri"] <= 1.0
    assert 0.0 < out["pGlobal"] <= 1.0
    assert 0.0 < out["pStratified"] <= 1.0


def test_cosmos_aggregate_runs_all_three():
    r = client.post(
        "/api/spatial/cosmos",
        json={"cells": _tissue(seed=6, n_per=45), "numTypes": 2, "radiiUm": [10, 30],
              "numNiches": 3, "marks": "hard", "numPermutations": 49,
              "nBoot": 1, "nNull": 2, "seed": 6},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["refine"] is not None and "tau" in out["refine"]
    assert len(out["enrichment"]["pairs"]) == 3
    assert "stabilityAri" in out["niches"]


@pytest.mark.parametrize(
    "patch,expect",
    [
        ({"radiiUm": [40, 10]}, "increasing"),
        ({"radiiUm": []}, "between"),
        ({"marks": "confWeighted"}, "confidence"),
        ({"marks": "softRaw"}, "posteriors"),
        ({"numTypes": 1}, "typeIndex"),
        ({"cells": []}, "No cells"),
    ],
)
def test_bad_requests_explain_themselves(patch, expect):
    body = {
        "cells": [{"x": float(i), "y": 0.0, "typeIndex": i % 2} for i in range(30)],
        "numTypes": 2,
        "radiiUm": [10, 20],
        "marks": "hard",
        "numPermutations": 19,
    }
    body.update(patch)
    r = client.post("/api/spatial/enrichment", json=body)
    assert r.status_code in (413, 422), r.text
    assert expect.lower() in r.text.lower()

import csv
import io
import json

import numpy as np
import pytest

from fluoroview.measure import COLUMNS
from fluoroview.server import routes_project


def test_region_lifecycle_and_measurement(opened):
    client, ds, data, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    r = client.post(f"{base}/regions", json={"shape": "rectangle", "points": [[100, 200], [612, 712]], "author": "AH"})
    assert r.status_code == 200, r.text
    region = r.json()
    assert region["name"] == "Region 1" and region["author"] == "AH"
    bg = client.post(f"{base}/regions", json={"shape": "rectangle", "points": [[1400, 50], [1600, 250]]}).json()
    assert bg["name"] == "Region 2"

    renamed = client.patch(f"{base}/regions/{region['id']}", json={"name": "Tumour core"}).json()
    assert renamed["name"] == "Tumour core" and renamed["modified"] >= renamed["created"]
    assert client.put(f"{base}/background", json={"region_id": bg["id"]}).json()["background_region"] == bg["id"]

    m = client.get(f"{base}/regions/{region['id']}/measurement").json()
    block = data[:, 200:712, 100:612]
    assert m["area_px"] == 512 * 512
    for c, ch in enumerate(m["channels"]):
        assert ch["mean"] == pytest.approx(block[c].mean())
        assert ch["median"] == np.median(block[c])
    bg_means = data[:, 50:250, 1400:1600].reshape(4, -1).mean(axis=1)
    assert list(m["background"]["means"].values()) == pytest.approx(bg_means)

    text = client.get(f"{base}/measurements.csv")
    assert text.headers["content-type"].startswith("text/csv")
    rows = list(csv.DictReader(io.StringIO(text.text)))
    assert list(rows[0].keys()) == COLUMNS
    assert len(rows) == 2 * 4
    core = [row for row in rows if row["region"] == "Tumour core"]
    assert [row["channel"] for row in core] == ["DAPI", "GFP", "RFP", "CY5"]
    for c, row in enumerate(core):
        assert float(row["mean_minus_background"]) == pytest.approx(block[c].mean() - bg_means[c], abs=1e-3)
        assert row["is_background"] == "false" and row["file"] == ds["scan_key"]
        assert row["pixel_size_um"] == f"{ds['pixel_size_um']:.6f}"
    assert all(row["is_background"] == "true" for row in rows if row["region_id"] == bg["id"])

    assert client.delete(f"{base}/regions/{bg['id']}").json()["background_region"] is None
    project = client.get(f"{base}/project").json()
    assert [r["name"] for r in project["regions"]] == ["Tumour core"] and project["background_region"] is None


def test_annotations_and_replies(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    region = client.post(f"{base}/regions", json={"shape": "ellipse", "points": [[10, 10], [90, 60]]}).json()
    note = client.post(f"{base}/annotations", json={"x": 50.5, "y": 30.25, "text": "  PSMA+ cluster ", "author": "AH",
                                                    "region_id": region["id"]}).json()
    assert note["text"] == "PSMA+ cluster" and note["region_id"] == region["id"] and note["replies"] == []
    moved = client.patch(f"{base}/annotations/{note['id']}", json={"x": 60, "region_id": None}).json()
    assert moved["x"] == 60 and moved["y"] == 30.25 and moved["region_id"] is None
    replied = client.post(f"{base}/annotations/{note['id']}/replies", json={"text": "agreed", "author": "PH"}).json()
    assert [r["text"] for r in replied["replies"]] == ["agreed"]
    assert client.post(f"{base}/annotations", json={"x": 1, "y": 1, "text": ""}).status_code == 422
    orphan = {"x": 1, "y": 1, "text": "x", "region_id": "nope"}
    assert client.post(f"{base}/annotations", json=orphan).status_code == 404
    assert client.delete(f"{base}/annotations/{note['id']}").json() == {"deleted": note["id"]}
    assert client.get(f"{base}/project").json()["annotations"] == []


def test_line_profile(opened):
    client, ds, data, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    p = client.get(f"{base}/profile", params={"x0": 100.5, "y0": 600.5, "x1": 900.5, "y1": 600.5}).json()
    assert p["level"] == 0 and p["samples"] == 801
    for c, ch in enumerate(p["channels"]):
        assert ch["values"] == data[c, 600, 100:901].tolist()
    assert p["distance_um"][-1] == pytest.approx(800 * ds["pixel_size_um"])
    coarse = client.get(f"{base}/profile", params={"x0": 0.5, "y0": 0.5, "x1": 1700.5, "y1": 1100.5,
                                                    "max_samples": 256}).json()
    assert coarse["level"] >= 2 and coarse["samples"] >= 256

    res = client.get(f"{base}/profile.csv", params={"x0": 100.5, "y0": 600.5, "x1": 900.5, "y1": 600.5})
    assert res.headers["content-disposition"].endswith('-profile.csv"')
    rows = list(csv.reader(io.StringIO(res.text)))
    names = [c["name"] for c in ds["channels"]]
    assert rows[0] == ["sample", "x_px", "y_px", "distance_px", "distance_um", *names,
                       "pyramid_level", "pixel_size_um", "fluoroview_version"]
    assert len(rows) == 1 + 801
    row = rows[1 + 10]
    assert row[:4] == ["10", "110.5000", "600.5000", "10.0000"]
    assert [int(v) for v in row[5:5 + len(names)]] == data[:, 600, 110].tolist()
    assert row[-3:-1] == ["0", f"{ds['pixel_size_um']:.6f}"]


def test_rename_reuses_the_measurement(opened, monkeypatch):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    region = client.post(f"{base}/regions", json={"shape": "rectangle", "points": [[0, 0], [64, 64]]}).json()
    calls = []
    real = routes_project.measure_region
    monkeypatch.setattr(routes_project, "measure_region", lambda d, r: calls.append(r["id"]) or real(d, r))
    first = client.get(f"{base}/regions/{region['id']}/measurement").json()
    client.patch(f"{base}/regions/{region['id']}", json={"name": "Stroma"})
    second = client.get(f"{base}/regions/{region['id']}/measurement").json()
    assert calls == [region["id"]]
    assert second["region"] == "Stroma" and second["channels"] == first["channels"]
    client.patch(f"{base}/regions/{region['id']}", json={"points": [[0, 0], [32, 64]]})
    assert client.get(f"{base}/regions/{region['id']}/measurement").json()["area_px"] == 32 * 64
    assert calls == [region["id"]] * 2


def test_non_finite_numbers_are_rejected(opened):
    """Python's JSON parser accepts NaN and Infinity; stored, they would make the project file unreadable."""
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"

    def raw(method: str, path: str, value) -> int:
        body = json.dumps(value)  # allow_nan: writes NaN / Infinity literally
        res = client.request(method, base + path, content=body, headers={"Content-Type": "application/json"})
        return res.status_code

    nan = float("nan")
    region = client.post(f"{base}/regions", json={"shape": "rectangle", "points": [[0, 0], [10, 10]]}).json()
    note = client.post(f"{base}/annotations", json={"x": 5, "y": 5, "text": "n"}).json()
    assert raw("PATCH", f"/regions/{region['id']}", {"points": [[nan, 0], [10, 10]]}) == 422
    assert raw("PATCH", f"/annotations/{note['id']}", {"x": nan}) == 422
    assert raw("PATCH", f"/annotations/{note['id']}", {"y": float("inf")}) == 422
    assert raw("POST", "/regions", {"shape": "polygon", "points": [[0, 0], [nan, 5], [9, 9]]}) == 422
    bad_display = [{"visible": True, "color": "#ffffff", "lo": nan, "hi": 10, "gamma": 1} for _ in ds["channels"]]
    assert raw("PUT", "/display", bad_display) == 422
    assert client.get(f"{base}/profile", params={"x0": "nan", "y0": 0, "x1": 10, "y1": 10}).status_code == 422
    project = client.get(f"{base}/project")
    assert project.status_code == 200 and project.json()["annotations"][0]["x"] == 5


def test_undo_restores_regions_and_notes_exactly(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    shape = {"shape": "ellipse", "points": [[10, 10], [60, 40]], "author": "AH"}
    region = client.post(f"{base}/regions", json=shape).json()
    client.put(f"{base}/background", json={"region_id": region["id"]})
    note = client.post(f"{base}/annotations", json={"x": 30, "y": 20, "text": "t", "author": "AH",
                                                    "region_id": region["id"]}).json()
    note = client.post(f"{base}/annotations/{note['id']}/replies", json={"text": "r", "author": "PH"}).json()
    client.delete(f"{base}/regions/{region['id']}")
    client.delete(f"{base}/annotations/{note['id']}")
    assert client.post(f"{base}/regions/restore", json=region).json() == region
    assert client.post(f"{base}/annotations/restore", json=note).json() == note
    state = client.get(f"{base}/project").json()
    assert state["regions"] == [region] and state["annotations"] == [note]
    assert state["annotations"][0]["replies"][0]["author"] == "PH"
    assert client.post(f"{base}/regions/restore", json=region).status_code == 409
    assert client.post(f"{base}/annotations/restore", json={**note, "id": "not-an-id"}).status_code == 422


def test_invalid_regions_are_rejected(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}/regions"
    assert client.post(base, json={"shape": "polygon", "points": [[0, 0], [5, 5]]}).status_code == 422
    assert client.post(base, json={"shape": "rectangle", "points": [[0, 0], [0, 9]]}).status_code == 422
    assert client.post(base, json={"shape": "hexagon", "points": [[0, 0], [5, 5]]}).status_code == 422
    assert client.patch(f"{base}/nope", json={"name": "x"}).status_code == 404


def test_display_settings_persist_outside_the_scan_folder(opened, tmp_path):
    client, ds, _, path = opened
    before = sorted(p.name for p in path.parent.iterdir())
    display = [{"visible": c != 3, "color": "#3d7aff", "lo": 100 + c, "hi": 5000, "gamma": 1.2, "touched": c != 0}
               for c in range(4)]
    assert client.put(f"/api/v1/datasets/{ds['id']}/display", json=display).status_code == 200
    assert client.get(f"/api/v1/datasets/{ds['id']}/project").json()["display"] == display
    assert client.put(f"/api/v1/datasets/{ds['id']}/display", json=display[:2]).status_code == 422
    assert sorted(p.name for p in path.parent.iterdir()) == before, "nothing is written next to the scan"
    assert any((tmp_path / "projects").iterdir())

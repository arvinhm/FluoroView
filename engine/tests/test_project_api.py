import csv
import io

import numpy as np
import pytest

from fluoroview.measure import COLUMNS

from .conftest import wait_ready


@pytest.fixture
def opened(client, biotek_image):
    path, data = biotek_image
    ds = wait_ready(client, client.post("/api/v1/datasets", json={"path": str(path)}).json()["id"])
    return client, ds, data, path


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
    assert all(row["is_background"] == "true" for row in rows if row["region_id"] == bg["id"])

    assert client.delete(f"{base}/regions/{bg['id']}").json()["background_region"] is None
    project = client.get(f"{base}/project").json()
    assert [r["name"] for r in project["regions"]] == ["Tumour core"] and project["background_region"] is None


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
    display = [{"visible": c != 3, "color": "#3d7aff", "lo": 100 + c, "hi": 5000, "gamma": 1.2} for c in range(4)]
    assert client.put(f"/api/v1/datasets/{ds['id']}/display", json=display).status_code == 200
    assert client.get(f"/api/v1/datasets/{ds['id']}/project").json()["display"] == display
    assert client.put(f"/api/v1/datasets/{ds['id']}/display", json=display[:2]).status_code == 422
    assert sorted(p.name for p in path.parent.iterdir()) == before, "nothing is written next to the scan"
    assert any((tmp_path / "projects").iterdir())

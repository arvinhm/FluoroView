import csv
import io

import pytest

from fluoroview.counting import COUNT_COLUMNS, POINT_COLUMNS

from .test_session import CLIENT_STATE, display


def rows(text: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(text)))


def test_cell_counter(opened, tmp_path):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    px = ds["pixel_size_um"]
    box = client.post(f"{base}/regions", json={"shape": "rectangle", "points": [[0, 0], [100, 100]], "name": "Box"})
    tri = client.post(f"{base}/regions", json={"shape": "polygon", "points": [[200, 0], [300, 0], [200, 100]],
                                               "name": "Tri"})
    cd8 = client.post(f"{base}/counters", json={"name": "CD8+", "color": "#ff5c8a"}).json()
    ki67 = client.post(f"{base}/counters", json={"name": "Ki67+", "color": "#4dd4ff"}).json()
    for x, y, c in [(10, 10, cd8), (0, 50, cd8), (100, 50, cd8), (210, 10, cd8), (250, 60, ki67), (500, 500, ki67)]:
        assert client.post(f"{base}/points", json={"x": x, "y": y, "counter": c["id"]}).status_code == 200
    assert client.post(f"{base}/points", json={"x": 1, "y": 1, "counter": "0" * 12}).status_code == 404

    points = rows(client.get(f"{base}/points.csv").text)
    assert list(points[0]) == POINT_COLUMNS and len(points) == 6
    assert [p["regions"] for p in points] == ["Box", "Box", "", "Tri", "", ""], "right edge of a rectangle is outside"
    assert points[0]["counter"] == "CD8+" and float(points[0]["x_um"]) == pytest.approx(10 * px, abs=1e-4)

    counts = {(r["counter"], r["region"]): r for r in rows(client.get(f"{base}/counts.csv").text)}
    assert list(next(iter(counts.values()))) == COUNT_COLUMNS
    assert counts["CD8+", "Box"]["count"] == "2" and counts["CD8+", "Tri"]["count"] == "1"
    assert counts["Ki67+", "Tri"]["count"] == "0" and counts["Ki67+", "whole image"]["count"] == "2"
    assert counts["CD8+", "Box"]["area_px"] == "10000"
    area_mm2 = 10000 * px**2 / 1e6
    assert float(counts["CD8+", "Box"]["density_per_mm2"]) == pytest.approx(2 / area_mm2, rel=1e-4)
    assert counts["CD8+", "whole image"]["area_px"] == str(ds["width"] * ds["height"])
    assert box.status_code == tri.status_code == 200

    fv = tmp_path / "count.fv"
    client.post(f"{base}/session", json={"path": str(fv), "display": display(4), **CLIENT_STATE})
    renamed = client.patch(f"{base}/counters/{ki67['id']}", json={"name": "Ki-67+"}).json()
    assert renamed["name"] == "Ki-67+"
    assert client.delete(f"{base}/counters/{cd8['id']}").json() == {"deleted": cd8["id"], "points_deleted": 4}
    project = client.get(f"{base}/project").json()
    assert [c["name"] for c in project["counters"]] == ["Ki-67+"] and len(project["points"]) == 2

    restored = client.post(f"{base}/session/apply", json={"path": str(fv), "mode": "replace"}).json()["project"]
    assert [c["name"] for c in restored["counters"]] == ["CD8+", "Ki67+"] and len(restored["points"]) == 6
    merged = client.post(f"{base}/session/apply", json={"path": str(fv), "mode": "merge"}).json()["project"]
    assert len(merged["counters"]) == 4 and len(merged["points"]) == 12
    new_ids = {c["id"] for c in merged["counters"][2:]}
    assert {p["counter"] for p in merged["points"][6:]} == new_ids, "merged points follow their renumbered categories"

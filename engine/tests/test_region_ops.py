import math

import numpy as np
import pytest

from fluoroview.regions import (
    bounds,
    contains_points,
    from_geometry,
    geometric_area,
    mask,
    perimeter,
    pixel_count,
    to_geometry,
)

from .test_session import CLIENT_STATE, display

OUTER = [(10, 10), (90, 10), (90, 90), (10, 90)]
HOLE = [(30, 30), (60, 30), (60, 60), (30, 60)]
ISLAND = [(120, 20), (140, 20), (140, 40), (120, 40)]
PENTAGRAM = [(50 + 40 * math.cos(math.radians(90 + 144 * k)), 50 - 40 * math.sin(math.radians(90 + 144 * k)))
             for k in range(5)]


def test_rings_combine_even_odd():
    rings = [HOLE, ISLAND]
    m = mask("polygon", OUTER, 0, 0, 160, 100, rings)
    assert m.sum() == 80 * 80 - 30 * 30 + 20 * 20
    assert m[20, 20] and not m[45, 45] and m[30, 130] and not m[30, 100]
    ys, xs = np.mgrid[0:100, 0:160]
    inside = contains_points("polygon", OUTER, xs.ravel() + 0.5, ys.ravel() + 0.5, rings)
    assert np.array_equal(inside.reshape(m.shape), m), "point test and rasterizer agree"
    assert pixel_count("polygon", OUTER, 160, 100, rings=rings) == m.sum()
    assert geometric_area("polygon", OUTER, rings) == pytest.approx(80 * 80 - 900 + 400)
    assert perimeter("polygon", OUTER, rings) == pytest.approx(320 + 120 + 80)
    assert bounds("polygon", OUTER, 160, 100, rings) == (10, 10, 140, 90)


def test_geometry_round_trip_keeps_the_pixels():
    """Self-intersecting outlines follow the even-odd rule: the pentagram's centre is not inside."""
    geom = to_geometry("polygon", PENTAGRAM)
    assert geom.is_valid and not geom.contains(to_geometry("rectangle", [(49, 49), (51, 51)]))
    points, rings = from_geometry(geom)
    before = mask("polygon", PENTAGRAM, 0, 0, 100, 100)
    after = mask("polygon", points, 0, 0, 100, 100, rings)
    assert before.sum() > 1000 and np.count_nonzero(before != after) <= 3
    held = from_geometry(to_geometry("polygon", OUTER, [HOLE, ISLAND]))
    assert held is not None and len(held[1]) == 2


def area_of(client, base, region) -> int:
    return client.get(f"{base}/regions/{region['id']}/measurement").json()["area_px"]


def test_region_operations(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"

    def add(shape, points, name, color="#ffffff"):
        return client.post(f"{base}/regions", json={"shape": shape, "points": points, "name": name,
                                                    "color": color}).json()

    def op(op, *regions, **extra):
        return client.post(f"{base}/regions/op", json={"op": op, "ids": [r["id"] for r in regions], **extra})

    a = add("rectangle", [[10, 10], [60, 60]], "A", "#ff5c8a")
    b = add("rectangle", [[40, 40], [90, 90]], "B")
    inner = add("rectangle", [[20, 20], [30, 30]], "C")
    far = add("rectangle", [[500, 500], [520, 520]], "Far")
    ma, mb = mask("rectangle", a["points"], 0, 0, 100, 100), mask("rectangle", b["points"], 0, 0, 100, 100)

    union = op("union", a, b).json()["regions"][0]
    assert union["name"] == "A ∪ B" and union["color"] == "#ff5c8a" and union["shape"] == "polygon"
    assert area_of(client, base, union) == int((ma | mb).sum()) == 4600
    assert area_of(client, base, op("intersect", a, b).json()["regions"][0]) == int((ma & mb).sum())
    assert area_of(client, base, op("xor", a, b).json()["regions"][0]) == int((ma ^ mb).sum())
    assert area_of(client, base, op("subtract", a, b).json()["regions"][0]) == int((ma & ~mb).sum())
    holed = op("subtract", a, inner).json()["regions"][0]
    assert len(holed["rings"]) == 1 and area_of(client, base, holed) == 2500 - 100

    assert op("intersect", a, far).status_code == 422
    assert op("union", a).status_code == 422
    assert op("union", a, {"id": "0" * 12}).status_code == 404

    grown = op("enlarge", a, distance=5).json()["regions"][0]
    assert grown["shape"] == "rectangle" and grown["points"] == [[5, 5], [65, 65]] and grown["name"] == "A +5 px"
    oval = add("ellipse", [[100, 100], [180, 140]], "Oval")
    shrunk = op("enlarge", oval, distance=-2).json()["regions"][0]
    assert shrunk["shape"] == "ellipse" and shrunk["points"] == [[102, 102], [178, 138]]
    um = op("enlarge", a, distance=1, unit="um").json()["regions"][0]
    step = 1 / ds["pixel_size_um"]
    assert um["points"] == [[math.floor(10 - step + 0.5)] * 2, [math.floor(60 + step + 0.5)] * 2]
    assert um["name"] == "A +1 µm"
    tri = add("polygon", [[200, 200], [300, 200], [200, 300]], "Tri")
    t_area, t_perim = 5000, 200 + math.hypot(100, 100)
    offset = op("enlarge", tri, distance=3).json()["regions"][0]
    assert geometric_area("polygon", offset["points"]) == pytest.approx(t_area + 3 * t_perim + math.pi * 9, rel=2e-3)
    assert op("enlarge", a).status_code == 422
    assert op("enlarge", inner, distance=-6).status_code == 422

    ell = add("polygon", [[400, 100], [480, 100], [480, 120], [420, 120], [420, 160], [400, 160]], "L")
    hull = op("hull", ell).json()["regions"][0]
    assert geometric_area("polygon", hull["points"]) == pytest.approx(80 * 20 + 20 * 40 + 0.5 * 60 * 40)

    fitted = op("ellipse", oval).json()["regions"][0]
    m_oval = client.get(f"{base}/regions/{oval['id']}/measurement").json()
    m_fit = client.get(f"{base}/regions/{fitted['id']}/measurement").json()
    assert m_fit["ellipse_major_px"] == pytest.approx(80, abs=1)
    assert m_fit["ellipse_minor_px"] == pytest.approx(40, abs=1)
    assert m_fit["area_px"] == pytest.approx(m_oval["area_px"], rel=0.01)
    assert m_fit["centroid_x_px"] == pytest.approx(140, abs=0.1)
    assert m_fit["centroid_y_px"] == pytest.approx(120, abs=0.1)

    names = [r["name"] for r in client.get(f"{base}/project").json()["regions"]]
    assert {"A", "B", "C", "Far", "Oval", "Tri", "L"} <= set(names), "the originals are kept"


def test_rings_everywhere(opened, tmp_path):
    """Holes are honoured by counting, moving, undo and sessions."""
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    donut = client.post(f"{base}/regions", json={"shape": "polygon", "points": OUTER, "rings": [HOLE],
                                                 "name": "Donut"}).json()
    assert client.post(f"{base}/regions", json={"shape": "rectangle", "points": [[0, 0], [5, 5]],
                                                "rings": [HOLE]}).status_code == 422
    counter = client.post(f"{base}/counters", json={"name": "Cells", "color": "#ffffff"}).json()
    for x, y in [(20, 20), (45, 45)]:
        client.post(f"{base}/points", json={"x": x, "y": y, "counter": counter["id"]})
    points = client.get(f"{base}/points.csv").text.splitlines()[1:]
    assert [p.split(",")[7] for p in points] == ["Donut", ""], "a point in the hole is outside"

    moved = client.patch(f"{base}/regions/{donut['id']}", json={
        "points": [[x + 100, y] for x, y in OUTER], "rings": [[[x + 100, y] for x, y in HOLE]]}).json()
    assert moved["rings"] == [[[x + 100.0, float(y)] for x, y in HOLE]]
    assert area_of(client, base, moved) == 80 * 80 - 30 * 30

    fv = tmp_path / "rings.fv"
    saved = client.post(f"{base}/session", json={"path": str(fv), "display": display(4), **CLIENT_STATE})
    assert saved.status_code == 200
    assert client.delete(f"{base}/regions/{donut['id']}").status_code == 200
    back = client.post(f"{base}/regions/restore", json=moved).json()
    assert back["rings"] == moved["rings"]
    client.delete(f"{base}/regions/{donut['id']}")
    restored = client.post(f"{base}/session/apply", json={"path": str(fv), "mode": "replace"}).json()["project"]
    assert restored["regions"][0]["rings"] == moved["rings"]
    plain = client.post(f"{base}/regions", json={"shape": "rectangle", "points": [[0, 0], [5, 5]]}).json()
    assert "rings" not in plain, "regions without holes are stored as before"

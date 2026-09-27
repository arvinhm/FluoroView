import io
import json
import math
import zipfile

import numpy as np
import pytest
from roifile import ROI_TYPE, ImagejRoi

from .test_region_ops import HOLE, OUTER

KAPPA = 0.5522847498  # cubic Bézier control distance for a quarter circle


def setup_regions(client, base) -> list[dict]:
    specs = [
        {"shape": "rectangle", "points": [[10, 10], [60, 40]], "name": "Box", "color": "#ff5c8a"},
        {"shape": "ellipse", "points": [[100, 100], [180, 140]], "name": "Oval", "color": "#4dd4ff"},
        {"shape": "polygon", "points": [[200.5, 200.25], [300, 200], [200, 300]], "name": "Tri", "color": "#ffd24d"},
        {"shape": "freehand", "points": [[400, 400], [450, 380], [480, 430], [420, 470]], "name": "Blob",
         "color": "#7cff6b"},
        {"shape": "polygon", "points": OUTER, "rings": [HOLE, [[120, 20], [140, 20], [140, 40], [120, 40]]],
         "name": "Donut", "color": "#b18cff"},
    ]
    return [client.post(f"{base}/regions", json=s).json() for s in specs]


def areas(client, base, regions) -> list[int]:
    return [client.get(f"{base}/regions/{r['id']}/measurement").json()["area_px"] for r in regions]


def upload(client, base, name: str, data: bytes):
    return client.post(f"{base}/regions/import", params={"filename": name}, content=data,
                       headers={"Content-Type": "application/octet-stream"})


def test_imagej_roiset_round_trip(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    originals = setup_regions(client, base)
    res = client.get(f"{base}/regions.zip")
    assert res.status_code == 200 and "RoiSet.zip" in res.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(res.content)) as z:
        assert z.namelist() == ["Box.roi", "Oval.roi", "Tri.roi", "Blob.roi", "Donut.roi"]
        rois = [ImagejRoi.frombytes(z.read(n)) for n in z.namelist()]
    assert [r.roitype for r in rois] == [ROI_TYPE.RECT, ROI_TYPE.OVAL, ROI_TYPE.POLYGON, ROI_TYPE.FREEHAND,
                                         ROI_TYPE.RECT]
    assert (rois[0].left, rois[0].top, rois[0].right, rois[0].bottom) == (10, 10, 60, 40)
    assert rois[2].subpixel_coordinates[0].tolist() == [200.5, 200.25], "sub-pixel vertices are kept"
    assert rois[4].composite and not rois[0].composite
    assert rois[0].hexcolor(rois[0].stroke_color) == "#ff5c8a" and rois[1].name == "Oval"

    imported = upload(client, base, "RoiSet.zip", res.content).json()
    back = imported["regions"]
    assert [r["name"] for r in back] == ["Box", "Oval", "Tri", "Blob", "Donut"]
    assert [r["shape"] for r in back] == ["rectangle", "ellipse", "polygon", "freehand", "polygon"]
    assert len(back[4]["rings"]) == 2 and back[0]["color"] == "#ff5c8a"
    assert areas(client, base, back) == areas(client, base, originals), "every region covers the same pixels"
    assert imported["skipped"] == {}


def test_imagej_curves_lines_and_points(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    cx, cy, r = 300.0, 300.0, 40.0
    k = KAPPA * r
    path = [0, cx + r, cy,
            3, cx + r, cy + k, cx + k, cy + r, cx, cy + r,
            3, cx - k, cy + r, cx - r, cy + k, cx - r, cy,
            3, cx - r, cy - k, cx - k, cy - r, cx, cy - r,
            3, cx + k, cy - r, cx + r, cy - k, cx + r, cy, 4]
    circle = ImagejRoi()
    circle.roitype = ROI_TYPE.RECT
    circle.multi_coordinates = np.asarray(path, dtype=np.float32)
    circle.shape_roi_size = len(path)
    circle.left, circle.top, circle.right, circle.bottom = 260, 260, 340, 340
    circle.name = "Curved"
    line = ImagejRoi()
    line.roitype = ROI_TYPE.LINE
    line.x1, line.y1, line.x2, line.y2 = 0.0, 0.0, 50.0, 50.0
    points = ImagejRoi.frompoints(np.array([[5, 5], [9, 9]]))
    points.roitype = ROI_TYPE.POINT
    square = ImagejRoi.frompoints(np.array([[20, 20], [40, 20], [40, 40], [20, 40]]), name="Square")
    square.roitype = ROI_TYPE.POLYGON
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for i, roi in enumerate([circle, line, points, square]):
            z.writestr(f"{i}.roi", roi.tobytes())

    imported = upload(client, base, "mixed.zip", buf.getvalue()).json()
    assert imported["skipped"] == {"lines": 1, "points": 1}
    curved, sq = imported["regions"]
    assert sq["points"] == [[20.0, 20.0], [40.0, 20.0], [40.0, 40.0], [20.0, 40.0]] and sq["name"] == "Square"
    assert areas(client, base, [sq]) == [400]
    assert areas(client, base, [curved])[0] == pytest.approx(math.pi * r * r, rel=0.01), "Bézier arcs are followed"
    assert upload(client, base, "one.roi", square.tobytes()).json()["regions"][0]["name"] == "Square"
    assert upload(client, base, "lines.zip", _zip({"l.roi": line.tobytes()})).status_code == 422


def _zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)
    return buf.getvalue()


def test_geojson_round_trip_and_qupath_details(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    originals = setup_regions(client, base)
    res = client.get(f"{base}/regions.geojson")
    assert res.status_code == 200 and res.headers["content-type"].startswith("application/geo+json")
    fc = json.loads(res.content)
    kinds = [f["geometry"]["type"] for f in fc["features"]]
    assert kinds == ["Polygon", "Polygon", "Polygon", "Polygon", "MultiPolygon"]
    donut = fc["features"][4]
    assert len(donut["geometry"]["coordinates"][0]) == 2, "the first part has its hole"
    assert donut["properties"] == {"objectType": "annotation", "name": "Donut", "color": [177, 140, 255],
                                   "isLocked": False}
    back = upload(client, base, "regions.geojson", res.content).json()["regions"]
    assert [r["name"] for r in back] == ["Box", "Oval", "Tri", "Blob", "Donut"]
    assert all(r["shape"] == "polygon" for r in back)
    assert areas(client, base, back)[0] == areas(client, base, originals)[0]
    assert areas(client, base, back)[4] == areas(client, base, originals)[4]
    oval_back, oval = areas(client, base, back)[1], areas(client, base, originals)[1]
    assert abs(oval_back - oval) <= 3, "an ellipse becomes a polygon of the same area; only edge pixels differ"

    square = [[[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]]]
    qupath = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": square},
         "properties": {"objectType": "annotation", "classification": {"name": "Tumor", "colorRGB": -3670016}}},
        {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [5, 0], [5, 5], [0, 0]]]},
         "properties": {"objectType": "detection"}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [3, 3]}, "properties": {}},
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [9, 9]]}, "properties": {}},
    ]}
    got = upload(client, base, "qupath.geojson", json.dumps(qupath).encode()).json()
    assert [(r["name"], r["color"]) for r in got["regions"]] == [("Tumor", "#c80000")]
    assert got["skipped"] == {"detections": 1, "points": 1, "lines": 1}


def test_import_errors(client, opened):
    _, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    assert client.get(f"{base}/regions.zip").status_code == 422, "nothing to export"
    assert upload(client, base, "notes.txt", b"hello").status_code == 422
    assert upload(client, base, "bad.zip", b"PK\x03\x04garbage").status_code == 422
    assert upload(client, base, "bad.geojson", b"{not json").status_code == 422
    assert upload(client, base, "empty.geojson", b'{"type": "FeatureCollection", "features": []}').status_code == 422

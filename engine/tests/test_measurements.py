"""ImageJ's measurement set, checked against independent computations on the rasterized pixels."""

import csv
import io
import math

import numpy as np
import pytest

from fluoroview.measure import COLUMNS
from fluoroview.regions import bounds, mask


def measure(client, ds, shape, points):
    base = f"/api/v1/datasets/{ds['id']}"
    region = client.post(f"{base}/regions", json={"shape": shape, "points": points}).json()
    return client.get(f"{base}/regions/{region['id']}/measurement").json()


def region_pixels(shape, points, width, height):
    x0, y0, x1, y1 = bounds(shape, points, width, height)
    inside = mask(shape, points, x0, y0, x1 - x0, y1 - y0)
    ys, xs = np.nonzero(inside)
    return inside, x0, y0, xs + x0 + 0.5, ys + y0 + 0.5


def moment_ellipse(xs, ys):
    """ImageJ-style fit: axes from the covariance of pixel centres, scaled to the pixel area."""
    cov = np.cov(np.vstack([xs, ys]), bias=True)
    l2, l1 = np.linalg.eigvalsh(cov)
    a, b = 2 * math.sqrt(l1), 2 * math.sqrt(l2)
    scale = math.sqrt(len(xs) / (math.pi * a * b))
    return 2 * a * scale, 2 * b * scale


def calipers(points):
    """Maximum and minimum width over directions 0–180° in 0.01° steps (brute force)."""
    pts = np.asarray(points, float)
    angles = np.radians(np.arange(0, 180, 0.01))
    proj = pts @ np.vstack([np.cos(angles), np.sin(angles)])
    extent = proj.max(axis=0) - proj.min(axis=0)
    return extent.max(), extent.min()


def test_rectangle_geometry(opened):
    client, ds, _, _ = opened
    m = measure(client, ds, "rectangle", [[10, 20], [110, 70]])
    assert m["area_px"] == 5000 and m["perimeter_px"] == 300
    assert (m["bbox_x_px"], m["bbox_y_px"], m["bbox_w_px"], m["bbox_h_px"]) == (10, 20, 100, 50)
    _, _, _, xs, ys = region_pixels("rectangle", [[10, 20], [110, 70]], ds["width"], ds["height"])
    major, minor = moment_ellipse(xs, ys)
    assert m["ellipse_major_px"] == pytest.approx(major) and m["ellipse_minor_px"] == pytest.approx(minor)
    assert m["ellipse_angle_deg"] == pytest.approx(0, abs=1e-6)
    assert m["circularity"] == pytest.approx(4 * math.pi * 5000 / 300**2)
    assert m["aspect_ratio"] == pytest.approx(major / minor)
    assert m["roundness"] == pytest.approx(4 * 5000 / (math.pi * major**2))
    assert m["solidity"] == 1 and m["feret_px"] == pytest.approx(math.hypot(100, 50)) and m["min_feret_px"] == 50
    assert m["perimeter_um"] == pytest.approx(300 * ds["pixel_size_um"])


def test_ellipse_fit_recovers_its_axes(opened):
    client, ds, _, _ = opened
    m = measure(client, ds, "ellipse", [[100, 100], [300, 200]])
    assert m["ellipse_major_px"] == pytest.approx(200, rel=0.01)
    assert m["ellipse_minor_px"] == pytest.approx(100, rel=0.01)
    assert (m["feret_px"], m["feret_angle_deg"], m["min_feret_px"]) == (200, 0, 100)
    tall = measure(client, ds, "ellipse", [[500, 100], [540, 300]])
    assert tall["ellipse_angle_deg"] == pytest.approx(90, abs=1e-6) and tall["feret_angle_deg"] == 90


def test_concave_polygon(opened):
    client, ds, _, _ = opened
    shape = [[0, 0], [100, 0], [100, 30], [30, 30], [30, 100], [0, 100]]
    m = measure(client, ds, "polygon", shape)
    assert m["perimeter_px"] == pytest.approx(400)
    hull_area = 100 * 100 - 70 * 70 / 2
    assert m["solidity"] == pytest.approx(5100 / hull_area)
    widest, narrowest = calipers(shape)
    assert m["feret_px"] == pytest.approx(widest, rel=1e-6) and m["feret_angle_deg"] == pytest.approx(45)
    assert m["min_feret_px"] == pytest.approx(narrowest, rel=1e-4)


def test_channel_statistics_match_numpy(opened):
    client, ds, data, _ = opened
    points = [[150, 250], [400, 500]]
    m = measure(client, ds, "ellipse", points)
    inside, x0, y0, _, _ = region_pixels("ellipse", points, ds["width"], ds["height"])
    h, w = inside.shape
    for c, stats in enumerate(m["channels"]):
        v = data[c, y0:y0 + h, x0:x0 + w][inside].astype(np.float64)
        mu, sd = v.mean(), v.std()
        assert stats["mode"] == int(np.bincount(v.astype(np.int64)).argmax())
        assert stats["skewness"] == pytest.approx(((v - mu) ** 3).mean() / sd**3, rel=1e-9)
        assert stats["kurtosis"] == pytest.approx(((v - mu) ** 4).mean() / sd**4 - 3, rel=1e-9)
        assert stats["int_den"] == pytest.approx(m["area_um2"] * mu)


def test_csv_has_the_new_columns_after_the_old_ones(opened):
    client, ds, _, _ = opened
    measure(client, ds, "rectangle", [[10, 20], [110, 70]])
    text = client.get(f"/api/v1/datasets/{ds['id']}/measurements.csv").text
    header = text.splitlines()[0].split(",")
    assert header == COLUMNS and header.index("measured_at") < header.index("perimeter_px")
    row = next(csv.DictReader(io.StringIO(text)))
    assert row["perimeter_px"] == "300.0000" and row["bbox_w_px"] == "100" and row["solidity"] == "1.0000"

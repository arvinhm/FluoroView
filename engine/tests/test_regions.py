import numpy as np
import pytest

from fluoroview.datasets import Dataset
from fluoroview.events import EventBus
from fluoroview.io import TiffSource
from fluoroview.measure import histogram_stats, measure_region
from fluoroview.pyramid.cache import PyramidCache
from fluoroview.regions import bounds, mask

STAR = [(40.3, 5.7), (52.1, 38.4), (88.9, 41.2), (58.6, 60.3), (70.2, 95.5), (40.0, 72.8), (9.8, 95.1),
        (22.4, 60.0), (-5.0, 40.7), (28.7, 38.9)]


def point_in_polygon(x: float, y: float, pts) -> bool:
    inside = False
    n = len(pts)
    for i in range(n):
        (xa, ya), (xb, yb) = pts[i], pts[(i + 1) % n]
        if ((ya <= y < yb) or (yb <= y < ya)) and x < xa + (y - ya) * (xb - xa) / (yb - ya):
            inside = not inside
    return inside


def reference_mask(shape: str, pts, x0: int, y0: int, w: int, h: int) -> np.ndarray:
    out = np.zeros((h, w), bool)
    for r in range(h):
        for c in range(w):
            x, y = x0 + c + 0.5, y0 + r + 0.5
            if shape == "rectangle":
                (xa, ya), (xb, yb) = pts
                out[r, c] = min(xa, xb) <= x < max(xa, xb) and min(ya, yb) <= y < max(ya, yb)
            elif shape == "ellipse":
                (xa, ya), (xb, yb) = pts
                rx, ry = abs(xb - xa) / 2, abs(yb - ya) / 2
                out[r, c] = ((x - (xa + xb) / 2) / rx) ** 2 + ((y - (ya + yb) / 2) / ry) ** 2 <= 1
            else:
                out[r, c] = point_in_polygon(x, y, pts)
    return out


@pytest.mark.parametrize(
    ("shape", "pts"),
    [
        ("rectangle", [(10.2, 20.7), (61.5, 3.1)]),
        ("ellipse", [(3.3, 4.4), (80.8, 51.9)]),
        ("polygon", STAR),
        ("freehand", [(10 + 30 * np.cos(t), 50 + 25 * np.sin(3 * t) * np.cos(t)) for t in np.linspace(0, 6.28, 180)]),
    ],
)
def test_mask_matches_brute_force(shape, pts):
    x0, y0, w, h = -3, 0, 100, 100
    np.testing.assert_array_equal(mask(shape, pts, x0, y0, w, h), reference_mask(shape, pts, x0, y0, w, h))


def test_adjacent_rectangles_share_no_pixels():
    a = mask("rectangle", [(0, 0), (10.5, 8)], 0, 0, 30, 10)
    b = mask("rectangle", [(10.5, 0), (20, 8)], 0, 0, 30, 10)
    assert not (a & b).any()
    assert (a | b)[:8, :20].all()


def test_bounds_clip_to_image():
    assert bounds("polygon", STAR, 64, 64) == (0, 5, 64, 64)
    assert bounds("rectangle", [(-10, -10), (-1, -1)], 64, 64) is None


def test_histogram_stats_match_numpy():
    rng = np.random.default_rng(11)
    for n in (1, 2, 7, 10, 1001):
        values = rng.integers(0, 65536, size=n, dtype=np.uint16)
        s = histogram_stats(np.bincount(values, minlength=65536), 65520)
        assert s["n_pixels"] == n
        assert s["mean"] == pytest.approx(values.mean())
        assert s["sd"] == pytest.approx(values.std(ddof=1) if n > 1 else 0.0)
        assert s["median"] == np.median(values)
        assert (s["min"], s["max"], s["sum"]) == (values.min(), values.max(), int(values.astype(np.int64).sum()))
        assert s["n_clipped"] == int((values >= 65520).sum())
    assert histogram_stats(np.zeros(65536, np.int64), 65520)["mean"] is None


@pytest.mark.parametrize(
    "region",
    [
        {"id": "r", "name": "R", "shape": "rectangle", "points": [[100.4, 450.2], [1300.7, 1050.9]]},
        {"id": "p", "name": "P", "shape": "polygon", "points": [[x * 13 + 400, y * 9 + 300] for x, y in STAR]},
        {"id": "e", "name": "E", "shape": "ellipse", "points": [[1500.0, 900.0], [1750.0, 1103.0]]},
    ],
)
def test_measurement_is_exact(biotek_image, tmp_path, region):
    path, data = biotek_image
    cache = PyramidCache(tmp_path / "cache", 10**9)
    ds = Dataset(cache.key_for(path), TiffSource(path), cache, EventBus())
    m = measure_region(ds, region)
    x0, y0, x1, y1 = bounds(region["shape"], region["points"], data.shape[2], data.shape[1])
    make = reference_mask if region["shape"] == "polygon" else mask
    inside = make(region["shape"], region["points"], x0, y0, x1 - x0, y1 - y0)
    ys, xs = np.nonzero(inside)
    assert m["area_px"] == inside.sum()
    px = ds.info.pixel_size_um
    assert m["area_um2"] == pytest.approx(inside.sum() * px * px)
    assert m["centroid_x_px"] == pytest.approx((xs + x0 + 0.5).mean())
    assert m["centroid_y_px"] == pytest.approx((ys + y0 + 0.5).mean())
    for c, ch in enumerate(m["channels"]):
        v = data[c, y0:y1, x0:x1][inside]
        assert ch["n_pixels"] == v.size
        assert ch["mean"] == pytest.approx(v.mean())
        assert ch["sd"] == pytest.approx(v.std(ddof=1))
        assert ch["median"] == np.median(v)
        assert (ch["min"], ch["max"]) == (v.min(), v.max())
        assert ch["sum"] == int(v.astype(np.int64).sum())
        assert ch["n_clipped"] == int((v >= 65520).sum())
    ds.source.close()

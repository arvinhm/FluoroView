"""Exact region measurements on raw full-resolution pixels, and the long-format CSV.

Each region is read in bands of rows; per channel, the values of the pixels inside the region are
counted into a full histogram (65,536 bins for 16-bit data). Mean, SD, median, min, max, sum and
the clipped count all follow exactly from that histogram, so memory stays bounded for regions of
any size. SD uses N - 1; the median of an even count is the mean of the two middle values.
"""

from __future__ import annotations

import csv
import io
import math

import numba as nb
import numpy as np

from . import __version__
from .projects import now_iso
from .regions import bounds, mask

MEASURE_ROWS = 512

COLUMNS = [
    "file", "region_id", "region", "shape", "is_background", "area_px", "area_um2",
    "centroid_x_px", "centroid_y_px", "centroid_x_um", "centroid_y_um", "channel", "n_pixels",
    "mean", "sd", "median", "min", "max", "sum", "n_clipped", "background_mean", "mean_minus_background",
    "pixel_size_um", "fluoroview_version", "measured_at",
]


@nb.njit(nogil=True, cache=True)
def masked_histogram(data, inside, out):
    h, w = data.shape
    for r in range(h):
        for c in range(w):
            if inside[r, c]:
                out[data[r, c]] += 1


def histogram_stats(hist: np.ndarray, saturation: int) -> dict:
    n = int(hist.sum())
    if n == 0:
        return {"n_pixels": 0, "mean": None, "sd": None, "median": None, "min": None, "max": None, "sum": 0,
                "n_clipped": 0}
    values = np.arange(hist.size, dtype=np.int64)
    total = int((hist * values).sum())
    mean = total / n
    var = float((hist * (values - mean) ** 2).sum()) / (n - 1) if n > 1 else 0.0
    cdf = np.cumsum(hist)
    k = (n + 1) // 2
    lower = int(np.searchsorted(cdf, k, side="left"))
    median = float(lower) if n % 2 else (lower + int(np.searchsorted(cdf, k + 1, side="left"))) / 2.0
    nz = np.flatnonzero(hist)
    return {"n_pixels": n, "mean": mean, "sd": math.sqrt(var), "median": median, "min": int(nz[0]),
            "max": int(nz[-1]), "sum": total, "n_clipped": int(hist[saturation:].sum())}


def measure_region(ds, region: dict) -> dict:
    """Area, centroid and per-channel statistics of one region of a dataset."""
    info = ds.info
    n_ch = len(info.channels)
    n_bins = 1 << (8 * np.dtype(info.dtype).itemsize)
    saturation = info.saturation if info.saturation is not None else n_bins - 1
    hists = np.zeros((n_ch, n_bins), np.int64)
    count, sx, sy = 0, 0.0, 0.0
    box = bounds(region["shape"], region["points"], info.width, info.height)
    if box is not None:
        x0, y0, x1, y1 = box
        xs = x0 + np.arange(x1 - x0) + 0.5
        for ya in range(y0, y1, MEASURE_ROWS):
            yb = min(y1, ya + MEASURE_ROWS)
            inside = mask(region["shape"], region["points"], x0, ya, x1 - x0, yb - ya)
            rows = inside.sum(axis=1)
            n = int(rows.sum())
            if n == 0:
                continue
            count += n
            sy += float(((ya + np.arange(yb - ya) + 0.5) * rows).sum())
            sx += float((xs * inside.sum(axis=0)).sum())
            for c in range(n_ch):
                masked_histogram(ds.read_region(0, c, x0, ya, x1, yb), inside, hists[c])
    px = info.pixel_size_um
    cx = sx / count if count else None
    cy = sy / count if count else None
    return {
        "region_id": region["id"],
        "region": region["name"],
        "shape": region["shape"],
        "area_px": count,
        "area_um2": count * px * px if px else None,
        "centroid_x_px": cx,
        "centroid_y_px": cy,
        "centroid_x_um": cx * px if px and cx is not None else None,
        "centroid_y_um": cy * px if px and cy is not None else None,
        "channels": [
            {"channel": ch.name, **histogram_stats(hists[i], saturation)} for i, ch in enumerate(info.channels)
        ],
    }


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def rows_for_scan(scan_name: str, pixel_size: float | None, measurements: list[dict],
                  background_id: str | None) -> list[dict]:
    """One row per region x channel; background columns are filled when a background region is set."""
    stamp = now_iso()
    background = next((m for m in measurements if m["region_id"] == background_id), None)
    bg_means = {c["channel"]: c["mean"] for c in background["channels"]} if background else {}
    rows = []
    for m in measurements:
        for ch in m["channels"]:
            bg = bg_means.get(ch["channel"])
            rows.append({
                "file": scan_name, "region_id": m["region_id"], "region": m["region"], "shape": m["shape"],
                "is_background": m["region_id"] == background_id, "area_px": m["area_px"],
                "area_um2": m["area_um2"], "centroid_x_px": m["centroid_x_px"], "centroid_y_px": m["centroid_y_px"],
                "centroid_x_um": m["centroid_x_um"], "centroid_y_um": m["centroid_y_um"], "channel": ch["channel"],
                "n_pixels": ch["n_pixels"], "mean": ch["mean"], "sd": ch["sd"], "median": ch["median"],
                "min": ch["min"], "max": ch["max"], "sum": ch["sum"], "n_clipped": ch["n_clipped"],
                "background_mean": bg,
                "mean_minus_background": ch["mean"] - bg if bg is not None and ch["mean"] is not None else None,
                "pixel_size_um": pixel_size, "fluoroview_version": __version__, "measured_at": stamp,
            })
    return rows


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({k: _cell(row.get(k)) for k in COLUMNS})
    return buf.getvalue()

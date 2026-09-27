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
from .regions import bounds, feret, imagej_angle, mask, perimeter, solidity

MEASURE_ROWS = 512

COLUMNS = [
    "file", "region_id", "region", "shape", "is_background", "area_px", "area_um2",
    "centroid_x_px", "centroid_y_px", "centroid_x_um", "centroid_y_um", "channel", "n_pixels",
    "mean", "sd", "median", "min", "max", "sum", "n_clipped", "background_mean", "mean_minus_background",
    "pixel_size_um", "fluoroview_version", "measured_at",
    # ImageJ's measurement set, appended so the columns above keep their positions
    "perimeter_px", "perimeter_um", "bbox_x_px", "bbox_y_px", "bbox_w_px", "bbox_h_px",
    "ellipse_major_px", "ellipse_minor_px", "ellipse_angle_deg", "circularity", "aspect_ratio", "roundness",
    "solidity", "feret_px", "feret_um", "feret_angle_deg", "min_feret_px", "min_feret_um",
    "mode", "skewness", "kurtosis", "int_den",
]
GEOMETRY = COLUMNS[COLUMNS.index("perimeter_px"):COLUMNS.index("mode")]


@nb.njit(nogil=True, cache=True)
def masked_histogram(data, inside, out):
    h, w = data.shape
    for r in range(h):
        for c in range(w):
            if inside[r, c]:
                out[data[r, c]] += 1


def histogram_stats(hist: np.ndarray, saturation: int) -> dict:
    """Exact statistics of the values counted in `hist`. SD uses N - 1; skewness and kurtosis are the
    population moments ImageJ reports (kurtosis in excess of the normal distribution's 3)."""
    n = int(hist.sum())
    if n == 0:
        return {"n_pixels": 0, "mean": None, "sd": None, "median": None, "min": None, "max": None, "sum": 0,
                "n_clipped": 0, "mode": None, "skewness": None, "kurtosis": None}
    values = np.arange(hist.size, dtype=np.int64)
    total = int((hist * values).sum())
    mean = total / n
    counts = hist.astype(np.float64)
    d = values - mean
    m2 = float((counts * d**2).sum()) / n
    var = m2 * n / (n - 1) if n > 1 else 0.0
    m3 = float((counts * d**3).sum()) / n
    m4 = float((counts * d**4).sum()) / n
    cdf = np.cumsum(hist)
    k = (n + 1) // 2
    lower = int(np.searchsorted(cdf, k, side="left"))
    median = float(lower) if n % 2 else (lower + int(np.searchsorted(cdf, k + 1, side="left"))) / 2.0
    nz = np.flatnonzero(hist)
    return {"n_pixels": n, "mean": mean, "sd": math.sqrt(var), "median": median, "min": int(nz[0]),
            "max": int(nz[-1]), "sum": total, "n_clipped": int(hist[saturation:].sum()), "mode": int(np.argmax(hist)),
            "skewness": m3 / m2**1.5 if m2 > 0 else 0.0, "kurtosis": m4 / m2**2 - 3.0 if m2 > 0 else 0.0}


def fitted_ellipse(n: int, sxx: float, syy: float, sxy: float) -> tuple[float, float, float]:
    """Major and minor axes (px) and angle of the ellipse with the pixels' second central moments,
    scaled to the pixels' area, as ImageJ's Fit Ellipse does."""
    cov_xx, cov_yy, cov_xy = sxx / n, syy / n, sxy / n
    half_trace = (cov_xx + cov_yy) / 2.0
    root = math.sqrt(max(0.0, ((cov_xx - cov_yy) / 2.0) ** 2 + cov_xy**2))
    l1, l2 = half_trace + root, max(half_trace - root, 0.0)
    a, b = 2.0 * math.sqrt(l1), 2.0 * math.sqrt(l2)
    scale = math.sqrt(n / (math.pi * a * b)) if a * b > 0 else 1.0
    theta = 0.5 * math.atan2(2.0 * cov_xy, cov_xx - cov_yy)
    return 2.0 * a * scale, 2.0 * b * scale, imagej_angle(math.cos(theta), math.sin(theta))


def measure_region(ds, region: dict, pixel_size: float | None) -> dict:
    """Area, centroid and per-channel statistics of one region; `pixel_size` in µm (None: pixels only)."""
    info = ds.info
    n_ch = len(info.channels)
    n_bins = 1 << (8 * np.dtype(info.dtype).itemsize)
    saturation = info.saturation if info.saturation is not None else n_bins - 1
    hists = np.zeros((n_ch, n_bins), np.int64)
    count, sx, sy, sxx, syy, sxy = 0, 0.0, 0.0, 0.0, 0.0, 0.0
    px_box = [math.inf, math.inf, -math.inf, -math.inf]
    box = bounds(region["shape"], region["points"], info.width, info.height)
    if box is not None:
        x0, y0, x1, y1 = box
        xs = np.arange(x1 - x0) + 0.5  # pixel centres, relative to the box for precise moments
        for ya in range(y0, y1, MEASURE_ROWS):
            yb = min(y1, ya + MEASURE_ROWS)
            inside = mask(region["shape"], region["points"], x0, ya, x1 - x0, yb - ya)
            rows = inside.sum(axis=1)
            n = int(rows.sum())
            if n == 0:
                continue
            cols = inside.sum(axis=0)
            ys = ya - y0 + np.arange(yb - ya) + 0.5
            count += n
            sx += float((xs * cols).sum())
            sy += float((ys * rows).sum())
            sxx += float((xs**2 * cols).sum())
            syy += float((ys**2 * rows).sum())
            sxy += float(ys @ (inside.astype(np.float64) @ xs))
            used_cols, used_rows = np.flatnonzero(cols), np.flatnonzero(rows)
            px_box = [min(px_box[0], x0 + int(used_cols[0])), min(px_box[1], ya + int(used_rows[0])),
                      max(px_box[2], x0 + int(used_cols[-1]) + 1), max(px_box[3], ya + int(used_rows[-1]) + 1)]
            for c in range(n_ch):
                masked_histogram(ds.read_region(0, c, x0, ya, x1, yb), inside, hists[c])
    px = pixel_size
    geometry = dict.fromkeys(GEOMETRY)
    cx = cy = None
    if count:
        mx, my = sx / count, sy / count
        cx, cy = x0 + mx, y0 + my
        major, minor, angle = fitted_ellipse(count, sxx - count * mx * mx, syy - count * my * my,
                                             sxy - count * mx * my)
        perim = perimeter(region["shape"], region["points"])
        fmax, fangle, fmin = feret(region["shape"], region["points"])
        geometry.update({
            "perimeter_px": perim, "perimeter_um": perim * px if px else None,
            "bbox_x_px": px_box[0], "bbox_y_px": px_box[1], "bbox_w_px": px_box[2] - px_box[0],
            "bbox_h_px": px_box[3] - px_box[1], "ellipse_major_px": major, "ellipse_minor_px": minor,
            "ellipse_angle_deg": angle, "circularity": min(1.0, 4 * math.pi * count / perim**2) if perim else None,
            "aspect_ratio": major / minor if minor else None,
            "roundness": 4 * count / (math.pi * major**2) if major else None,
            "solidity": solidity(region["shape"], region["points"]), "feret_px": fmax,
            "feret_um": fmax * px if px else None, "feret_angle_deg": fangle, "min_feret_px": fmin,
            "min_feret_um": fmin * px if px else None,
        })
    area = count * px * px if px else count
    channels = []
    for i, ch in enumerate(info.channels):
        stats = histogram_stats(hists[i], saturation)
        stats["int_den"] = area * stats["mean"] if stats["mean"] is not None else None
        channels.append({"channel": ch.name, **stats})
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
        **geometry,
        "channels": channels,
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
                "pixel_size_um": f"{pixel_size:.6f}" if pixel_size else None,
                "fluoroview_version": __version__, "measured_at": stamp,
                **{k: m.get(k) for k in GEOMETRY},
                "mode": ch["mode"], "skewness": ch["skewness"], "kurtosis": ch["kurtosis"], "int_den": ch["int_den"],
            })
    return rows


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({k: _cell(row.get(k)) for k in COLUMNS})
    return buf.getvalue()

"""Intensity profile along a line, sampled from the pyramid, and its CSV.

Lines up to ``max_samples`` pixels long are sampled at full resolution, one sample per pixel. Longer
lines use the coarsest level that still gives at least ``max_samples`` samples, whose pixels are
2x2 area means, so a slide-long line does not read gigabytes. Each sample is the pixel containing
the point (nearest), at the reported level.
"""

from __future__ import annotations

import csv
import io
import math

import numpy as np

from . import __version__
from .pyramid.store import TILE


def line_profile(ds, x0: float, y0: float, x1: float, y1: float, max_samples: int = 2048) -> dict:
    if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
        raise ValueError("the line must be given by finite numbers")
    length = math.hypot(x1 - x0, y1 - y0)
    level = 0 if length <= max_samples else min(len(ds.levels) - 1, math.floor(math.log2(length / max_samples)))
    lv = ds.levels[level]
    f = 2**level
    n = max(2, round(length / f) + 1)
    t = np.linspace(0.0, 1.0, n)
    xs = x0 + (x1 - x0) * t
    ys = y0 + (y1 - y0) * t
    ix = np.clip(np.floor(xs / f).astype(np.int64), 0, lv.width - 1)
    iy = np.clip(np.floor(ys / f).astype(np.int64), 0, lv.height - 1)
    n_ch = len(ds.info.channels)
    values = np.zeros((n_ch, n), np.int64)
    keys = (iy // TILE) * lv.tiles_x(TILE) + ix // TILE
    for key in np.unique(keys):
        sel = keys == key
        ty, tx = divmod(int(key), lv.tiles_x(TILE))
        for c in range(n_ch):
            data, _ = ds.tile(level, c, ty, tx)
            values[c, sel] = data[iy[sel] - ty * TILE, ix[sel] - tx * TILE]
    distance = t * length
    px = ds.info.pixel_size_um
    return {
        "level": level,
        "samples": n,
        "length_px": length,
        "x_px": xs.tolist(),
        "y_px": ys.tolist(),
        "distance_px": distance.tolist(),
        "distance_um": (distance * px).tolist() if px else None,
        "channels": [{"name": ch.name, "values": values[i].tolist()} for i, ch in enumerate(ds.info.channels)],
    }


def _unique(names: list[str], taken: set[str]) -> list[str]:
    out = []
    for name in names:
        candidate, k = name, 2
        while candidate in taken:
            candidate, k = f"{name}_{k}", k + 1
        taken.add(candidate)
        out.append(candidate)
    return out


def profile_csv(profile: dict, pixel_size_um: float | None) -> str:
    """Wide CSV, one row per sample: position, distance, one raw-value column per channel, provenance."""
    fixed = ["sample", "x_px", "y_px", "distance_px", "distance_um"]
    trailing = ["pyramid_level", "pixel_size_um", "fluoroview_version"]
    names = _unique([c["name"] for c in profile["channels"]], set(fixed + trailing))
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(fixed + names + trailing)
    um = profile["distance_um"]
    px = f"{pixel_size_um:.6f}" if pixel_size_um else ""
    for i in range(profile["samples"]):
        writer.writerow([
            i, f"{profile['x_px'][i]:.4f}", f"{profile['y_px'][i]:.4f}", f"{profile['distance_px'][i]:.4f}",
            f"{um[i]:.4f}" if um else "", *(c["values"][i] for c in profile["channels"]),
            profile["level"], px, __version__,
        ])
    return buf.getvalue()

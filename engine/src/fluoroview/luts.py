"""How a channel's values become colour, shared by the studio and figure export.

After the window (min to max) and gamma, a channel goes through its tone curve, optional inversion,
then its colour (a tint) or a colour map, then its intensity. The studio samples a table built the
same way from the same colour maps (luts.json), so exported figures match the screen.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

LUT_SIZE = 1024
COLORMAPS: dict[str, np.ndarray] = {
    name: np.asarray(rows, dtype=np.float64) / 255.0
    for name, rows in json.loads(Path(__file__).with_name("luts.json").read_text()).items()
}
IDENTITY_CURVE = ((0.0, 0.0), (1.0, 1.0))


def hex_rgb(color: str) -> np.ndarray:
    v = int(color.lstrip("#"), 16)
    return np.array([(v >> 16) & 255, (v >> 8) & 255, v & 255], dtype=np.float64) / 255.0


def _tangents(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Fritsch–Carlson tangents: the cubic through the points is monotone wherever the points are."""
    d = np.diff(ys) / np.diff(xs)
    m = np.empty(len(xs))
    m[0], m[-1] = d[0], d[-1]
    for k in range(1, len(xs) - 1):
        m[k] = 0.0 if d[k - 1] * d[k] <= 0 else (d[k - 1] + d[k]) / 2.0
    for k in range(len(d)):
        if d[k] == 0:
            m[k] = m[k + 1] = 0.0
    for k in range(len(d)):
        if d[k] == 0:
            continue
        a, b = m[k] / d[k], m[k + 1] / d[k]
        s = a * a + b * b
        if s > 9.0:
            tau = 3.0 / math.sqrt(s)
            m[k], m[k + 1] = tau * a * d[k], tau * b * d[k]
    return m


def curve_values(points, t: np.ndarray) -> np.ndarray:
    """The tone curve through `points` (x increasing from 0 to 1) at `t`: it passes through every point and
    never overshoots them."""
    t = np.asarray(t, dtype=np.float64)
    pts = np.asarray(points, dtype=np.float64)
    if len(pts) == 2 and np.array_equal(pts, IDENTITY_CURVE):
        return np.clip(t, 0.0, 1.0)
    xs, ys = pts[:, 0], pts[:, 1]
    m = _tangents(xs, ys)
    k = np.clip(np.searchsorted(xs, t, side="right") - 1, 0, len(xs) - 2)
    h = xs[k + 1] - xs[k]
    s = (t - xs[k]) / h
    s2, s3 = s * s, s * s * s
    y = ((2 * s3 - 3 * s2 + 1) * ys[k] + (s3 - 2 * s2 + s) * h * m[k] + (-2 * s3 + 3 * s2) * ys[k + 1]
         + (s3 - s2) * h * m[k + 1])
    return np.clip(y, 0.0, 1.0)


def colormap_values(name: str, y: np.ndarray) -> np.ndarray:
    """Colours of a colour map at `y` (0 to 1), interpolated between its evenly spaced stops."""
    stops = COLORMAPS[name]
    grid = np.linspace(0.0, 1.0, len(stops))
    return np.stack([np.interp(y, grid, stops[:, i]) for i in range(3)], axis=-1)


def channel_lut(color: str, lut: str, invert: bool, curve, intensity: float, size: int = LUT_SIZE) -> np.ndarray:
    """(size, 3) RGB, 0 to 1, for evenly spaced values after the window and gamma."""
    y = curve_values(curve, np.linspace(0.0, 1.0, size))
    if invert:
        y = 1.0 - y
    rgb = y[:, None] * hex_rgb(color)[None, :] if lut == "color" else colormap_values(lut, y)
    return rgb * intensity

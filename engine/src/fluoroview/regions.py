"""Region geometry in full-resolution pixel coordinates, and exact rasterization.

A pixel belongs to a region when its centre (x + 0.5, y + 0.5) lies inside the shape. Rectangles are
half-open, so adjacent rectangles never share pixels; polygons use the even-odd rule.
"""

from __future__ import annotations

import math
import uuid
from typing import Literal

import numba as nb
import numpy as np
from pydantic import BaseModel, Field, field_validator

from .projects import now_iso

Shape = Literal["rectangle", "ellipse", "polygon", "freehand"]
REGION_COLOR = "#ffffff"


class RegionIn(BaseModel):
    shape: Shape
    points: list[tuple[float, float]] = Field(min_length=2, max_length=20000)
    name: str | None = Field(default=None, max_length=200)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    author: str | None = Field(default=None, max_length=200)

    @field_validator("points")
    @classmethod
    def finite(cls, pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if not all(math.isfinite(x) and math.isfinite(y) for x, y in pts):
            raise ValueError("points must be finite numbers")
        return pts


class RegionPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    points: list[tuple[float, float]] | None = Field(default=None, min_length=2, max_length=20000)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


def validate_shape(shape: str, points: list[tuple[float, float]]) -> None:
    if shape in ("rectangle", "ellipse"):
        if len(points) != 2:
            raise ValueError(f"a {shape} is given by two opposite corners")
        (xa, ya), (xb, yb) = points
        if xa == xb or ya == yb:
            raise ValueError(f"the {shape} has no area")
    elif len(points) < 3:
        raise ValueError("a polygon needs at least three points")


def new_region(req: RegionIn, index: int) -> dict:
    validate_shape(req.shape, req.points)
    stamp = now_iso()
    return {
        "id": uuid.uuid4().hex[:12],
        "name": req.name or f"Region {index}",
        "shape": req.shape,
        "points": [[float(x), float(y)] for x, y in req.points],
        "color": req.color or REGION_COLOR,
        "created": stamp,
        "modified": stamp,
        "author": req.author,
    }


def bounds(shape: str, points, width: int, height: int) -> tuple[int, int, int, int] | None:
    """Integer pixel box [x0, x1) x [y0, y1) that holds every included pixel, clipped to the image."""
    pts = np.asarray(points, dtype=np.float64)
    xmin, ymin = pts.min(axis=0)
    xmax, ymax = pts.max(axis=0)
    x0 = max(0, math.floor(xmin))
    y0 = max(0, math.floor(ymin))
    x1 = min(width, math.ceil(xmax))
    y1 = min(height, math.ceil(ymax))
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def mask(shape: str, points, x0: int, y0: int, w: int, h: int) -> np.ndarray:
    """Boolean mask of the pixels in [x0, x0+w) x [y0, y0+h) whose centres are inside the region."""
    pts = np.asarray(points, dtype=np.float64)
    cx = x0 + np.arange(w) + 0.5
    cy = y0 + np.arange(h) + 0.5
    if shape == "rectangle":
        (xa, ya), (xb, yb) = pts
        inx = (cx >= min(xa, xb)) & (cx < max(xa, xb))
        iny = (cy >= min(ya, yb)) & (cy < max(ya, yb))
        return iny[:, None] & inx[None, :]
    if shape == "ellipse":
        (xa, ya), (xb, yb) = pts
        ex, ey = (xa + xb) / 2, (ya + yb) / 2
        rx, ry = abs(xb - xa) / 2, abs(yb - ya) / 2
        return ((cx[None, :] - ex) / rx) ** 2 + ((cy[:, None] - ey) / ry) ** 2 <= 1.0
    out = np.zeros((h, w), dtype=np.bool_)
    _fill_polygon(pts[:, 0].copy(), pts[:, 1].copy(), float(x0), float(y0), out)
    return out


@nb.njit(nogil=True, cache=True)
def _fill_polygon(xs, ys, x0, y0, out):
    h, w = out.shape
    n = xs.shape[0]
    cross = np.empty(n, np.float64)
    for r in range(h):
        y = y0 + r + 0.5
        k = 0
        for i in range(n):
            j = (i + 1) % n
            ya, yb = ys[i], ys[j]
            if (ya <= y < yb) or (yb <= y < ya):
                cross[k] = xs[i] + (y - ya) * (xs[j] - xs[i]) / (yb - ya)
                k += 1
        if k < 2:
            continue
        xsorted = np.sort(cross[:k])
        for p in range(0, k - 1, 2):
            first = int(math.ceil(xsorted[p] - x0 - 0.5))
            last = int(math.ceil(xsorted[p + 1] - x0 - 0.5))  # exclusive
            if first < 0:
                first = 0
            if last > w:
                last = w
            for c in range(first, last):
                out[r, c] = True

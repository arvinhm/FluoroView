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
from pydantic import BaseModel, Field, FiniteFloat

from .projects import now_iso

Shape = Literal["rectangle", "ellipse", "polygon", "freehand"]
Point = tuple[FiniteFloat, FiniteFloat]
REGION_COLOR = "#ffffff"
COLOR = r"^#[0-9a-fA-F]{6}$"
ITEM_ID = r"^[0-9a-f]{12}$"


class RegionIn(BaseModel):
    shape: Shape
    points: list[Point] = Field(min_length=2, max_length=20000)
    name: str | None = Field(default=None, max_length=200)
    color: str | None = Field(default=None, pattern=COLOR)
    author: str | None = Field(default=None, max_length=200)


class RegionPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    points: list[Point] | None = Field(default=None, min_length=2, max_length=20000)
    color: str | None = Field(default=None, pattern=COLOR)


class RegionRestore(BaseModel):
    """A region exactly as it was (same id), to undo a deletion or load a saved session."""

    id: str = Field(pattern=ITEM_ID)
    name: str = Field(min_length=1, max_length=200)
    shape: Shape
    points: list[Point] = Field(min_length=2, max_length=20000)
    color: str = Field(pattern=COLOR)
    created: str = Field(max_length=40)
    modified: str = Field(max_length=40)
    author: str | None = Field(default=None, max_length=200)


class AnnotationIn(BaseModel):
    x: FiniteFloat
    y: FiniteFloat
    text: str = Field(min_length=1, max_length=5000)
    author: str | None = Field(default=None, max_length=200)
    region_id: str | None = None


class AnnotationPatch(BaseModel):
    x: FiniteFloat | None = None
    y: FiniteFloat | None = None
    text: str | None = Field(default=None, min_length=1, max_length=5000)
    region_id: str | None = None


class ReplyIn(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    author: str | None = Field(default=None, max_length=200)


class ReplyRestore(ReplyIn):
    id: str = Field(pattern=ITEM_ID)
    created: str = Field(max_length=40)


class AnnotationRestore(BaseModel):
    """A note exactly as it was, with its author and replies."""

    id: str = Field(pattern=ITEM_ID)
    x: FiniteFloat
    y: FiniteFloat
    text: str = Field(min_length=1, max_length=5000)
    author: str | None = Field(default=None, max_length=200)
    region_id: str | None = Field(default=None, pattern=ITEM_ID)
    created: str = Field(max_length=40)
    modified: str = Field(max_length=40)
    replies: list[ReplyRestore] = Field(default_factory=list, max_length=1000)


def new_annotation(req: AnnotationIn) -> dict:
    stamp = now_iso()
    return {"id": uuid.uuid4().hex[:12], "x": req.x, "y": req.y, "text": req.text.strip(), "author": req.author,
            "region_id": req.region_id, "created": stamp, "modified": stamp, "replies": []}


def new_reply(req: ReplyIn) -> dict:
    return {"id": uuid.uuid4().hex[:12], "text": req.text.strip(), "author": req.author, "created": now_iso()}


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


def imagej_angle(dx: float, dy: float) -> float:
    """Direction of (dx, dy) in image coordinates (y down) as ImageJ reports it: degrees 0–180, y up."""
    return math.degrees(math.atan2(-dy, dx)) % 180.0


def _box(points) -> tuple[float, float, float, float]:
    (xa, ya), (xb, yb) = points
    return min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb)


def perimeter(shape: str, points) -> float:
    """Length of the outline: exact for rectangles and polygons, Ramanujan's approximation for ellipses."""
    if shape in ("rectangle", "ellipse"):
        x0, y0, x1, y1 = _box(points)
        if shape == "rectangle":
            return 2.0 * ((x1 - x0) + (y1 - y0))
        a, b = (x1 - x0) / 2.0, (y1 - y0) / 2.0
        return math.pi * (3.0 * (a + b) - math.sqrt((3.0 * a + b) * (a + 3.0 * b)))
    pts = np.asarray(points, dtype=np.float64)
    return float(np.hypot(*(np.roll(pts, -1, axis=0) - pts).T).sum())


def geometric_area(shape: str, points) -> float:
    if shape in ("rectangle", "ellipse"):
        x0, y0, x1, y1 = _box(points)
        return (x1 - x0) * (y1 - y0) * (1.0 if shape == "rectangle" else math.pi / 4.0)
    pts = np.asarray(points, dtype=np.float64)
    x, y = pts[:, 0], pts[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)


def convex_hull(pts: np.ndarray) -> np.ndarray:
    """Vertices of the convex hull, counter-clockwise (Andrew's monotone chain)."""
    p = np.unique(np.asarray(pts, dtype=np.float64), axis=0)
    if len(p) < 3:
        return p

    def turns_left(a, b, q) -> bool:
        return (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) > 0

    def half(seq: np.ndarray) -> list:
        out: list = []
        for q in seq:
            while len(out) >= 2 and not turns_left(out[-2], out[-1], q):
                out.pop()
            out.append(q)
        return out

    lower, upper = half(p), half(p[::-1])
    return np.array(lower[:-1] + upper[:-1])


def solidity(shape: str, points) -> float:
    """Area over the area of the convex hull (1 for convex shapes)."""
    if shape in ("rectangle", "ellipse"):
        return 1.0
    hull = convex_hull(np.asarray(points, dtype=np.float64))
    hull_area = geometric_area("polygon", hull) if len(hull) >= 3 else 0.0
    return geometric_area(shape, points) / hull_area if hull_area > 0 else 1.0


def feret(shape: str, points) -> tuple[float, float, float]:
    """Maximum caliper diameter, its angle (ImageJ convention) and the minimum caliper width."""
    if shape in ("rectangle", "ellipse"):
        x0, y0, x1, y1 = _box(points)
        w, h = x1 - x0, y1 - y0
        if shape == "ellipse":
            return (w, 0.0, h) if w >= h else (h, 90.0, w)
        return math.hypot(w, h), imagej_angle(w, -h), min(w, h)
    hull = convex_hull(np.asarray(points, dtype=np.float64))
    if len(hull) < 2:
        return 0.0, 0.0, 0.0
    n, chunk = len(hull), 256
    best, pair = 0.0, (hull[0], hull[0])
    for i in range(0, n, chunk):
        diff = hull[i:i + chunk, None, :] - hull[None, :, :]
        d = np.hypot(diff[..., 0], diff[..., 1])
        k = int(np.argmax(d))
        if d.flat[k] > best:
            a, b = divmod(k, n)
            best, pair = float(d.flat[k]), (hull[i + a], hull[b])
    (ax, ay), (bx, by) = pair
    if bx < ax:
        ax, ay, bx, by = bx, by, ax, ay
    if n < 3:
        return best, imagej_angle(bx - ax, by - ay), 0.0
    edges = np.roll(hull, -1, axis=0) - hull
    lengths = np.hypot(edges[:, 0], edges[:, 1])
    width = math.inf
    for i in range(0, n, chunk):
        e = edges[i:i + chunk]
        rel = hull[None, :, :] - hull[i:i + chunk, None, :]
        spans = np.abs(e[:, 0, None] * rel[..., 1] - e[:, 1, None] * rel[..., 0]).max(axis=1) / lengths[i:i + chunk]
        width = min(width, float(spans.min()))
    return best, imagej_angle(bx - ax, by - ay), width


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

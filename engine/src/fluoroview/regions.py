"""Region geometry in full-resolution pixel coordinates, and exact rasterization.

A pixel belongs to a region when its centre (x + 0.5, y + 0.5) lies inside the shape. Rectangles are
half-open, so adjacent rectangles never share pixels; polygons use the even-odd rule. A polygon may carry
extra closed outlines ("rings"), combined with its outline by the same even-odd rule: a ring inside the
region is a hole, a ring outside it is another part.
"""

from __future__ import annotations

import math
import uuid
from typing import Annotated, Literal

import numba as nb
import numpy as np
from pydantic import BaseModel, Field, FiniteFloat
from shapely import LineString, Polygon, unary_union
from shapely.ops import polygonize

from .projects import now_iso

Shape = Literal["rectangle", "ellipse", "polygon", "freehand"]
Point = tuple[FiniteFloat, FiniteFloat]
MAX_POINTS = 20000
"""vertices of one outline"""
Ring = Annotated[list[Point], Field(min_length=3, max_length=MAX_POINTS)]
REGION_COLOR = "#ffffff"
COLOR = r"^#[0-9a-fA-F]{6}$"
ITEM_ID = r"^[0-9a-f]{12}$"
MAX_RINGS = 10000
MAX_VERTICES = 200000
"""all outlines of one region together"""
ELLIPSE_TOLERANCE = 0.05
"""largest gap in pixels between an ellipse and the polygon standing in for it"""


class RegionIn(BaseModel):
    shape: Shape
    points: list[Point] = Field(min_length=2, max_length=20000)
    rings: list[Ring] = Field(default_factory=list, max_length=MAX_RINGS)
    name: str | None = Field(default=None, max_length=200)
    color: str | None = Field(default=None, pattern=COLOR)
    author: str | None = Field(default=None, max_length=200)


class RegionPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    points: list[Point] | None = Field(default=None, min_length=2, max_length=20000)
    rings: list[Ring] | None = Field(default=None, max_length=MAX_RINGS)
    """replaces the region's rings when given (moving a region moves its rings too)"""
    color: str | None = Field(default=None, pattern=COLOR)


class RegionRestore(BaseModel):
    """A region exactly as it was (same id), to undo a deletion or load a saved session."""

    id: str = Field(pattern=ITEM_ID)
    name: str = Field(min_length=1, max_length=200)
    shape: Shape
    points: list[Point] = Field(min_length=2, max_length=20000)
    rings: list[Ring] = Field(default_factory=list, max_length=MAX_RINGS)
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


class CounterIn(BaseModel):
    """A Cell Counter category, such as CD8+."""

    name: str = Field(min_length=1, max_length=100)
    color: str = Field(pattern=COLOR)


class CounterPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    color: str | None = Field(default=None, pattern=COLOR)


class Counter(CounterIn):
    id: str = Field(pattern=ITEM_ID)


class PointIn(BaseModel):
    x: FiniteFloat
    y: FiniteFloat
    counter: str = Field(pattern=ITEM_ID)


class PointPatch(BaseModel):
    x: FiniteFloat | None = None
    y: FiniteFloat | None = None
    counter: str | None = Field(default=None, pattern=ITEM_ID)


class CountPoint(PointIn):
    id: str = Field(pattern=ITEM_ID)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def new_annotation(req: AnnotationIn) -> dict:
    stamp = now_iso()
    return {"id": uuid.uuid4().hex[:12], "x": req.x, "y": req.y, "text": req.text.strip(), "author": req.author,
            "region_id": req.region_id, "created": stamp, "modified": stamp, "replies": []}


def new_reply(req: ReplyIn) -> dict:
    return {"id": uuid.uuid4().hex[:12], "text": req.text.strip(), "author": req.author, "created": now_iso()}


def validate_shape(shape: str, points, rings=()) -> None:
    if shape in ("rectangle", "ellipse"):
        if len(points) != 2:
            raise ValueError(f"a {shape} is given by two opposite corners")
        (xa, ya), (xb, yb) = points
        if xa == xb or ya == yb:
            raise ValueError(f"the {shape} has no area")
        if rings:
            raise ValueError(f"a {shape} cannot have holes or extra parts")
    elif len(points) < 3:
        raise ValueError("a polygon needs at least three points")
    if len(points) + sum(len(r) for r in rings) > MAX_VERTICES:
        raise ValueError(f"a region can have at most {MAX_VERTICES:,} vertices in all")


def as_lists(points) -> list[list[float]]:
    return [[float(x), float(y)] for x, y in points]


def with_rings(region: dict, rings) -> dict:
    """Set a region's rings; a region without rings has no "rings" key, as before rings existed."""
    if rings:
        region["rings"] = [as_lists(r) for r in rings]
    else:
        region.pop("rings", None)
    return region


def rings_of(region: dict) -> list:
    return region.get("rings") or []


def region_record(r: RegionRestore) -> dict:
    """A restored region as stored in the project."""
    region = r.model_dump()
    region["points"] = as_lists(r.points)
    return with_rings(region, r.rings)


def new_region(req: RegionIn, index: int) -> dict:
    validate_shape(req.shape, req.points, req.rings)
    stamp = now_iso()
    return with_rings({
        "id": uuid.uuid4().hex[:12],
        "name": req.name or f"Region {index}",
        "shape": req.shape,
        "points": as_lists(req.points),
        "color": req.color or REGION_COLOR,
        "created": stamp,
        "modified": stamp,
        "author": req.author,
    }, req.rings)


def imagej_angle(dx: float, dy: float) -> float:
    """Direction of (dx, dy) in image coordinates (y down) as ImageJ reports it: degrees 0–180, y up."""
    return math.degrees(math.atan2(-dy, dx)) % 180.0


def _box(points) -> tuple[float, float, float, float]:
    (xa, ya), (xb, yb) = points
    return min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb)


def _ring_length(points) -> float:
    pts = np.asarray(points, dtype=np.float64)
    return float(np.hypot(*(np.roll(pts, -1, axis=0) - pts).T).sum())


def _vertices(points, rings) -> np.ndarray:
    """Every vertex of the outline and its rings."""
    return np.concatenate([np.asarray(points, dtype=np.float64).reshape(-1, 2),
                           *(np.asarray(r, dtype=np.float64).reshape(-1, 2) for r in rings)])


def perimeter(shape: str, points, rings=()) -> float:
    """Length of every outline: exact for rectangles and polygons, Ramanujan's approximation for ellipses."""
    if shape in ("rectangle", "ellipse"):
        x0, y0, x1, y1 = _box(points)
        if shape == "rectangle":
            return 2.0 * ((x1 - x0) + (y1 - y0))
        a, b = (x1 - x0) / 2.0, (y1 - y0) / 2.0
        return math.pi * (3.0 * (a + b) - math.sqrt((3.0 * a + b) * (a + 3.0 * b)))
    return _ring_length(points) + sum(_ring_length(r) for r in rings)


def geometric_area(shape: str, points, rings=()) -> float:
    if shape in ("rectangle", "ellipse"):
        x0, y0, x1, y1 = _box(points)
        return (x1 - x0) * (y1 - y0) * (1.0 if shape == "rectangle" else math.pi / 4.0)
    if rings:
        return float(to_geometry(shape, points, rings).area)
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


def solidity(shape: str, points, rings=()) -> float:
    """Area over the area of the convex hull (1 for convex shapes)."""
    if shape in ("rectangle", "ellipse"):
        return 1.0
    hull = convex_hull(_vertices(points, rings))
    hull_area = geometric_area("polygon", hull) if len(hull) >= 3 else 0.0
    return geometric_area(shape, points, rings) / hull_area if hull_area > 0 else 1.0


def feret(shape: str, points, rings=()) -> tuple[float, float, float]:
    """Maximum caliper diameter, its angle (ImageJ convention) and the minimum caliper width."""
    if shape in ("rectangle", "ellipse"):
        x0, y0, x1, y1 = _box(points)
        w, h = x1 - x0, y1 - y0
        if shape == "ellipse":
            return (w, 0.0, h) if w >= h else (h, 90.0, w)
        return math.hypot(w, h), imagej_angle(w, -h), min(w, h)
    hull = convex_hull(_vertices(points, rings))
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


def _even_odd(points, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float64)
    inside = np.zeros(xs.shape, dtype=np.bool_)
    for (xa, ya), (xb, yb) in zip(pts, np.roll(pts, -1, axis=0), strict=True):
        spans = ((ya <= ys) & (ys < yb)) | ((yb <= ys) & (ys < ya))
        if not spans.any():
            continue
        with np.errstate(divide="ignore", invalid="ignore"):
            cross = xa + (ys - ya) * (xb - xa) / (yb - ya)
        inside ^= spans & (cross <= xs)
    return inside


def contains_points(shape: str, points, xs: np.ndarray, ys: np.ndarray, rings=()) -> np.ndarray:
    """Which of the points lie inside the region, by the same rules as `mask` (half-open, even-odd)."""
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)
    if shape in ("rectangle", "ellipse"):
        x0, y0, x1, y1 = _box(points)
        if shape == "rectangle":
            inside = (xs >= x0) & (xs < x1) & (ys >= y0) & (ys < y1)
        else:
            rx, ry = (x1 - x0) / 2.0, (y1 - y0) / 2.0
            inside = ((xs - x0 - rx) / rx) ** 2 + ((ys - y0 - ry) / ry) ** 2 <= 1.0
    else:
        inside = _even_odd(points, xs, ys)
    for ring in rings:
        inside ^= _even_odd(ring, xs, ys)
    return inside


def pixel_count(shape: str, points, width: int, height: int, *, rings=(), band: int = 512) -> int:
    """Pixels whose centres are inside the region (its area in pixels), without reading any image data."""
    box = bounds(shape, points, width, height, rings)
    if box is None:
        return 0
    x0, y0, x1, y1 = box
    return sum(int(mask(shape, points, x0, y, x1 - x0, min(band, y1 - y), rings).sum())
               for y in range(y0, y1, band))


def band_moments(inside: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> tuple[int, float, float, float, float, float]:
    """Count and raw moment sums (x, y, xx, yy, xy) of the True pixels of a mask band; `xs`/`ys` are the
    pixel-centre coordinates of its columns and rows."""
    rows = inside.sum(axis=1)
    cols = inside.sum(axis=0)
    return (int(rows.sum()), float((xs * cols).sum()), float((ys * rows).sum()), float((xs**2 * cols).sum()),
            float((ys**2 * rows).sum()), float(ys @ (inside.astype(np.float64) @ xs)))


def mask_moments(shape: str, points, width: int, height: int, *, rings=(),
                 band: int = 512) -> tuple[int, float, float, float, float, float] | None:
    """Pixel count, centroid and second central moment sums (xx, yy, xy) of the pixels inside the region."""
    box = bounds(shape, points, width, height, rings)
    if box is None:
        return None
    x0, y0, x1, y1 = box
    xs = np.arange(x1 - x0) + 0.5  # relative to the box, for precise moments
    total = np.zeros(6)
    for ya in range(y0, y1, band):
        yb = min(y1, ya + band)
        inside = mask(shape, points, x0, ya, x1 - x0, yb - ya, rings)
        total += band_moments(inside, xs, ya - y0 + np.arange(yb - ya) + 0.5)
    n, sx, sy, sxx, syy, sxy = total
    if n == 0:
        return None
    mx, my = sx / n, sy / n
    return int(n), x0 + mx, y0 + my, sxx - n * mx * mx, syy - n * my * my, sxy - n * mx * my


def bounds(shape: str, points, width: int, height: int, rings=()) -> tuple[int, int, int, int] | None:
    """Integer pixel box [x0, x1) x [y0, y1) that holds every included pixel, clipped to the image."""
    pts = _vertices(points, rings)
    xmin, ymin = pts.min(axis=0)
    xmax, ymax = pts.max(axis=0)
    x0 = max(0, math.floor(xmin))
    y0 = max(0, math.floor(ymin))
    x1 = min(width, math.ceil(xmax))
    y1 = min(height, math.ceil(ymax))
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def mask(shape: str, points, x0: int, y0: int, w: int, h: int, rings=()) -> np.ndarray:
    """Boolean mask of the pixels in [x0, x0+w) x [y0, y0+h) whose centres are inside the region."""
    if shape not in ("rectangle", "ellipse"):
        return _outlines_mask([points, *rings], x0, y0, w, h)
    (xa, ya), (xb, yb) = np.asarray(points, dtype=np.float64)
    cx = x0 + np.arange(w) + 0.5
    cy = y0 + np.arange(h) + 0.5
    if shape == "rectangle":
        inx = (cx >= min(xa, xb)) & (cx < max(xa, xb))
        iny = (cy >= min(ya, yb)) & (cy < max(ya, yb))
        out = iny[:, None] & inx[None, :]
    else:
        ex, ey = (xa + xb) / 2, (ya + yb) / 2
        rx, ry = abs(xb - xa) / 2, abs(yb - ya) / 2
        out = ((cx[None, :] - ex) / rx) ** 2 + ((cy[:, None] - ey) / ry) ** 2 <= 1.0
    return out ^ _outlines_mask(rings, x0, y0, w, h) if rings else out


def _outlines_mask(outlines, x0: int, y0: int, w: int, h: int) -> np.ndarray:
    arrays = [np.asarray(o, dtype=np.float64).reshape(-1, 2) for o in outlines]
    pts = np.concatenate(arrays)
    ends = np.cumsum([len(a) for a in arrays]).astype(np.int64)
    out = np.zeros((h, w), dtype=np.bool_)
    _fill_outlines(np.ascontiguousarray(pts[:, 0]), np.ascontiguousarray(pts[:, 1]), ends, float(x0), float(y0), out)
    return out


@nb.njit(nogil=True, cache=True)
def _fill_outlines(xs, ys, ends, x0, y0, out):
    """Even-odd scanline fill of closed outlines; outline i holds the vertices ends[i-1] .. ends[i] - 1."""
    h, w = out.shape
    cross = np.empty(xs.shape[0], np.float64)
    for r in range(h):
        y = y0 + r + 0.5
        k = 0
        start = 0
        for e in ends:
            for i in range(start, e):
                j = i + 1 if i + 1 < e else start
                ya, yb = ys[i], ys[j]
                if (ya <= y < yb) or (yb <= y < ya):
                    cross[k] = xs[i] + (y - ya) * (xs[j] - xs[i]) / (yb - ya)
                    k += 1
            start = e
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


# ---- shapely ---------------------------------------------------------------------------------------

MIN_PART_AREA = 0.01
"""parts and holes smaller than this (px²) are slivers left by boolean operations"""


def ellipse_points(cx: float, cy: float, a: float, b: float, theta: float = 0.0) -> np.ndarray:
    """Vertices on an ellipse with semi-axes a (along direction theta, radians, y down) and b, close enough
    that the polygon stays within ELLIPSE_TOLERANCE of the curve."""
    n = int(min(4096, max(32, math.ceil(math.pi * math.sqrt(max(a, b) / (2 * ELLIPSE_TOLERANCE))))))
    t = np.arange(n) * (2.0 * math.pi / n)
    ex, ey = a * np.cos(t), b * np.sin(t)
    c, s = math.cos(theta), math.sin(theta)
    return np.column_stack([cx + ex * c - ey * s, cy + ex * s + ey * c])


def outline_vertices(shape: str, points) -> np.ndarray:
    """The outline as a closed polygon; an ellipse becomes a fine polygon."""
    if shape in ("rectangle", "ellipse"):
        x0, y0, x1, y1 = _box(points)
        if shape == "rectangle":
            return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float64)
        return ellipse_points((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2)
    return np.asarray(points, dtype=np.float64)


def to_geometry(shape: str, points, rings=()):
    """The region as a valid shapely geometry, by the same even-odd rule as `mask`."""
    outlines = [outline_vertices(shape, points), *(np.asarray(r, dtype=np.float64) for r in rings)]
    if len(outlines) == 1:
        simple = Polygon(outlines[0])
        if simple.is_valid:
            return simple
    linework = unary_union([LineString(np.vstack([o, o[:1]])) for o in outlines])
    faces = list(polygonize(getattr(linework, "geoms", [linework])))
    if not faces:
        return Polygon()
    probe = np.array([f.representative_point().coords[0] for f in faces])
    inside = np.zeros(len(faces), dtype=np.bool_)
    for o in outlines:
        inside ^= _even_odd(o, probe[:, 0], probe[:, 1])
    return unary_union([f for f, keep in zip(faces, inside, strict=True) if keep])


def region_geometry(region: dict):
    return to_geometry(region["shape"], region["points"], rings_of(region))


def _polygons(geom) -> list[Polygon]:
    if isinstance(geom, Polygon):
        return [] if geom.is_empty else [geom]
    return [p for part in getattr(geom, "geoms", ()) for p in _polygons(part)]


def _ring_list(coords, digits: int) -> list[list[float]] | None:
    pts = np.round(np.asarray(coords, dtype=np.float64)[:-1], digits)
    pts = pts[np.any(pts != np.roll(pts, 1, axis=0), axis=1)]
    return pts.tolist() if len(pts) >= 3 else None


def from_geometry(geom, digits: int = 2) -> tuple[list, list] | None:
    """Outline and rings of a shapely (multi)polygon: the largest part's outline, then its holes and the
    other parts with their holes. None when nothing with an area is left."""
    parts = sorted((p for p in _polygons(geom) if p.area >= MIN_PART_AREA), key=lambda p: p.area, reverse=True)
    outlines = [ring for p in parts
                for ring in (p.exterior, *(i for i in p.interiors if Polygon(i).area >= MIN_PART_AREA))]
    lists = [r for r in (_ring_list(o.coords, digits) for o in outlines) if r is not None]
    if not lists:
        return None
    return lists[0], lists[1:]

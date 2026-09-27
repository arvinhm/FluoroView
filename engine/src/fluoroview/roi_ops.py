"""Operations on regions, as in ImageJ's ROI Manager and Edit › Selection: union, intersect, XOR and
subtract of several regions; enlarge or shrink, convex hull and fit ellipse of one. Each gives a new
region as {shape, points, rings}; the regions it came from are left as they are."""

from __future__ import annotations

import math
from functools import reduce
from typing import Literal, assert_never

import numpy as np
from shapely import unary_union

from .measure import fitted_ellipse
from .regions import (
    ELLIPSE_TOLERANCE,
    MAX_POINTS,
    MAX_RINGS,
    MAX_VERTICES,
    ellipse_points,
    from_geometry,
    mask_moments,
    region_geometry,
    rings_of,
)

Combine = Literal["union", "intersect", "xor", "subtract"]
SYMBOLS: dict[str, str] = {"union": "∪", "intersect": "∩", "xor": "⊕", "subtract": "−"}
EMPTY: dict[str, str] = {
    "union": "The regions have no area.",
    "intersect": "The regions do not overlap.",
    "xor": "The regions cancel each other out.",
    "subtract": "Nothing is left after subtracting.",
}
SIMPLIFY_STEPS = (0.0, 0.05, 0.1, 0.25, 0.5, 1.0)
"""px; a result is simplified, by as little as needed, only when it has too many vertices to keep"""


class OperationError(ValueError):
    """The operation leaves no region (nothing left, or too complex to keep)."""


def polygon_result(geom, empty: str) -> dict:
    for tol in SIMPLIFY_STEPS:
        out = from_geometry(geom.simplify(tol, preserve_topology=True) if tol else geom)
        if out is None:
            raise OperationError(empty)
        points, rings = out
        sizes = [len(points), *map(len, rings)]
        if max(sizes) <= MAX_POINTS and sum(sizes) <= MAX_VERTICES and len(rings) <= MAX_RINGS:
            return {"shape": "polygon", "points": points, "rings": rings}
    raise OperationError("The result is too complex to keep as one region.")


def combine(op: Combine, regions: list[dict]) -> dict:
    """Union, intersection, XOR (pixels in an odd number of the regions), or the first region minus the others."""
    geoms = [region_geometry(r) for r in regions]
    match op:
        case "union":
            geom = unary_union(geoms)
        case "intersect":
            geom = reduce(lambda a, b: a.intersection(b), geoms)
        case "xor":
            geom = reduce(lambda a, b: a.symmetric_difference(b), geoms)
        case "subtract":
            geom = geoms[0].difference(unary_union(geoms[1:]))
        case _:
            assert_never(op)
    return polygon_result(geom, EMPTY[op])


def combined_name(op: Combine, names: list[str]) -> str:
    sign = f" {SYMBOLS[op]} "
    name = sign.join(names[:3]) + (f"{sign}{len(names) - 3} more" if len(names) > 3 else "")
    return name[:200]


def _half_up(v: float) -> int:
    return math.floor(v + 0.5)


def arc_segments(radius: float) -> int:
    """Segments per quarter circle that keep an arc of this radius within ELLIPSE_TOLERANCE of the curve."""
    r = abs(radius)
    if r <= ELLIPSE_TOLERANCE:
        return 8
    return min(256, max(8, math.ceil((math.pi / 2) / math.acos(1 - ELLIPSE_TOLERANCE / r))))


def enlarge(region: dict, distance: float) -> dict:
    """Grow (distance > 0, px) or shrink the region. Rectangles and ellipses keep their shape, on whole
    pixels, as in ImageJ; other shapes are offset with round corners."""
    shape = region["shape"]
    if shape in ("rectangle", "ellipse"):
        (xa, ya), (xb, yb) = region["points"]
        x0, y0 = _half_up(min(xa, xb) - distance), _half_up(min(ya, yb) - distance)
        x1, y1 = _half_up(max(xa, xb) + distance), _half_up(max(ya, yb) + distance)
        if x1 <= x0 or y1 <= y0:
            raise OperationError("Nothing is left after shrinking.")
        return {"shape": shape, "points": [[x0, y0], [x1, y1]], "rings": []}
    geom = region_geometry(region).buffer(distance, quad_segs=arc_segments(distance), join_style="round")
    return polygon_result(geom, "Nothing is left after shrinking.")


def hull(region: dict) -> dict:
    return polygon_result(region_geometry(region).convex_hull, "The region has no area.")


def fit_ellipse(region: dict, width: int, height: int) -> dict:
    """ImageJ's Fit Ellipse: the ellipse with the pixels' area, centroid and second moments."""
    moments = mask_moments(region["shape"], region["points"], width, height, rings=rings_of(region))
    if moments is None:
        raise OperationError("The region holds no pixels of the image.")
    n, cx, cy, sxx, syy, sxy = moments
    major, minor, _ = fitted_ellipse(n, sxx, syy, sxy)
    if minor <= 0:
        raise OperationError("The region is too thin to fit an ellipse.")
    theta = 0.5 * math.atan2(2.0 * sxy, sxx - syy)
    points = np.round(ellipse_points(cx, cy, major / 2, minor / 2, theta), 2)
    return {"shape": "polygon", "points": points.tolist(), "rings": []}

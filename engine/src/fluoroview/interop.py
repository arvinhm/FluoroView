"""Regions to and from ImageJ (.roi and RoiSet.zip, through roifile) and QuPath (GeoJSON).

Both use full-resolution pixel coordinates with (0, 0) at the top-left corner of the image, as regions
do. Regions with holes or several parts become ImageJ composite (shape) ROIs and GeoJSON MultiPolygons,
and come back the same way. Lines, points, text and QuPath detections are not regions: an import
leaves them out and says how many.
"""

from __future__ import annotations

import io
import json
import math
import re
import struct
import uuid
import zipfile
from collections import Counter
from dataclasses import dataclass, field

import numpy as np
from roifile import ROI_OPTIONS, ROI_SUBTYPE, ROI_TYPE, ImagejRoi
from shapely import MultiPolygon, box, make_valid, unary_union
from shapely.geometry import mapping, shape
from shapely.geometry.polygon import orient

from .regions import (
    COLOR,
    MAX_POINTS,
    MAX_RINGS,
    MAX_VERTICES,
    outline_vertices,
    polygons_of,
    region_geometry,
    rings_of,
    to_geometry,
)
from .roi_ops import OperationError, arc_segments, polygon_result

MAX_IMPORT_REGIONS = 5000
MAX_UNZIPPED = 256 << 20
INT_RANGE = (-5000, 60535)
"""box coordinates an ImageJ .roi stores as 16-bit integers"""
LINES = {ROI_TYPE.LINE, ROI_TYPE.FREELINE, ROI_TYPE.POLYLINE, ROI_TYPE.ANGLE}


class InteropError(ValueError):
    """The file cannot be read as regions."""


@dataclass
class Imported:
    regions: list[dict] = field(default_factory=list)
    """{shape, points, rings, name, color}; name and color may be None"""
    skipped: Counter = field(default_factory=Counter)
    """what was left out (lines, points, text, images, detections, empty, damaged) and how many"""


def _rgb(color: str) -> list[int]:
    return [int(color[i:i + 2], 16) for i in (1, 3, 5)]


def _hex(value) -> str | None:
    """#rrggbb from [r, g, b] or a packed (A)RGB integer, as QuPath writes colours."""
    if isinstance(value, list | tuple) and len(value) >= 3 and all(isinstance(v, int | float) for v in value[:3]):
        r, g, b = (max(0, min(255, int(v))) for v in value[:3])
    elif isinstance(value, int) and not isinstance(value, bool):
        r, g, b = (value >> 16) & 255, (value >> 8) & 255, value & 255
    else:
        return None
    return f"#{r:02x}{g:02x}{b:02x}"


def _box(points) -> tuple[float, float, float, float]:
    xy = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    return float(xy[:, 0].min()), float(xy[:, 1].min()), float(xy[:, 0].max()), float(xy[:, 1].max())


def _fits(*values: float) -> bool:
    return all(INT_RANGE[0] <= v <= INT_RANGE[1] for v in values)


def _parts(region: dict) -> list:
    """The region's polygons, largest first, outlines counter-clockwise and holes clockwise."""
    return [orient(p, 1.0) for p in sorted(polygons_of(region_geometry(region)), key=lambda p: p.area, reverse=True)]


# ---- ImageJ ----------------------------------------------------------------------------------------

def to_imagej(region: dict) -> ImagejRoi:
    """One region as an ImageJ ROI: rectangle, oval, polygon or freehand, or a composite ROI when the
    region has holes or several parts."""
    shape_, points, rings = region["shape"], region["points"], rings_of(region)
    x0, y0, x1, y1 = _box([*points, *(p for r in rings for p in r)])
    if rings:
        roi = _composite(region)
    elif shape_ in ("rectangle", "ellipse") and _fits(x0, y0, x1, y1):
        roi = ImagejRoi()
        roi.roitype = ROI_TYPE.RECT if shape_ == "rectangle" else ROI_TYPE.OVAL
        if not all(float(v).is_integer() for v in (x0, y0, x1, y1)):
            roi.options |= ROI_OPTIONS.SUB_PIXEL_RESOLUTION
            roi.xd, roi.yd, roi.widthd, roi.heightd = x0, y0, x1 - x0, y1 - y0
    else:
        roi = ImagejRoi.frompoints(outline_vertices(shape_, points).astype(np.float64))
        roi.roitype = ROI_TYPE.FREEHAND if shape_ in ("freehand", "ellipse") else ROI_TYPE.POLYGON
    if roi.roitype in (ROI_TYPE.RECT, ROI_TYPE.OVAL):
        roi.left, roi.top, roi.right, roi.bottom = math.floor(x0), math.floor(y0), math.ceil(x1), math.ceil(y1)
    roi.name = region["name"]
    roi.stroke_color = bytes([255, *_rgb(region["color"])])
    return roi


def _composite(region: dict) -> ImagejRoi:
    """Closed sub-paths in image coordinates; outer outlines and holes wind opposite ways, so ImageJ reads
    the same area whichever fill rule it applies."""
    path: list[float] = []
    for poly in _parts(region):
        for ring in (poly.exterior, *poly.interiors):
            xy = np.asarray(ring.coords)[:-1]
            path += [0.0, *xy[0]]
            for x, y in xy[1:]:
                path += [1.0, x, y]
            path.append(4.0)
    roi = ImagejRoi()
    roi.roitype = ROI_TYPE.RECT
    roi.multi_coordinates = np.asarray(path, dtype=np.float32)
    roi.shape_roi_size = len(path)
    return roi


def roiset_bytes(regions: list[dict]) -> bytes:
    """A RoiSet.zip for ImageJ's ROI Manager, one .roi per region named after it."""
    buf = io.BytesIO()
    taken: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for region in regions:
            stem = re.sub(r"[^\w.\- ]+", "_", region["name"]).strip() or "region"
            member, k = f"{stem}.roi", 2
            while member in taken:
                member, k = f"{stem}-{k}.roi", k + 1
            taken.add(member)
            z.writestr(member, to_imagej(region).tobytes())
    return buf.getvalue()


def _closed(xy) -> np.ndarray:
    xy = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
    return xy[:-1] if len(xy) > 1 and np.array_equal(xy[0], xy[-1]) else xy


def _bezier(ctrl: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Points along a quadratic or cubic Bézier curve, about every 2 px, the start point left out."""
    p = np.asarray(ctrl, dtype=np.float64)
    steps = max(4, min(64, math.ceil(float(np.hypot(*np.diff(p, axis=0).T).sum()) / 2)))
    t = np.linspace(0.0, 1.0, steps + 1)[1:, None]
    d = len(p) - 1
    curve = sum(math.comb(d, i) * (1 - t) ** (d - i) * t**i * p[i] for i in range(d + 1))
    return [tuple(q) for q in curve]


def _path_outlines(path: np.ndarray) -> list[np.ndarray]:
    """Closed outlines of an ImageJ composite ROI: Java path segments (0 move, 1 line, 2 quadratic,
    3 cubic, 4 close), curves flattened."""
    values = np.asarray(path, dtype=np.float64).tolist()
    outlines: list[np.ndarray] = []
    current: list[tuple[float, float]] = []

    def flush() -> None:
        if len(current) >= 3:
            outlines.append(_closed(current))

    n = 0
    while n < len(values):
        op = int(values[n])
        if op == 0:
            flush()
            current = [(values[n + 1], values[n + 2])]
            n += 3
        elif op == 1:
            current.append((values[n + 1], values[n + 2]))
            n += 3
        elif op in (2, 3):
            ends = values[n + 1:n + 1 + 2 * op]
            current.extend(_bezier([current[-1], *zip(ends[0::2], ends[1::2], strict=True)]))
            n += 1 + 2 * op
        elif op == 4:
            flush()
            current = []
            n += 1
        else:
            raise ValueError(f"unknown path segment {op}")
    flush()
    return outlines


def _shoelace(xy: np.ndarray) -> float:
    x, y = xy[:, 0], xy[:, 1]
    return abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2.0


def _outlines(outlines: list[np.ndarray], shape_: str) -> dict:
    """The largest outline, the others as rings; simplified by at most 1 px only when there are too many
    vertices to keep."""
    outlines = sorted((o for o in outlines if len(o) >= 3), key=_shoelace, reverse=True)
    if not outlines:
        raise OperationError("the ROI has no area")
    sizes = [len(o) for o in outlines]
    if max(sizes) <= MAX_POINTS and sum(sizes) <= MAX_VERTICES and len(outlines) - 1 <= MAX_RINGS:
        return {"shape": shape_ if len(outlines) == 1 else "polygon", "points": outlines[0].tolist(),
                "rings": [o.tolist() for o in outlines[1:]]}
    return polygon_result(to_geometry("polygon", outlines[0], outlines[1:]), "the ROI has no area")


def from_imagej(roi: ImagejRoi) -> dict | str:
    """A region {shape, points, rings}, or the kind of ROI it is when it is not an area."""
    t = roi.roitype
    if roi.subtype == ROI_SUBTYPE.TEXT:
        return "text"
    if roi.subtype == ROI_SUBTYPE.IMAGE:
        return "images"
    if roi.composite:
        return _outlines(_path_outlines(roi.multi_coordinates), "polygon")
    if t in (ROI_TYPE.RECT, ROI_TYPE.OVAL):
        if roi.subpixelrect:
            x0, y0, x1, y1 = roi.xd, roi.yd, roi.xd + roi.widthd, roi.yd + roi.heightd
        else:
            x0, y0, x1, y1 = roi.left, roi.top, roi.right, roi.bottom
        if t == ROI_TYPE.RECT and roi.rounded_rect_arc_size > 0:
            r = min(roi.rounded_rect_arc_size / 2, (x1 - x0) / 2, (y1 - y0) / 2)
            rounded = box(x0, y0, x1, y1).buffer(-r, join_style="mitre").buffer(r, quad_segs=arc_segments(r))
            return polygon_result(rounded, "the ROI has no area")
        return {"shape": "rectangle" if t == ROI_TYPE.RECT else "ellipse", "points": [[x0, y0], [x1, y1]], "rings": []}
    if t in (ROI_TYPE.POLYGON, ROI_TYPE.FREEHAND, ROI_TYPE.TRACED):
        plain = t == ROI_TYPE.FREEHAND and roi.subtype not in (ROI_SUBTYPE.ELLIPSE, ROI_SUBTYPE.ROTATED_RECT)
        return _outlines([_closed(roi.coordinates())], "freehand" if plain else "polygon")
    if t in LINES:
        return "lines"
    if t == ROI_TYPE.POINT:
        return "points"
    return "other"


def _rois(data: bytes) -> list[ImagejRoi]:
    if data[:4] == b"Iout":
        return [ImagejRoi.frombytes(data)]
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise InteropError("This is neither an ImageJ .roi nor a RoiSet.zip.") from None
    with z:
        members = [i for i in z.infolist() if i.filename.lower().endswith(".roi") and not i.is_dir()]
        if sum(i.file_size for i in members) > MAX_UNZIPPED:
            raise InteropError("The RoiSet is too large to import.")
        return [ImagejRoi.frombytes(z.read(i)) for i in members]


def _from_imagej(data: bytes) -> Imported:
    out = Imported()
    try:
        rois = _rois(data)
    except InteropError:
        raise
    except (struct.error, ValueError, IndexError):
        raise InteropError("The ROI file is damaged.") from None
    for roi in rois:
        try:
            got = from_imagej(roi)
        except OperationError:
            out.skipped["empty"] += 1
            continue
        except (struct.error, ValueError, IndexError, RuntimeError):
            out.skipped["damaged"] += 1
            continue
        if isinstance(got, str):
            out.skipped[got] += 1
            continue
        color = roi.hexcolor(roi.stroke_color)
        out.regions.append({**got, "name": roi.name or None,
                            "color": color if color and re.fullmatch(COLOR, color) else None})
    return out


# ---- QuPath GeoJSON --------------------------------------------------------------------------------

def geojson_text(regions: list[dict]) -> str:
    """A FeatureCollection with one QuPath annotation per region (ellipses as fine polygons)."""
    features = []
    for region in regions:
        polys = _parts(region)
        if not polys:
            continue
        geom = polys[0] if len(polys) == 1 else MultiPolygon(polys)
        features.append({
            "type": "Feature",
            "id": str(uuid.uuid4()),
            "geometry": mapping(geom),
            "properties": {"objectType": "annotation", "name": region["name"], "color": _rgb(region["color"]),
                           "isLocked": False},
        })
    return json.dumps({"type": "FeatureCollection", "features": features}, allow_nan=False)


def _features(obj) -> list[dict]:
    if isinstance(obj, list):
        return [f for item in obj for f in _features(item)]
    if not isinstance(obj, dict):
        return []
    if obj.get("type") == "FeatureCollection":
        return _features(obj.get("features") or [])
    if obj.get("type") == "Feature":
        return [obj]
    if "coordinates" in obj or obj.get("type") == "GeometryCollection":
        return [{"type": "Feature", "geometry": obj, "properties": {}}]
    return []


def _from_geojson(data: bytes) -> Imported:
    try:
        obj = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise InteropError("This is not a GeoJSON file.") from None
    features = _features(obj)
    if not features:
        raise InteropError("The GeoJSON has no features.")
    out = Imported()
    for f in features:
        props = f.get("properties") if isinstance(f.get("properties"), dict) else {}
        if props.get("objectType") in ("detection", "cell", "tile"):
            out.skipped["detections"] += 1
            continue
        try:
            geom = shape(f.get("geometry"))
        except (AttributeError, TypeError, ValueError, KeyError, IndexError):
            out.skipped["damaged"] += 1
            continue
        polys = polygons_of(geom)
        if not polys:
            out.skipped["points" if "Point" in geom.geom_type else "lines"] += 1
            continue
        if not geom.is_valid:
            geom = unary_union([make_valid(p) for p in polys])
        try:
            region = polygon_result(geom, "the annotation has no area")
        except OperationError:
            out.skipped["empty"] += 1
            continue
        klass = props.get("classification") if isinstance(props.get("classification"), dict) else {}
        name = props.get("name") or klass.get("name")
        out.regions.append({**region, "name": str(name)[:200] if name else None,
                            "color": _hex(props.get("color")) or _hex(klass.get("color", klass.get("colorRGB")))})
    return out


def read_regions(data: bytes, filename: str) -> Imported:
    """Regions from an ImageJ .roi or RoiSet.zip, or a QuPath GeoJSON file."""
    lower = filename.lower()
    imagej = lower.endswith((".roi", ".zip"))
    if lower.endswith((".geojson", ".json")) or (not imagej and data.lstrip()[:1] in (b"{", b"[")):
        found = _from_geojson(data)
    elif imagej or data[:4] in (b"Iout", b"PK\x03\x04"):
        found = _from_imagej(data)
    else:
        raise InteropError("Choose an ImageJ .roi or RoiSet.zip, or a QuPath .geojson file.")
    if len(found.regions) > MAX_IMPORT_REGIONS:
        raise InteropError(f"The file has {len(found.regions):,} regions; at most {MAX_IMPORT_REGIONS:,} "
                           "can be imported at once.")
    return found

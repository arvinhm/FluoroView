"""FluoroView session files (.fv): everything done on one image, in one file that can be moved and shared.

A .fv is a ZIP (format "fluoroview-session", version 1):

    manifest.json     format, software, created; the image: file names, last known paths, size, channel
                      names, bit depth, pixel size and a content fingerprint
    session.json      display per channel, view, viewer options, regions + background, notes with replies,
                      line profile, export settings; "analysis" is reserved for later results
    measurements.csv  the region measurements when saved (same columns as the regions CSV)
    thumbnail.png     480-px preview of the composite, when the pyramid is built

The fingerprint hashes the image size, bit depth, channel count and 16 row segments of up to 1,024 pixels
per channel: a moved or copied scan still matches, a different image does not.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
import zipfile
from pathlib import Path
from typing import Literal

import numpy as np
from pydantic import BaseModel, Field, FiniteFloat, ValidationError

from . import __version__
from .display import DisplayChannel
from .projects import now_iso
from .regions import AnnotationRestore, Counter, CountPoint, RegionRestore, new_id, region_record, validate_shape

FORMAT = "fluoroview-session"
VERSION = 1
SUFFIX = ".fv"
SAMPLE_ROWS = 16
SEGMENT = 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_EXPORT_BYTES = 64 * 1024


class View(BaseModel):
    cx: FiniteFloat
    cy: FiniteFloat
    zoom: FiniteFloat = Field(gt=0)
    """CSS pixels per full-resolution pixel, so the view looks the same on any display"""
    gallery: bool = False


class ViewerOptions(BaseModel):
    grid: bool = True
    smooth: bool = False
    clip: bool = False
    minimap: bool = True
    hist_log: bool = True


class Line(BaseModel):
    x0: FiniteFloat
    y0: FiniteFloat
    x1: FiniteFloat
    y1: FiniteFloat


class Calibration(BaseModel):
    """A pixel size set by the user (Set Scale), which replaces the one in the file."""

    pixel_size_um: FiniteFloat = Field(gt=0, le=1e6)
    source: Literal["user"] = "user"


class Session(BaseModel):
    """Contents of session.json."""

    display: list[DisplayChannel] | None = None
    view: View | None = None
    viewer: ViewerOptions | None = None
    regions: list[RegionRestore] = Field(default_factory=list, max_length=100_000)
    background_region: str | None = None
    notes: list[AnnotationRestore] = Field(default_factory=list, max_length=100_000)
    profile_line: Line | None = None
    export: dict | None = None
    calibration: Calibration | None = None
    counters: list[Counter] = Field(default_factory=list, max_length=1000)
    points: list[CountPoint] = Field(default_factory=list, max_length=2_000_000)
    analysis: dict = Field(default_factory=dict)


class SessionError(ValueError):
    """The file is not a FluoroView session this version can read."""


def content_fingerprint(source) -> str:
    info = source.info
    dtype = np.dtype(info.dtype)
    h = hashlib.sha256(f"{info.width}x{info.height}:{dtype.name}:{len(info.channels)}".encode())
    seg = min(SEGMENT, info.width)
    for c in range(len(info.channels)):
        for k in range(SAMPLE_ROWS):
            y = min(info.height - 1, (2 * k + 1) * info.height // (2 * SAMPLE_ROWS))
            x0 = (k * 2654435761) % (info.width - seg + 1)
            h.update(np.asarray(source.read_segment(c, y, x0, x0 + seg), dtype.newbyteorder("<")).tobytes())
    return "sha256:" + h.hexdigest()


def image_manifest(ds, fingerprint: str, pixel_size: float | None) -> dict:
    info = ds.info
    paths = list(info.files) if info.files else [info.path]
    return {
        "names": [os.path.basename(p) for p in paths],
        "paths": paths,
        "width": info.width,
        "height": info.height,
        "channels": [ch.name for ch in info.channels],
        "dtype": np.dtype(info.dtype).name,
        "pixel_size_um": pixel_size,
        "fingerprint": fingerprint,
    }


def session_from_state(state: dict, **client) -> Session:
    """A session holding a scan's stored project state plus what only the studio knows (view, options)."""
    return Session(regions=[RegionRestore(**r) for r in state["regions"]], background_region=state["background_region"],
                   notes=[AnnotationRestore(**a) for a in state["annotations"]],
                   calibration=state.get("calibration"), counters=state.get("counters") or [],
                   points=state.get("points") or [], **client)


def write_session(path: Path, image: dict, session: Session, measurements_csv: str | None = None,
                  thumbnail: bytes | None = None) -> int:
    """Write the .fv atomically; returns its size in bytes."""
    manifest = {"format": FORMAT, "version": VERSION, "software": f"FluoroView {__version__}", "created": now_iso(),
                "image": image}
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("manifest.json", json.dumps(manifest, indent=1, allow_nan=False))
            z.writestr("session.json", session.model_dump_json(indent=1))
            if measurements_csv is not None:
                z.writestr("measurements.csv", measurements_csv)
            if thumbnail is not None:
                z.writestr("thumbnail.png", thumbnail, compress_type=zipfile.ZIP_STORED)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return path.stat().st_size


def _member(z: zipfile.ZipFile, name: str) -> bytes:
    try:
        info = z.getinfo(name)
    except KeyError:
        raise SessionError(f"{name} is missing from the session") from None
    if info.file_size > MAX_MEMBER_BYTES:
        raise SessionError(f"{name} is too large")
    return z.read(info)


def read_session(path: Path) -> tuple[dict, Session]:
    try:
        with zipfile.ZipFile(path) as z:
            manifest = json.loads(_member(z, "manifest.json"))
            if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
                raise SessionError("this is not a FluoroView session")
            version = manifest.get("version")
            if not isinstance(version, int) or version > VERSION:
                raise SessionError(f"this session was made by a newer FluoroView (format version {version})")
            session = Session.model_validate_json(_member(z, "session.json"))
    except zipfile.BadZipFile:
        raise SessionError("the file is damaged or is not a FluoroView session") from None
    except (json.JSONDecodeError, ValidationError) as exc:
        raise SessionError(f"the session could not be read: {exc}"[:400]) from None
    if not isinstance(manifest.get("image"), dict):
        raise SessionError("the session does not describe its image")
    for items, what in ((session.regions, "region"), (session.notes, "note"), (session.counters, "counter"),
                        (session.points, "point")):
        if len({i.id for i in items}) != len(items):
            raise SessionError(f"the session has two {what}s with the same id")
    categories = {c.id for c in session.counters}
    if any(p.counter not in categories for p in session.points):
        raise SessionError("the session has counted points without a category")
    for r in session.regions:
        try:
            validate_shape(r.shape, r.points, r.rings)
        except ValueError as exc:
            raise SessionError(f"region {r.name!r}: {exc}") from None
    return manifest, session


def read_thumbnail(path: Path) -> bytes | None:
    """The preview stored in a .fv, if it has one."""
    try:
        with zipfile.ZipFile(path) as z:
            return _member(z, "thumbnail.png") if "thumbnail.png" in z.namelist() else None
    except (zipfile.BadZipFile, SessionError):
        return None


def find_image(manifest: dict, fv_path: Path) -> list[str] | None:
    """The image files at their last known paths, else with the same names next to the .fv."""
    image = manifest["image"]
    paths = [p for p in image.get("paths", []) if isinstance(p, str)]
    if paths and all(os.path.isfile(p) for p in paths):
        return paths
    names = [n for n in image.get("names", []) if isinstance(n, str) and n and os.path.basename(n) == n]
    nearby = [str(fv_path.parent / n) for n in names]
    if nearby and all(os.path.isfile(p) for p in nearby):
        return nearby
    return None


def replace_state(state: dict, session: Session, n_channels: int) -> None:
    state["regions"] = [region_record(r) for r in session.regions]
    state["annotations"] = [n.model_dump() for n in session.notes]
    ids = {r["id"] for r in state["regions"]}
    state["background_region"] = session.background_region if session.background_region in ids else None
    if session.display and len(session.display) == n_channels:
        state["display"] = [d.model_dump() for d in session.display]
    state["calibration"] = session.calibration.model_dump() if session.calibration else None
    state["counters"] = [c.model_dump() for c in session.counters]
    state["points"] = [p.model_dump() for p in session.points]


def merge_state(state: dict, session: Session) -> None:
    """Add the session's regions, notes, categories and points; an id already in use gets a new one
    and links (notes to regions, points to categories) follow it."""
    taken = {r["id"] for r in state["regions"]}
    renamed: dict[str, str] = {}
    for r in session.regions:
        region = region_record(r)
        if region["id"] in taken:
            fresh = new_id()
            renamed[region["id"]] = fresh
            region["id"] = fresh
        taken.add(region["id"])
        state["regions"].append(region)
    note_ids = {a["id"] for a in state["annotations"]}
    for n in session.notes:
        note = n.model_dump()
        note["region_id"] = renamed.get(note["region_id"], note["region_id"]) if note["region_id"] else None
        if note["id"] in note_ids:
            note["id"] = new_id()
        note_ids.add(note["id"])
        state["annotations"].append(note)
    if state["background_region"] is None and session.background_region:
        background = renamed.get(session.background_region, session.background_region)
        if background in taken:
            state["background_region"] = background
    if not state.get("calibration") and session.calibration:
        state["calibration"] = session.calibration.model_dump()
    counters = state.setdefault("counters", [])
    used = {c["id"] for c in counters}
    recoded: dict[str, str] = {}
    for c in session.counters:
        counter = c.model_dump()
        if counter["id"] in used:
            fresh = new_id()
            recoded[counter["id"]] = fresh
            counter["id"] = fresh
        used.add(counter["id"])
        counters.append(counter)
    points = state.setdefault("points", [])
    point_ids = {p["id"] for p in points}
    for p in session.points:
        point = p.model_dump()
        point["counter"] = recoded.get(point["counter"], point["counter"])
        if point["id"] in point_ids:
            point["id"] = new_id()
        point_ids.add(point["id"])
        points.append(point)

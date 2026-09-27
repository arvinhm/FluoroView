"""Regions, background region, display settings and measurements of an open dataset."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from collections import Counter, OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Literal, assert_never

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field, FiniteFloat, ValidationError
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from ..counting import counts_csv, points_csv
from ..datasets import Dataset, NotReady, Registry
from ..display import Blend, DisplayChannel
from ..figure import Display, Plan, clip_box, encode_png, encode_tiff, plan, provenance, render_figure, write_ome
from ..interop import InteropError, geojson_text, read_regions, roiset_bytes
from ..measure import measure_region, rows_for_scan, to_csv
from ..profile import line_profile, profile_csv
from ..projects import ProjectStore, calibrated_pixel_size, now_iso
from ..regions import (
    AnnotationIn,
    AnnotationPatch,
    AnnotationRestore,
    CounterIn,
    CounterPatch,
    PointIn,
    PointPatch,
    RegionIn,
    RegionPatch,
    RegionRestore,
    ReplyIn,
    as_lists,
    new_annotation,
    new_id,
    new_region,
    new_reply,
    region_record,
    rings_of,
    validate_shape,
    with_rings,
)
from ..roi_ops import OperationError, combine, combined_name, enlarge, fit_ellipse, hull
from ..session import (
    MAX_EXPORT_BYTES,
    SUFFIX,
    Calibration,
    Line,
    SessionError,
    View,
    ViewerOptions,
    content_fingerprint,
    image_manifest,
    merge_state,
    read_session,
    replace_state,
    session_from_state,
    write_session,
)


class BackgroundIn(BaseModel):
    region_id: str | None


Box = tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat]


class FigureIn(BaseModel):
    box: Box
    """full-resolution pixels x0, y0, x1, y1"""
    display: list[DisplayChannel]
    format: Literal["png", "tiff"] = "png"
    blend: Blend = "add"
    """how visible channels combine in the composite: summed, or their maximum"""
    scale_bar: bool = True
    labels: bool = True
    regions: bool = True
    notes: bool = True
    dpi: int = Field(300, ge=72, le=2400)
    max_side: int = Field(8000, ge=256, le=16000)
    plan_only: bool = False


class CalibrationIn(BaseModel):
    pixel_size_um: FiniteFloat | None = Field(gt=0, le=1e6)
    """µm per pixel, or null to go back to the pixel size recorded in the file"""


class RawIn(BaseModel):
    box: Box
    max_side: int = Field(8000, ge=256, le=16000)
    plan_only: bool = False


class SessionSaveIn(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    """absolute path of the .fv to write"""
    overwrite: bool = False
    display: list[DisplayChannel]
    view: View
    viewer: ViewerOptions
    profile_line: Line | None = None
    export: dict | None = None


class SessionApplyIn(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    mode: Literal["replace", "merge"]


MAX_IMPORT_BYTES = 64 << 20


class RegionOpIn(BaseModel):
    op: Literal["union", "intersect", "xor", "subtract", "enlarge", "hull", "ellipse"]
    ids: list[str] = Field(min_length=1, max_length=500)
    """for subtract, the first region is the one the others are cut out of"""
    distance: FiniteFloat | None = None
    """enlarge by this much (negative: shrink)"""
    unit: Literal["px", "um"] = "px"


def _unique_name(state: dict) -> str:
    taken = {r["name"] for r in state["regions"]}
    numbers = [int(m.group(1)) for n in taken if (m := re.fullmatch(r"Region (\d+)", n))]
    k = max(numbers, default=0) + 1
    while f"Region {k}" in taken:
        k += 1
    return f"Region {k}"


def project_router(registry: Registry, projects: ProjectStore, exports_dir: Path, backups_dir: Path,
                   thumbnail_of: Callable[[Dataset], bytes | None]) -> APIRouter:
    router = APIRouter(prefix="/api/v1/datasets/{ds_id}")
    exports_dir.mkdir(parents=True, exist_ok=True)
    backups_dir.mkdir(parents=True, exist_ok=True)
    for stale in exports_dir.glob("*.tif"):
        stale.unlink(missing_ok=True)
    cache: OrderedDict[tuple, dict] = OrderedDict()
    cache_lock = threading.Lock()

    def dataset(ds_id: str) -> Dataset:
        try:
            return registry.get(ds_id)
        except KeyError:
            raise HTTPException(404, "unknown dataset") from None

    def where(ds: Dataset) -> tuple[str, str]:
        return ds.info.folder, ds.info.scan_key

    def find(state: dict, rid: str) -> dict:
        for region in state["regions"]:
            if region["id"] == rid:
                return region
        raise HTTPException(404, "unknown region")

    def file_stem(ds: Dataset) -> str:
        """Download name: the scan's file name without extension, or `<folder>_<n>ch` for combined files."""
        files = ds.info.files
        base = f"{Path(files[0]).parent.name}_{len(files)}ch" if files else Path(ds.info.path).stem
        return re.sub(r"[^\w.-]+", "_", base)

    def pixel_size_of(ds: Dataset, state: dict | None = None) -> float | None:
        """The scan's pixel size in µm: the user's calibration if set, else the file's."""
        return calibrated_pixel_size(state if state is not None else projects.scan(*where(ds)), ds.info.pixel_size_um)

    def measured(ds: Dataset, region: dict, px: float | None) -> dict:
        """Measurement of a region; cached by geometry and scale, so renaming never re-reads the pixels."""
        key = (ds.id, region["id"], region["shape"], tuple(map(tuple, region["points"])),
               tuple(tuple(map(tuple, r)) for r in rings_of(region)), px)
        with cache_lock:
            result = cache.get(key)
            if result is not None:
                cache.move_to_end(key)
        if result is None:
            try:
                result = measure_region(ds, region, px)
            except NotReady:
                raise HTTPException(409, "the image is still loading; try again in a moment") from None
            with cache_lock:
                cache[key] = result
                while len(cache) > 256:
                    cache.popitem(last=False)
        return {**result, "region": region["name"]}

    def project_view(state: dict) -> dict:
        keys = ("regions", "annotations", "background_region", "display", "calibration")
        return {**{k: state.get(k) for k in keys}, "counters": state.get("counters") or [],
                "points": state.get("points") or []}

    @router.post("/counters")
    def create_counter(ds_id: str, req: CounterIn) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            counter = {"id": new_id(), **req.model_dump()}
            state.setdefault("counters", []).append(counter)
            return counter

        return projects.update(*where(ds), change)

    def find_counter(state: dict, cid: str) -> dict:
        for c in state.get("counters") or []:
            if c["id"] == cid:
                return c
        raise HTTPException(404, "unknown counter")

    @router.patch("/counters/{cid}")
    def patch_counter(ds_id: str, cid: str, req: CounterPatch) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            counter = find_counter(state, cid)
            counter.update(req.model_dump(exclude_none=True))
            return counter

        return projects.update(*where(ds), change)

    @router.delete("/counters/{cid}")
    def delete_counter(ds_id: str, cid: str) -> dict:
        """Remove a category and every point counted in it."""
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            find_counter(state, cid)
            state["counters"] = [c for c in state["counters"] if c["id"] != cid]
            kept = [p for p in state.get("points") or [] if p["counter"] != cid]
            removed = len(state.get("points") or []) - len(kept)
            state["points"] = kept
            return {"deleted": cid, "points_deleted": removed}

        return projects.update(*where(ds), change)

    @router.post("/points")
    def create_point(ds_id: str, req: PointIn) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            find_counter(state, req.counter)
            point = {"id": new_id(), **req.model_dump()}
            state.setdefault("points", []).append(point)
            return point

        return projects.update(*where(ds), change)

    def find_point(state: dict, pid: str) -> dict:
        for p in state.get("points") or []:
            if p["id"] == pid:
                return p
        raise HTTPException(404, "unknown point")

    @router.patch("/points/{pid}")
    def patch_point(ds_id: str, pid: str, req: PointPatch) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            point = find_point(state, pid)
            if req.counter is not None:
                find_counter(state, req.counter)
            point.update(req.model_dump(exclude_none=True))
            return point

        return projects.update(*where(ds), change)

    @router.delete("/points/{pid}")
    def delete_point(ds_id: str, pid: str) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            find_point(state, pid)
            state["points"] = [p for p in state["points"] if p["id"] != pid]
            return {"deleted": pid}

        return projects.update(*where(ds), change)

    @router.get("/points.csv")
    def get_points_csv(ds_id: str) -> Response:
        ds = dataset(ds_id)
        state = projects.scan(*where(ds))
        text = points_csv(ds.info.scan_key, state, pixel_size_of(ds, state))
        return Response(text, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{file_stem(ds)}-points.csv"'})

    @router.get("/counts.csv")
    def get_counts_csv(ds_id: str) -> Response:
        ds = dataset(ds_id)
        state = projects.scan(*where(ds))
        text = counts_csv(ds.info.scan_key, state, ds.info.width, ds.info.height, pixel_size_of(ds, state))
        return Response(text, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{file_stem(ds)}-counts.csv"'})

    @router.get("/project")
    def get_project(ds_id: str) -> dict:
        return project_view(projects.scan(*where(dataset(ds_id))))

    @router.put("/calibration")
    def set_calibration(ds_id: str, req: CalibrationIn) -> dict:
        """Set Scale: a pixel size that replaces the file's everywhere, or null to go back to the file's."""
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            state["calibration"] = (Calibration(pixel_size_um=req.pixel_size_um).model_dump()
                                    if req.pixel_size_um is not None else None)
            return state

        state = projects.update(*where(ds), change)
        return {"calibration": state["calibration"], "pixel_size_um": pixel_size_of(ds, state),
                "file_pixel_size_um": ds.info.pixel_size_um}

    @router.post("/regions")
    def create_region(ds_id: str, req: RegionIn) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            try:
                region = new_region(req, 0)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
            if not req.name:
                region["name"] = _unique_name(state)
            state["regions"].append(region)
            return region

        return projects.update(*where(ds), change)

    @router.patch("/regions/{rid}")
    def patch_region(ds_id: str, rid: str, req: RegionPatch) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            region = find(state, rid)
            if req.points is not None or req.rings is not None:
                points = req.points if req.points is not None else region["points"]
                rings = req.rings if req.rings is not None else rings_of(region)
                try:
                    validate_shape(region["shape"], points, rings)
                except ValueError as exc:
                    raise HTTPException(422, str(exc)) from None
                region["points"] = as_lists(points)
                with_rings(region, rings)
            if req.name is not None and req.name.strip():
                region["name"] = req.name.strip()
            if req.color is not None:
                region["color"] = req.color
            region["modified"] = now_iso()
            return region

        return projects.update(*where(ds), change)

    @router.delete("/regions/{rid}")
    def delete_region(ds_id: str, rid: str) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            find(state, rid)
            state["regions"] = [r for r in state["regions"] if r["id"] != rid]
            if state["background_region"] == rid:
                state["background_region"] = None
            return {"deleted": rid, "background_region": state["background_region"]}

        return projects.update(*where(ds), change)

    @router.post("/regions/restore")
    def restore_region(ds_id: str, req: RegionRestore) -> dict:
        """Put back a region with its original id, so notes linked to it stay linked."""
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            if any(r["id"] == req.id for r in state["regions"]):
                raise HTTPException(409, "a region with this id already exists")
            try:
                validate_shape(req.shape, req.points, req.rings)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
            region = region_record(req)
            state["regions"].append(region)
            return region

        return projects.update(*where(ds), change)

    @router.post("/regions/op")
    def region_op(ds_id: str, req: RegionOpIn) -> dict:
        """Union, intersect, XOR or subtract (the first region minus the others) of several regions, or
        enlarge/shrink, convex hull or fit ellipse of each. The results are new regions."""
        ds = dataset(ds_id)
        state = projects.scan(*where(ds))
        sources = [find(state, rid) for rid in dict.fromkeys(req.ids)]
        try:
            results = operate(ds, state, req, sources)
        except OperationError as exc:
            raise HTTPException(422, str(exc)) from None

        def change(state: dict) -> dict:
            created = []
            for result, name, color in results:
                try:
                    region = new_region(RegionIn(**result, name=name[:200], color=color), 0)
                except ValueError as exc:
                    raise HTTPException(422, str(exc)) from None
                state["regions"].append(region)
                created.append(region)
            return {"regions": created}

        return projects.update(*where(ds), change)

    @router.get("/regions.zip")
    def export_roiset(ds_id: str) -> Response:
        """Every region as an ImageJ RoiSet.zip."""
        ds = dataset(ds_id)
        regions = projects.scan(*where(ds))["regions"]
        if not regions:
            raise HTTPException(422, "there are no regions to export")
        return Response(roiset_bytes(regions), media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{file_stem(ds)}-RoiSet.zip"'})

    @router.get("/regions.geojson")
    def export_geojson(ds_id: str) -> Response:
        """Every region as a QuPath annotation, in a GeoJSON FeatureCollection."""
        ds = dataset(ds_id)
        regions = projects.scan(*where(ds))["regions"]
        if not regions:
            raise HTTPException(422, "there are no regions to export")
        return Response(geojson_text(regions), media_type="application/geo+json",
                        headers={"Content-Disposition": f'attachment; filename="{file_stem(ds)}-regions.geojson"'})

    @router.post("/regions/import")
    async def import_regions(ds_id: str, request: Request,
                             filename: Annotated[str, Query(min_length=1, max_length=512)]) -> dict:
        """Regions from an ImageJ .roi or RoiSet.zip, or a QuPath GeoJSON file (the request body), added to
        the scan's regions."""
        ds = dataset(ds_id)
        if int(request.headers.get("content-length") or 0) > MAX_IMPORT_BYTES:
            raise HTTPException(413, "the file is too large to import")
        data = await request.body()
        if len(data) > MAX_IMPORT_BYTES:
            raise HTTPException(413, "the file is too large to import")
        return await run_in_threadpool(add_imported, ds, data, filename)

    def add_imported(ds: Dataset, data: bytes, filename: str) -> dict:
        try:
            found = read_regions(data, filename)
        except InteropError as exc:
            raise HTTPException(422, str(exc)) from None
        skipped = Counter(found.skipped)

        def change(state: dict) -> dict:
            created = []
            for item in found.regions:
                try:
                    region = new_region(RegionIn(**item), 0)
                except (ValueError, ValidationError):
                    skipped["empty"] += 1
                    continue
                if not item["name"]:
                    region["name"] = _unique_name(state)
                state["regions"].append(region)
                created.append(region)
            return {"regions": created, "skipped": dict(skipped)}

        result = projects.update(*where(ds), change)
        if not result["regions"]:
            left_out = ", ".join(f"{n} {kind}" for kind, n in skipped.items())
            raise HTTPException(422, f"no regions found in {filename}"
                                + (f" ({left_out} left out)" if left_out else ""))
        return result

    def operate(ds: Dataset, state: dict, req: RegionOpIn, sources: list[dict]) -> list[tuple[dict, str, str]]:
        match req.op:
            case "union" | "intersect" | "xor" | "subtract":
                if len(sources) < 2:
                    raise HTTPException(422, "select at least two regions")
                name = combined_name(req.op, [r["name"] for r in sources])
                return [(combine(req.op, sources), name, sources[0]["color"])]
            case "enlarge":
                if not req.distance:
                    raise HTTPException(422, "give the distance to enlarge or shrink by")
                d = req.distance
                if req.unit == "um":
                    px = pixel_size_of(ds, state)
                    if not px:
                        raise HTTPException(422, "the image has no pixel size: use pixels, or set the scale first")
                    d /= px
                label = f"{'+' if req.distance > 0 else '−'}{abs(req.distance):g} {'µm' if req.unit == 'um' else 'px'}"
                return [(enlarge(r, d), f"{r['name']} {label}", r["color"]) for r in sources]
            case "hull":
                return [(hull(r), f"{r['name']} hull", r["color"]) for r in sources]
            case "ellipse":
                return [(fit_ellipse(r, ds.info.width, ds.info.height), f"{r['name']} ellipse", r["color"])
                        for r in sources]
            case _:
                assert_never(req.op)

    @router.put("/background")
    def set_background(ds_id: str, req: BackgroundIn) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            if req.region_id is not None:
                find(state, req.region_id)
            state["background_region"] = req.region_id
            return {"background_region": req.region_id}

        return projects.update(*where(ds), change)

    @router.put("/display")
    def set_display(ds_id: str, channels: list[DisplayChannel]) -> dict:
        ds = dataset(ds_id)
        if len(channels) != len(ds.info.channels):
            raise HTTPException(422, f"expected {len(ds.info.channels)} channels, got {len(channels)}")
        projects.update(*where(ds), lambda state: state.update(display=[c.model_dump() for c in channels]))
        return {"saved": len(channels)}

    @router.get("/regions/{rid}/measurement")
    def get_measurement(ds_id: str, rid: str) -> dict:
        ds = dataset(ds_id)
        state = projects.scan(*where(ds))
        px = pixel_size_of(ds, state)
        result = dict(measured(ds, find(state, rid), px))
        background = state["background_region"]
        if background and background != rid:
            bg = measured(ds, find(state, background), px)
            result["background"] = {"region_id": background, "region": bg["region"],
                                    "means": {c["channel"]: c["mean"] for c in bg["channels"]}}
        return result

    def find_note(state: dict, aid: str) -> dict:
        for note in state["annotations"]:
            if note["id"] == aid:
                return note
        raise HTTPException(404, "unknown annotation")

    @router.post("/annotations")
    def create_annotation(ds_id: str, req: AnnotationIn) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            if req.region_id is not None:
                find(state, req.region_id)
            note = new_annotation(req)
            state["annotations"].append(note)
            return note

        return projects.update(*where(ds), change)

    @router.patch("/annotations/{aid}")
    def patch_annotation(ds_id: str, aid: str, req: AnnotationPatch) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            note = find_note(state, aid)
            for key in ("x", "y"):
                value = getattr(req, key)
                if value is not None:
                    note[key] = float(value)
            if req.text is not None:
                note["text"] = req.text.strip()
            if "region_id" in req.model_fields_set:
                if req.region_id is not None:
                    find(state, req.region_id)
                note["region_id"] = req.region_id
            note["modified"] = now_iso()
            return note

        return projects.update(*where(ds), change)

    @router.delete("/annotations/{aid}")
    def delete_annotation(ds_id: str, aid: str) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            find_note(state, aid)
            state["annotations"] = [a for a in state["annotations"] if a["id"] != aid]
            return {"deleted": aid}

        return projects.update(*where(ds), change)

    @router.post("/annotations/restore")
    def restore_annotation(ds_id: str, req: AnnotationRestore) -> dict:
        """Put back a note exactly as it was, with its author and replies."""
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            if any(a["id"] == req.id for a in state["annotations"]):
                raise HTTPException(409, "a note with this id already exists")
            note = req.model_dump()
            state["annotations"].append(note)
            return note

        return projects.update(*where(ds), change)

    @router.post("/annotations/{aid}/replies")
    def reply(ds_id: str, aid: str, req: ReplyIn) -> dict:
        ds = dataset(ds_id)

        def change(state: dict) -> dict:
            note = find_note(state, aid)
            note["replies"].append(new_reply(req))
            note["modified"] = now_iso()
            return note

        return projects.update(*where(ds), change)

    def profile_of(ds: Dataset, x0: float, y0: float, x1: float, y1: float, max_samples: int) -> dict:
        try:
            return line_profile(ds, x0, y0, x1, y1, max_samples, pixel_size=pixel_size_of(ds))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        except NotReady:
            raise HTTPException(409, "the image is still loading; try again in a moment") from None

    @router.get("/profile")
    def get_profile(ds_id: str, x0: float, y0: float, x1: float, y1: float,
                    max_samples: int = Query(2048, ge=16, le=8192)) -> dict:
        return profile_of(dataset(ds_id), x0, y0, x1, y1, max_samples)

    @router.get("/profile.csv")
    def get_profile_csv(ds_id: str, x0: float, y0: float, x1: float, y1: float,
                        max_samples: int = Query(2048, ge=16, le=8192)) -> Response:
        ds = dataset(ds_id)
        text = profile_csv(profile_of(ds, x0, y0, x1, y1, max_samples), pixel_size_of(ds))
        return Response(text, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{file_stem(ds)}-profile.csv"'})

    def area_plan(ds: Dataset, box: Box, panels: tuple[int | None, ...], max_side: int) -> Plan:
        try:
            area = clip_box(box, ds.info.width, ds.info.height)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return plan(ds.levels, area, panels, max_side)

    @router.post("/figure")
    def export_figure(ds_id: str, req: FigureIn) -> Response:
        """Composite plus one panel per visible channel, rendered with the given display settings."""
        ds = dataset(ds_id)
        if len(req.display) != len(ds.info.channels):
            raise HTTPException(422, f"expected {len(ds.info.channels)} channels, got {len(req.display)}")
        displays = [Display(d.visible, d.color, d.lo, d.hi, d.gamma, d.lut, d.invert,
                            tuple((float(x), float(y)) for x, y in d.curve), d.intensity) for d in req.display]
        visible = tuple(i for i, d in enumerate(displays) if d.visible)
        if not visible:
            raise HTTPException(422, "no channel is visible")
        p = area_plan(ds, req.box, (None, *visible), req.max_side)
        if req.plan_only:
            return JSONResponse(p.to_json())
        state = projects.scan(*where(ds))
        px = pixel_size_of(ds, state)
        try:
            img = render_figure(ds, p, displays, regions=state["regions"] if req.regions else [],
                                notes=state["annotations"] if req.notes else [], scale_bar=req.scale_bar,
                                labels=req.labels, pixel_size=px, blend=req.blend)
        except NotReady:
            raise HTTPException(409, "the image is still loading; try again in a moment") from None
        meta = provenance(ds, p, displays, px, req.blend)
        if req.format == "png":
            body, ext, media = encode_png(img, req.dpi, meta), "png", "image/png"
        else:
            body, ext, media = encode_tiff(img, req.dpi, meta), "tif", "image/tiff"
        return Response(body, media_type=media,
                        headers={"Content-Disposition": f'attachment; filename="{file_stem(ds)}-figure.{ext}"'})

    @router.post("/export.ome.tif")
    def export_raw(ds_id: str, req: RawIn) -> Response:
        """Raw values of every channel in the area as OME-TIFF, with the physical pixel size."""
        ds = dataset(ds_id)
        p = area_plan(ds, req.box, (None,), req.max_side)
        if req.plan_only:
            return JSONResponse(p.to_json())
        path = exports_dir / f"{uuid.uuid4().hex}.ome.tif"
        try:
            write_ome(ds, p, path, pixel_size_of(ds))
        except NotReady:
            path.unlink(missing_ok=True)
            raise HTTPException(409, "the image is still loading; try again in a moment") from None
        return FileResponse(path, media_type="image/tiff", filename=f"{file_stem(ds)}-area.ome.tif",
                            background=BackgroundTask(path.unlink, missing_ok=True))

    def measurements_csv(ds: Dataset, state: dict) -> str | None:
        """The regions CSV, or None while the image is still loading."""
        px = pixel_size_of(ds, state)
        try:
            rows = rows_for_scan(ds.info.scan_key, px, [measured(ds, r, px) for r in state["regions"]],
                                 state["background_region"])
        except HTTPException:
            return None
        return to_csv(rows)

    @router.get("/fingerprint")
    def get_fingerprint(ds_id: str) -> dict:
        return {"fingerprint": content_fingerprint(dataset(ds_id).source)}

    @router.post("/session")
    def save_session(ds_id: str, req: SessionSaveIn) -> dict:
        """Write everything done on this image to a .fv file the user chose."""
        ds = dataset(ds_id)
        target = Path(os.path.expanduser(req.path))
        if not target.is_absolute():
            raise HTTPException(422, "give the full path of the session file")
        if target.suffix.lower() != SUFFIX:
            target = target.with_name(target.name + SUFFIX)
        if not target.parent.is_dir():
            raise HTTPException(404, f"folder not found: {target.parent}")
        if target.exists() and not req.overwrite:
            raise HTTPException(409, f"{target.name} already exists")
        if len(req.display) != len(ds.info.channels):
            raise HTTPException(422, f"expected {len(ds.info.channels)} channels, got {len(req.display)}")
        if req.export is not None and len(json.dumps(req.export)) > MAX_EXPORT_BYTES:
            raise HTTPException(422, "the export settings are too large")
        def keep_display(state: dict) -> dict:
            state["display"] = [d.model_dump() for d in req.display]
            return state

        state = projects.update(*where(ds), keep_display)
        session = session_from_state(state, display=req.display, view=req.view, viewer=req.viewer,
                                     profile_line=req.profile_line, export=req.export)
        try:
            manifest = image_manifest(ds, content_fingerprint(ds.source), pixel_size_of(ds, state))
            size = write_session(target, manifest, session, measurements_csv(ds, state), thumbnail_of(ds))
        except OSError as exc:
            raise HTTPException(403, f"could not write {target}: {exc.strerror}") from None
        return {"path": str(target), "bytes": size}

    @router.post("/session/apply")
    def apply_session(ds_id: str, req: SessionApplyIn) -> dict:
        """Restore a .fv onto this image: replace its work (kept as a backup .fv first) or merge into it."""
        ds = dataset(ds_id)
        path = Path(os.path.expanduser(req.path))
        if not path.is_file():
            raise HTTPException(404, f"session not found: {path}")
        try:
            manifest, session = read_session(path)
        except SessionError as exc:
            raise HTTPException(422, str(exc)) from None
        image = manifest["image"]
        info = ds.info
        if (image.get("width"), image.get("height"), len(image.get("channels") or [])) != (
                info.width, info.height, len(info.channels)):
            raise HTTPException(409, f"this session belongs to another image ({image.get('width')} × "
                                     f"{image.get('height')} px, {len(image.get('channels') or [])} channels)")
        fingerprint = content_fingerprint(ds.source)
        backup: list[Path] = []

        def change(state: dict) -> dict:
            if req.mode == "replace":
                if state["regions"] or state["annotations"]:
                    stamp = time.strftime("%Y%m%d-%H%M%S")
                    target = backups_dir / f"{file_stem(ds)}-before-import-{stamp}{SUFFIX}"
                    current = session_from_state(state, display=state["display"])
                    write_session(target, image_manifest(ds, fingerprint, pixel_size_of(ds, state)), current)
                    backup.append(target)
                replace_state(state, session, len(info.channels))
            else:
                merge_state(state, session)
            return project_view(state)

        project = projects.update(*where(ds), change)
        return {
            "project": project,
            "view": session.view.model_dump() if session.view else None,
            "viewer": session.viewer.model_dump() if session.viewer else None,
            "profile_line": session.profile_line.model_dump() if session.profile_line else None,
            "export": session.export,
            "fingerprint_ok": image.get("fingerprint") == fingerprint,
            "channels_match": image.get("channels") == [ch.name for ch in info.channels],
            "backup": str(backup[0]) if backup else None,
        }

    @router.get("/measurements.csv")
    def get_csv(ds_id: str) -> Response:
        ds = dataset(ds_id)
        state = projects.scan(*where(ds))
        px = pixel_size_of(ds, state)
        rows = rows_for_scan(ds.info.scan_key, px, [measured(ds, r, px) for r in state["regions"]],
                             state["background_region"])
        return Response(to_csv(rows), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{file_stem(ds)}-regions.csv"'})

    return router

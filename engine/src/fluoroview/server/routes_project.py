"""Regions, background region, display settings and measurements of an open dataset."""

from __future__ import annotations

import re
import threading
from collections import OrderedDict

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..datasets import Dataset, NotReady, Registry
from ..measure import measure_region, rows_for_scan, to_csv
from ..projects import ProjectStore, now_iso
from ..regions import RegionIn, RegionPatch, new_region, validate_shape


class DisplayChannel(BaseModel):
    visible: bool
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    lo: float
    hi: float
    gamma: float = Field(gt=0, le=10)


class BackgroundIn(BaseModel):
    region_id: str | None


def _unique_name(state: dict) -> str:
    taken = {r["name"] for r in state["regions"]}
    numbers = [int(m.group(1)) for n in taken if (m := re.fullmatch(r"Region (\d+)", n))]
    k = max(numbers, default=0) + 1
    while f"Region {k}" in taken:
        k += 1
    return f"Region {k}"


def project_router(registry: Registry, projects: ProjectStore) -> APIRouter:
    router = APIRouter(prefix="/api/v1/datasets/{ds_id}")
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

    def measured(ds: Dataset, region: dict) -> dict:
        key = (ds.id, region["id"], region["modified"], tuple(map(tuple, region["points"])))
        with cache_lock:
            if key in cache:
                cache.move_to_end(key)
                return cache[key]
        try:
            result = measure_region(ds, region)
        except NotReady:
            raise HTTPException(409, "the image is still loading; try again in a moment") from None
        with cache_lock:
            cache[key] = result
            while len(cache) > 256:
                cache.popitem(last=False)
        return result

    @router.get("/project")
    def get_project(ds_id: str) -> dict:
        ds = dataset(ds_id)
        state = projects.scan(*where(ds))
        return {k: state[k] for k in ("regions", "annotations", "background_region", "display")}

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
            if req.points is not None:
                try:
                    validate_shape(region["shape"], req.points)
                except ValueError as exc:
                    raise HTTPException(422, str(exc)) from None
                region["points"] = [[float(x), float(y)] for x, y in req.points]
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
        result = dict(measured(ds, find(state, rid)))
        background = state["background_region"]
        if background and background != rid:
            bg = measured(ds, find(state, background))
            result["background"] = {"region_id": background, "region": bg["region"],
                                    "means": {c["channel"]: c["mean"] for c in bg["channels"]}}
        return result

    @router.get("/measurements.csv")
    def get_csv(ds_id: str) -> Response:
        ds = dataset(ds_id)
        state = projects.scan(*where(ds))
        rows = rows_for_scan(ds.info.scan_key, ds.info.pixel_size_um,
                             [measured(ds, r) for r in state["regions"]], state["background_region"])
        name = re.sub(r"[^\w.+-]+", "_", ds.info.scan_key)
        return Response(to_csv(rows), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}-regions.csv"'})

    return router

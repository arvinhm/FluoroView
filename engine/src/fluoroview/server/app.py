"""HTTP + WebSocket API of the local engine, and the static studio UI."""

from __future__ import annotations

import asyncio
import contextlib
import math
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .. import __version__
from ..config import Settings
from ..datasets import Dataset, NotReady, Registry
from ..events import EventBus
from ..io import MultiFileSource, TiffSource, UnsupportedImage, file_fingerprint, is_openable
from ..projects import ProjectStore
from ..pyramid.cache import PyramidCache
from ..pyramid.store import PyramidStore
from ..session import SUFFIX as SESSION_SUFFIX
from ..session import SessionError, find_image, read_session, read_thumbnail
from ..thumbnail import render_thumbnail
from .routes_project import project_router
from .security import LocalAccessMiddleware

_NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>FluoroView</title>
<body style="background:#0b0c0e;color:#e6e7e9;font:13px -apple-system,system-ui,sans-serif;padding:32px">
<p>The FluoroView studio has not been built.</p>
<pre style="color:#a2a5ac">cd studio &amp;&amp; npm install &amp;&amp; npm run build</pre></body>"""


def _json_safe(value):
    """NaN and Infinity are not JSON; show them as text so an error about them can still be sent."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_json_safe(v) for v in value]
    return value


class SessionPath(BaseModel):
    path: str = Field(min_length=1, max_length=4096)


class OpenRequest(BaseModel):
    path: str | None = None
    paths: list[str] | None = None
    """Two or more single-channel files to open as the channels of one image."""


def create_app(settings: Settings) -> FastAPI:
    events = EventBus()
    cache = PyramidCache(settings.cache_dir, settings.cache_limit_bytes)
    cache.remove_incomplete(keep=set())
    registry = Registry(cache, events, cache_full_resolution=settings.cache_full_resolution,
                        band_cache_bytes=settings.band_cache_bytes)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        events.bind(asyncio.get_running_loop())
        yield
        registry.shutdown()

    app = FastAPI(title="FluoroView engine", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.registry = registry
    app.state.cache = cache
    app.state.events = events
    app.state.settings = settings
    app.add_middleware(LocalAccessMiddleware, token=settings.token, allowed_hosts=settings.allowed_hosts)

    @app.exception_handler(RequestValidationError)
    async def validation_failed(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": _json_safe(jsonable_encoder(exc.errors()))})

    api = APIRouter(prefix="/api/v1")

    def dataset(ds_id: str) -> Dataset:
        try:
            return registry.get(ds_id)
        except KeyError:
            raise HTTPException(404, "unknown dataset") from None

    @api.get("/health")
    def health() -> dict:
        return {"version": __version__, "datasets": len(registry.list())}

    @api.get("/datasets")
    def list_datasets() -> list[dict]:
        return [ds.to_json() for ds in registry.list()]

    @api.post("/datasets")
    def open_dataset(req: OpenRequest) -> dict:
        try:
            if req.paths and len(req.paths) > 1:
                return registry.open_channels(req.paths).to_json()
            path = req.path or (req.paths[0] if req.paths else None)
            if not path:
                raise HTTPException(422, "give a path, or two or more paths to combine as channels")
            return registry.open(path).to_json()
        except FileNotFoundError as exc:
            raise HTTPException(404, f"file not found: {exc}") from None
        except (UnsupportedImage, ValueError) as exc:
            raise HTTPException(422, str(exc)) from None

    @api.get("/datasets/{ds_id}")
    def get_dataset(ds_id: str) -> dict:
        return dataset(ds_id).to_json()

    @api.get("/datasets/{ds_id}/tiles/{level}/{c}/{ty}/{tx}")
    def get_tile(ds_id: str, level: int, c: int, ty: int, tx: int) -> Response:
        ds = dataset(ds_id)
        try:
            data, final = ds.tile(level, c, ty, tx)
        except IndexError as exc:
            raise HTTPException(404, str(exc)) from None
        except NotReady:
            return Response(status_code=202, headers={"Cache-Control": "no-store"})
        return Response(
            content=data.tobytes(),
            media_type="application/octet-stream",
            headers={
                "X-Tile-Width": str(data.shape[1]),
                "X-Tile-Height": str(data.shape[0]),
                "X-Tile-Dtype": data.dtype.str,
                "X-Tile-Final": "1" if final else "0",
                "Cache-Control": "private, max-age=31536000, immutable" if final else "no-store",
            },
        )

    @api.get("/datasets/{ds_id}/histogram/{c}")
    def get_histogram(ds_id: str, c: int, bins: int = Query(256, ge=16, le=65536)) -> dict:
        try:
            return dataset(ds_id).histogram(c, bins)
        except IndexError as exc:
            raise HTTPException(404, str(exc)) from None
        except NotReady:
            raise HTTPException(409, "histogram not available yet") from None

    @api.get("/datasets/{ds_id}/pixel")
    def get_pixel(ds_id: str, x: int, y: int) -> dict:
        try:
            return {"x": x, "y": y, "values": dataset(ds_id).pixel(x, y)}
        except IndexError as exc:
            raise HTTPException(404, str(exc)) from None
        except NotReady:
            raise HTTPException(409, "pixel not available yet") from None

    @api.get("/datasets/{ds_id}/patch")
    def get_patch(ds_id: str, x: int, y: int, r: int = Query(5, ge=1, le=16)) -> dict:
        """Raw full-resolution values of the (2r+1)² pixels around (x, y), shifted to stay inside the image."""
        ds = dataset(ds_id)
        w, h = ds.info.width, ds.info.height
        if not (0 <= x < w and 0 <= y < h):
            raise HTTPException(404, "pixel out of range")
        size = min(2 * r + 1, w, h)
        x0 = min(max(0, x - r), w - size)
        y0 = min(max(0, y - r), h - size)
        try:
            planes = [ds.read_region(0, c, x0, y0, x0 + size, y0 + size) for c in range(len(ds.info.channels))]
        except NotReady:
            raise HTTPException(409, "pixels not available yet") from None
        return {"x0": x0, "y0": y0, "size": size, "channels": [p.ravel().tolist() for p in planes]}

    def thumbnail_png(key: str, size: int, info_of) -> bytes:
        thumb = cache.dir(key) / f"thumbnail-{size}.png"
        if not thumb.exists():
            png = render_thumbnail(PyramidStore.open(cache.pyramid_dir(key)), cache.histograms(key), info_of(), size)
            tmp = thumb.with_suffix(".tmp")
            tmp.write_bytes(png)
            os.replace(tmp, thumb)
        return thumb.read_bytes()

    def cached_thumbnail(key: str, size: int, info_of) -> Response:
        return Response(thumbnail_png(key, size, info_of), media_type="image/png",
                        headers={"Cache-Control": "private, max-age=86400"})

    @api.get("/sessions/thumbnail")
    def session_preview(path: str) -> Response:
        """The preview saved inside a .fv (for recent-session cards)."""
        real = Path(os.path.expanduser(path))
        png = read_thumbnail(real) if real.is_file() and real.name.lower().endswith(SESSION_SUFFIX) else None
        if png is None:
            raise HTTPException(404, "no preview in this session")
        return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=60"})

    @api.post("/sessions/inspect")
    def inspect_session(req: SessionPath) -> dict:
        """What a .fv holds and where its image is, before anything is opened or changed."""
        path = Path(os.path.expanduser(req.path))
        if not path.is_file():
            raise HTTPException(404, f"session not found: {path}")
        try:
            manifest, session = read_session(path)
        except SessionError as exc:
            raise HTTPException(422, str(exc)) from None
        return {"manifest": manifest, "regions": len(session.regions), "notes": len(session.notes),
                "image_paths": find_image(manifest, path)}

    @api.get("/thumbnail")
    def file_thumbnail(path: Annotated[list[str], Query(max_length=64)],
                       size: int = Query(320, ge=64, le=1024)) -> Response:
        """Preview of a scan (or of files combined as channels, in order) whose pyramid is already cached.

        Never reads an uncached scan."""
        reals = [os.path.realpath(os.path.expanduser(p)) for p in path]
        if not reals or not all(os.path.isfile(r) and is_openable(os.path.basename(r)) for r in reals):
            raise HTTPException(404, "no such image")
        key = (PyramidCache.key_for(reals[0]) if len(reals) == 1
               else cache.key_for_fingerprint("\n".join(file_fingerprint(r) for r in reals)))
        if not cache.is_complete(key):
            raise HTTPException(404, "not cached yet")

        def info():
            src = TiffSource(reals[0]) if len(reals) == 1 else MultiFileSource(reals)
            try:
                return src.info
            finally:
                src.close()

        return cached_thumbnail(key, size, info)

    @api.get("/datasets/{ds_id}/thumbnail")
    def dataset_thumbnail(ds_id: str, size: int = Query(320, ge=64, le=1024)) -> Response:
        ds = dataset(ds_id)
        if ds.state != "ready":
            raise HTTPException(409, "pyramid not built yet")
        return cached_thumbnail(ds.id, size, lambda: ds.info)

    @api.get("/fs/list")
    def fs_list(path: str | None = None) -> dict:
        root = Path(path).expanduser() if path else Path.home()
        try:
            real = root.resolve(strict=True)
        except (FileNotFoundError, RuntimeError):
            raise HTTPException(404, f"folder not found: {root}") from None
        if not real.is_dir():
            raise HTTPException(404, f"not a folder: {real}")
        entries = []
        try:
            scan = list(os.scandir(real))
        except PermissionError:
            raise HTTPException(403, f"no permission to read {real}") from None
        for entry in scan:
            if entry.name.startswith("."):
                continue
            try:
                is_dir = entry.is_dir()
                st = entry.stat()
            except OSError:
                continue
            is_session = not is_dir and entry.name.lower().endswith(SESSION_SUFFIX)
            if not is_dir and not is_session and not is_openable(entry.name):
                continue
            item = {"name": entry.name, "path": os.path.join(real, entry.name), "dir": is_dir,
                    "size": None if is_dir else st.st_size, "mtime": st.st_mtime}
            if is_session:
                item["session"] = True
            elif not is_dir:
                item["cached"] = cache.is_complete(PyramidCache.key_for(item["path"]))
            entries.append(item)
        entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
        parent = str(real.parent) if real.parent != real else None
        return {"path": str(real), "parent": parent, "entries": entries}

    def session_thumbnail(ds: Dataset) -> bytes | None:
        return thumbnail_png(ds.id, 480, lambda: ds.info) if ds.state == "ready" else None

    app.include_router(api)
    exports = settings.cache_dir.parent / "exports"
    backups = settings.projects_dir.parent / "backups"
    projects = ProjectStore(settings.projects_dir)
    app.include_router(project_router(registry, projects, exports, backups, session_thumbnail))

    @app.websocket("/api/v1/events")
    async def event_stream(ws: WebSocket) -> None:
        """Push events until the client leaves. Waiting on the socket as well as the queue lets the
        handler end at once on disconnect, so server shutdown never waits on an idle stream."""
        await ws.accept()
        q = events.subscribe()

        async def forward() -> None:
            await ws.send_json({"type": "hello", "version": __version__})
            while True:
                await ws.send_json(await q.get())

        sender = asyncio.create_task(forward())
        try:
            while (await ws.receive())["type"] != "websocket.disconnect":
                pass
        except WebSocketDisconnect:
            pass
        finally:
            events.unsubscribe(q)
            sender.cancel()
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await sender

    studio = settings.studio_dir
    if studio is not None and (studio / "index.html").exists():
        app.mount("/", StaticFiles(directory=studio, html=True), name="studio")
    else:
        @app.get("/", response_class=HTMLResponse)
        def not_built() -> str:
            return _NOT_BUILT

    return app

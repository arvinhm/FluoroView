"""HTTP + WebSocket API of the local engine, and the static studio UI."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import __version__
from ..config import Settings
from ..datasets import Dataset, NotReady, Registry
from ..events import EventBus
from ..io import UnsupportedImage, is_openable
from ..pyramid.cache import PyramidCache
from .security import LocalAccessMiddleware

_NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>FluoroView</title>
<body style="background:#0b0c0e;color:#e6e7e9;font:13px -apple-system,system-ui,sans-serif;padding:32px">
<p>The FluoroView studio has not been built.</p>
<pre style="color:#a2a5ac">cd studio &amp;&amp; npm install &amp;&amp; npm run build</pre></body>"""


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
    app.state.settings = settings
    app.add_middleware(LocalAccessMiddleware, token=settings.token, allowed_hosts=settings.allowed_hosts)

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
            if not is_dir and not is_openable(entry.name):
                continue
            item = {"name": entry.name, "path": os.path.join(real, entry.name), "dir": is_dir,
                    "size": None if is_dir else st.st_size, "mtime": st.st_mtime}
            if not is_dir:
                item["cached"] = cache.is_complete(PyramidCache.key_for(item["path"]))
            entries.append(item)
        entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
        parent = str(real.parent) if real.parent != real else None
        return {"path": str(real), "parent": parent, "entries": entries}

    app.include_router(api)

    @app.websocket("/api/v1/events")
    async def event_stream(ws: WebSocket) -> None:
        await ws.accept()
        q = events.subscribe()
        try:
            await ws.send_json({"type": "hello", "version": __version__})
            while True:
                await ws.send_json(await q.get())
        except WebSocketDisconnect:
            pass
        finally:
            events.unsubscribe(q)

    studio = settings.studio_dir
    if studio is not None and (studio / "index.html").exists():
        app.mount("/", StaticFiles(directory=studio, html=True), name="studio")
    else:
        @app.get("/", response_class=HTMLResponse)
        def not_built() -> str:
            return _NOT_BUILT

    return app

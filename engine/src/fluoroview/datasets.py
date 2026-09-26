"""Open datasets: metadata, pyramid build scheduling, tiles, exact histograms and pixel values."""

from __future__ import annotations

import os
import queue
import threading
import time
from collections import OrderedDict

import numpy as np

from .events import EventBus
from .io import Layout, MultiFileSource, Source, TiffSource, file_fingerprint, is_openable
from .pyramid.builder import BuildCancelled, BuildProgress, PyramidBuilder
from .pyramid.cache import PyramidCache
from .pyramid.kernels import accumulate_histogram, downsample2
from .pyramid.store import TILE, PyramidStore, plan_levels

PERCENTILES = (0.1, 0.5, 1.0, 50.0, 99.0, 99.5, 99.8, 99.9)


class NotReady(Exception):
    """The requested tile has not been built yet."""


def histogram_summary(counts: np.ndarray, saturation: int | None, bins: int, complete: bool) -> dict:
    nz = np.flatnonzero(counts)
    if nz.size == 0:
        return {"complete": complete, "total": 0, "counts": [], "range": [0, 1], "min": 0, "max": 0,
                "saturated": 0, "saturation": saturation, "percentiles": {}}
    lo, hi = int(nz[0]), int(nz[-1])
    usable = counts.copy()
    saturated = 0
    if saturation is not None and saturation < counts.size:
        saturated = int(counts[saturation:].sum())
        usable[saturation:] = 0
    cdf = np.cumsum(usable)
    n = int(cdf[-1])
    pct = {str(p): int(np.searchsorted(cdf, n * p / 100.0, side="left")) if n else 0 for p in PERCENTILES}
    span = hi + 1
    if span <= bins:
        rebinned = counts[:span]
    else:
        starts = np.floor(np.arange(bins) * (span / bins)).astype(np.int64)
        rebinned = np.add.reduceat(counts[:span], starts)
    return {
        "complete": complete,
        "total": int(counts.sum()),
        "counts": rebinned.astype(np.int64).tolist(),
        "range": [0, span],
        "min": lo,
        "max": hi,
        "saturated": saturated,
        "saturation": saturation,
        "percentiles": pct,
    }


class Dataset:
    def __init__(self, key: str, source: Source, cache: PyramidCache, events: EventBus, *,
                 cache_full_resolution: bool = False, band_cache_bytes: int = 1 << 30):
        self.id = key
        self.source = source
        self.info = source.info
        self.cache = cache
        self.events = events
        self.levels = plan_levels(self.info.width, self.info.height, TILE)
        self.level0_cached = cache_full_resolution or self.info.layout is not Layout.CONTIGUOUS
        self.store: PyramidStore | None = None
        self.builder: PyramidBuilder | None = None
        self.state = "queued"
        self.error: str | None = None
        self.progress = 0.0
        self.rows_ready: tuple[int, ...] = (0,) * len(self.levels)
        self.build_seconds: float | None = None
        self._histograms: np.ndarray | None = None
        self._cancel = threading.Event()
        self._bands: OrderedDict[tuple[int, int], np.ndarray] = OrderedDict()
        self._band_inflight: dict[tuple[int, int], threading.Event] = {}
        self._band_bytes = 0
        self._band_limit = band_cache_bytes
        self._band_lock = threading.Lock()

    # -- state ---------------------------------------------------------------------------------

    def attach_complete(self) -> None:
        meta = self.cache.meta(self.id) or {}
        self.store = PyramidStore.open(self.cache.pyramid_dir(self.id))
        self._histograms = self.cache.histograms(self.id)
        self.rows_ready = tuple(level.height for level in self.levels)
        self.build_seconds = meta.get("build_seconds")
        self.level0_cached = bool(meta.get("level0_cached", True))
        self.progress = 1.0
        self.state = "ready"
        self.cache.touch(self.id)

    def build(self) -> None:
        root = self.cache.begin(self.id, self.info.path)
        self.store = PyramidStore.create(root, self.info, TILE)
        self.builder = PyramidBuilder(self.source, self.store, write_level0=self.level0_cached,
                                      on_progress=self._on_progress, cancel=self._cancel)
        self.state = "building"
        self._publish()
        t0 = time.perf_counter()
        try:
            self.builder.run()
        except BuildCancelled:
            self.state, self.store = "cancelled", None
            self.cache.discard(self.id)
            self._publish()
            return
        except Exception as exc:
            self.state, self.error, self.store = "failed", f"{type(exc).__name__}: {exc}", None
            self.cache.discard(self.id)
            self._publish()
            return
        self.build_seconds = time.perf_counter() - t0
        self._histograms = self.builder.histograms
        self.cache.finish(self.id, self._histograms, self.build_seconds, self.store.nbytes(), self.level0_cached)
        self.rows_ready = tuple(level.height for level in self.levels)
        self.progress, self.state = 1.0, "ready"
        if self.level0_cached:
            with self._band_lock:
                self._bands.clear()
                self._band_bytes = 0
        self._publish()

    def cancel(self) -> None:
        self._cancel.set()

    def _on_progress(self, p: BuildProgress) -> None:
        self.rows_ready = p.rows_ready
        self.progress = p.fraction
        self._publish(elapsed_s=round(p.elapsed_s, 3))

    def _publish(self, **extra) -> None:
        self.events.publish({"type": "build", "id": self.id, "build": self.build_json() | extra})

    # -- reads ---------------------------------------------------------------------------------

    def tile(self, level: int, c: int, ty: int, tx: int) -> tuple[np.ndarray, bool]:
        """Raw tile data and whether it is final. Raises IndexError or NotReady."""
        if not (0 <= level < len(self.levels)) or not (0 <= c < len(self.info.channels)):
            raise IndexError("level or channel out of range")
        lvl = self.levels[level]
        if not (0 <= ty < lvl.tiles_y(TILE) and 0 <= tx < lvl.tiles_x(TILE)):
            raise IndexError("tile out of range")
        y_end = min((ty + 1) * TILE, lvl.height)
        ready = self.rows_ready[level]
        store = self.store
        from_source = level == 0 and self.info.layout is Layout.CONTIGUOUS
        if store is not None and ready >= y_end and not (from_source and not self.level0_cached):
            data = store.read_chunk(level, c, ty, tx)
            if data is not None:
                return data, True
        if from_source:
            band = self._band(c, ty)
            return band[:, tx * TILE:min((tx + 1) * TILE, lvl.width)], True
        if store is not None and ready > ty * TILE:
            data = store.read_chunk(level, c, ty, tx)
            if data is not None:
                return data, False
        raise NotReady

    def _band(self, c: int, ty: int) -> np.ndarray:
        """Full-width 512-row band of the source, shared by all tiles in that row (LRU in memory)."""
        key = (c, ty)
        while True:
            with self._band_lock:
                band = self._bands.get(key)
                if band is not None:
                    self._bands.move_to_end(key)
                    return band
                pending = self._band_inflight.get(key)
                if pending is None:
                    pending = self._band_inflight[key] = threading.Event()
                    break
            pending.wait()
        try:
            y0 = ty * TILE
            band = self.source.read_rows(c, y0, min(y0 + TILE, self.info.height))
            with self._band_lock:
                self._bands[key] = band
                self._band_bytes += band.nbytes
                while self._band_bytes > self._band_limit and len(self._bands) > 1:
                    _, old = self._bands.popitem(last=False)
                    self._band_bytes -= old.nbytes
            return band
        finally:
            with self._band_lock:
                self._band_inflight.pop(key).set()

    def pixel(self, x: int, y: int) -> list[int]:
        if not (0 <= x < self.info.width and 0 <= y < self.info.height):
            raise IndexError("pixel out of range")
        out = []
        for c in range(len(self.info.channels)):
            data, _ = self.tile(0, c, y // TILE, x // TILE)
            out.append(int(data[y % TILE, x % TILE]))
        return out

    def histogram(self, c: int, bins: int = 256) -> dict:
        if not 0 <= c < len(self.info.channels):
            raise IndexError("channel out of range")
        counts = self._histograms if self._histograms is not None else (
            self.builder.histograms if self.builder is not None else None)
        if counts is None:
            raise NotReady
        return histogram_summary(counts[c].copy(), self.info.saturation, bins, self.state == "ready")

    # -- json ----------------------------------------------------------------------------------

    def build_json(self) -> dict:
        return {"state": self.state, "progress": round(self.progress, 4), "rows_ready": list(self.rows_ready),
                "seconds": round(self.build_seconds, 3) if self.build_seconds else None, "error": self.error}

    def to_json(self) -> dict:
        info = self.info.to_json()
        return info | {
            "id": self.id,
            "tile_size": TILE,
            "levels": [{"index": lv.index, "width": lv.width, "height": lv.height} for lv in self.levels],
            "build": self.build_json(),
        }


class Registry:
    """Datasets opened in this engine session. Builds run one at a time on a worker thread."""

    def __init__(self, cache: PyramidCache, events: EventBus, *, cache_full_resolution: bool = False,
                 band_cache_bytes: int = 1 << 30):
        self.cache = cache
        self.events = events
        self.cache_full_resolution = cache_full_resolution
        self.band_cache_bytes = band_cache_bytes
        self._datasets: dict[str, Dataset] = {}
        self._lock = threading.Lock()
        self._builds: queue.Queue[Dataset | None] = queue.Queue()
        self._worker = threading.Thread(target=self._run_builds, name="pyramid-builds", daemon=True)
        self._worker.start()

    @staticmethod
    def _warm_kernels() -> None:
        """Load the compiled kernels before the first band arrives (~0.5 s on first use)."""
        for dtype, bins in ((np.uint16, 65536), (np.uint8, 256)):
            a = np.zeros((2, 2), dtype)
            accumulate_histogram(a, np.zeros(bins, np.int64))
            downsample2(a)

    @staticmethod
    def _checked(path: str) -> str:
        real = os.path.realpath(os.path.expanduser(path))
        if not os.path.isfile(real):
            raise FileNotFoundError(real)
        if not is_openable(os.path.basename(real)):
            raise ValueError("FluoroView opens TIFF files (.tif, .tiff, .ome.tif, .qptiff, .btf).")
        return real

    def open(self, path: str) -> Dataset:
        real = self._checked(path)
        return self._register(self.cache.key_for_fingerprint(file_fingerprint(real)), lambda: TiffSource(real))

    def open_channels(self, paths: list[str]) -> Dataset:
        """Open single-channel files of equal size as the channels of one image, in the given order."""
        reals = [self._checked(p) for p in paths]
        if len(set(reals)) != len(reals):
            raise ValueError("The same file was chosen twice.")
        key = self.cache.key_for_fingerprint("\n".join(file_fingerprint(r) for r in reals))
        return self._register(key, lambda: MultiFileSource(reals))

    def _register(self, key: str, make_source) -> Dataset:
        with self._lock:
            if key in self._datasets:
                return self._datasets[key]
            ds = Dataset(key, make_source(), self.cache, self.events,
                         cache_full_resolution=self.cache_full_resolution, band_cache_bytes=self.band_cache_bytes)
            self._datasets[key] = ds
        if self.cache.is_complete(key):
            ds.attach_complete()
        else:
            self._builds.put(ds)
        return ds

    def get(self, key: str) -> Dataset:
        return self._datasets[key]

    def list(self) -> list[Dataset]:
        return list(self._datasets.values())

    def expected_bytes(self, ds: Dataset) -> int:
        item = np.dtype(ds.info.dtype).itemsize
        n = len(ds.info.channels)
        levels = ds.levels if ds.level0_cached else ds.levels[1:]
        return sum(lv.tiles_x(TILE) * lv.tiles_y(TILE) * TILE * TILE * item * n for lv in levels)

    def _run_builds(self) -> None:
        self._warm_kernels()
        while True:
            ds = self._builds.get()
            if ds is None:
                return
            if ds._cancel.is_set():
                continue
            self.cache.evict(keep=set(self._datasets), reserve_bytes=self.expected_bytes(ds))
            ds.build()

    def shutdown(self) -> None:
        for ds in self.list():
            ds.cancel()
        self._builds.put(None)
        self._worker.join(timeout=10)
        for ds in self.list():
            ds.source.close()

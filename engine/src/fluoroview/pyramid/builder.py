"""One sequential pass over a source that writes every pyramid level and exact histograms.

The source is read top to bottom in full-width bands, exactly once, by a reader thread that stays up
to two bands ahead. Each band is histogrammed and downsampled through every level with one channel
per thread. Chunk writes for a band overlap the processing of the next bands; ``rows_ready[level]``
advances, in band order, only after the chunks covering those rows are on disk, so tiles can be
served while the build runs.
"""

from __future__ import annotations

import itertools
import queue
import threading
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass

import numpy as np

from ..io.tiff import TiffSource
from .kernels import accumulate_histogram, downsample2
from .store import PyramidStore


class BuildCancelled(Exception):
    pass


@dataclass(frozen=True)
class BuildProgress:
    rows_done: int
    rows_ready: tuple[int, ...]
    fraction: float
    elapsed_s: float


def band_rows_for(n_levels: int, tile: int) -> int:
    """Rows per band: a multiple of the tile height that halves evenly down to the last level."""
    need = max(tile, 1 << (n_levels - 1))
    return -(-need // tile) * tile


class PyramidBuilder:
    def __init__(
        self,
        source: TiffSource,
        store: PyramidStore,
        *,
        write_level0: bool = True,
        on_progress: Callable[[BuildProgress], None] | None = None,
        cancel: threading.Event | None = None,
        write_workers: int = 8,
        max_pending_bands: int = 3,
        flush_interval_s: float = 0.4,
    ):
        self.source = source
        self.store = store
        self.write_level0 = write_level0
        self.on_progress = on_progress
        self.cancel = cancel or threading.Event()
        self.write_workers = write_workers
        self.max_pending_bands = max_pending_bands
        self.flush_interval_s = flush_interval_s
        n_bins = 1 << (8 * np.dtype(source.dtype).itemsize)
        self.histograms = np.zeros((store.n_channels, n_bins), np.int64)
        self.rows_ready = [0] * len(store.levels)
        self.rows_ready[0] = 0 if write_level0 else source.info.height
        self.timings = {"read": 0.0, "wait_read": 0.0, "compute": 0.0, "wait_write": 0.0}
        self._version = itertools.count()
        self._t0 = 0.0

    def run(self) -> None:
        store, levels, tile = self.store, self.store.levels, self.store.tile
        n_ch, height = store.n_channels, levels[0].height
        band_rows = band_rows_for(len(levels), tile)
        buffers = {k: np.zeros((n_ch, tile, levels[k].width), store.dtype) for k in range(1, len(levels))}
        filled = dict.fromkeys(buffers, 0)
        buf_ty = dict.fromkeys(buffers, 0)
        last_flush = dict.fromkeys(buffers, 0.0)
        committed = list(self.rows_ready)
        pending: deque[tuple[int, list[Future], list[int]]] = deque()
        self._t0 = time.perf_counter()

        bands: queue.Queue = queue.Queue(maxsize=2)
        stop = threading.Event()
        with (
            self.source.stream() as fd,
            ThreadPoolExecutor(self.write_workers, thread_name_prefix="chunk-write") as writers,
            ThreadPoolExecutor(n_ch, thread_name_prefix="band-compute") as compute,
        ):
            reader = threading.Thread(target=self._read_bands, args=(fd, band_rows, bands, stop), daemon=True)
            reader.start()
            try:
                while True:
                    t = time.perf_counter()
                    item = bands.get()
                    self.timings["wait_read"] += time.perf_counter() - t
                    if item is None:
                        break
                    if isinstance(item, BaseException):
                        raise item
                    if self.cancel.is_set():
                        raise BuildCancelled
                    y0, y1, planes = item

                    t = time.perf_counter()
                    chains = list(compute.map(self._process_channel, range(n_ch), planes))
                    self.timings["compute"] += time.perf_counter() - t

                    futures: list[Future] = []
                    ready = list(committed)
                    if self.write_level0:
                        for r in range(0, y1 - y0, tile):
                            for c, plane in enumerate(planes):
                                futures += self._submit_row(writers, 0, c, (y0 + r) // tile, plane[r:r + tile])
                        ready[0] = y1

                    now = time.perf_counter()
                    last_band = y1 >= height
                    for k in buffers:
                        block = np.stack([chain[k - 1] for chain in chains])
                        at = 0
                        while at < block.shape[1]:
                            take = min(tile - filled[k], block.shape[1] - at)
                            buffers[k][:, filled[k]:filled[k] + take] = block[:, at:at + take]
                            filled[k] += take
                            at += take
                            if filled[k] == tile:
                                for c in range(n_ch):
                                    futures += self._submit_row(writers, k, c, buf_ty[k], buffers[k][c])
                                ready[k] = (buf_ty[k] + 1) * tile
                                buffers[k] = np.zeros_like(buffers[k])
                                buf_ty[k] += 1
                                filled[k] = 0
                                last_flush[k] = now
                        if filled[k] and (last_band or now - last_flush[k] >= self.flush_interval_s):
                            for c in range(n_ch):
                                futures += self._submit_row(writers, k, c, buf_ty[k], buffers[k][c, :filled[k]])
                            ready[k] = buf_ty[k] * tile + filled[k]
                            last_flush[k] = now

                    committed = ready
                    pending.append((y1, futures, ready))
                    self._publish_done(pending, height, force=max(0, len(pending) - self.max_pending_bands))
                self._publish_done(pending, height, force=len(pending))
            finally:
                stop.set()
                while reader.is_alive():
                    try:
                        bands.get_nowait()
                    except queue.Empty:
                        reader.join(timeout=0.05)

    def _process_channel(self, c: int, plane: np.ndarray) -> list[np.ndarray]:
        accumulate_histogram(plane, self.histograms[c])
        out = []
        a = plane
        for _ in range(len(self.store.levels) - 1):
            a = downsample2(a)
            out.append(a)
        return out

    def _submit_row(self, pool, level: int, c: int, ty: int, rows: np.ndarray) -> list[Future]:
        """Write the chunks of one chunk row: ``rows`` holds up to ``tile`` rows of channel ``c``."""
        tile = self.store.tile
        version = next(self._version)
        return [
            pool.submit(self.store.write_chunk, level, c, ty, tx, rows[:, tx * tile:(tx + 1) * tile], version)
            for tx in range(self.store.levels[level].tiles_x(tile))
        ]

    def _publish_done(self, pending: deque, height: int, force: int) -> None:
        """Publish finished bands in order; block on the oldest ``force`` bands first."""
        while pending:
            y1, futures, ready = pending[0]
            if force > 0:
                t = time.perf_counter()
                wait(futures)
                self.timings["wait_write"] += time.perf_counter() - t
                force -= 1
            elif not all(f.done() for f in futures):
                return
            for f in futures:
                f.result()
            pending.popleft()
            self.rows_ready = ready
            if self.on_progress:
                self.on_progress(BuildProgress(rows_done=y1, rows_ready=tuple(ready), fraction=y1 / height,
                                               elapsed_s=time.perf_counter() - self._t0))

    def _read_bands(self, fd, band_rows: int, out: queue.Queue, stop: threading.Event) -> None:
        height = self.source.info.height
        n_ch = self.store.n_channels
        try:
            for y0 in range(0, height, band_rows):
                if self.cancel.is_set() or stop.is_set():
                    break
                y1 = min(height, y0 + band_rows)
                t = time.perf_counter()
                planes = [self.source.read_rows(c, y0, y1, fd=fd) for c in range(n_ch)]
                self.timings["read"] += time.perf_counter() - t
                out.put((y0, y1, planes))
        except BaseException as exc:  # handed to the consumer thread
            out.put(exc)
            return
        out.put(None)

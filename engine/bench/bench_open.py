"""Measure metadata open, full-resolution tile latency, pyramid build and cached tile latency.

    uv run python bench/bench_open.py /path/to/scan.tif [--discard]

Reads the image; writes its pyramid into the normal cache (kept unless --discard).
"""

from __future__ import annotations

import argparse
import statistics
import time
from pathlib import Path

import numpy as np

from fluoroview.config import default_cache_dir
from fluoroview.datasets import Dataset
from fluoroview.events import EventBus
from fluoroview.io import TiffSource
from fluoroview.pyramid.cache import PyramidCache


def ms(values: list[float]) -> str:
    v = sorted(x * 1e3 for x in values)
    return f"p50 {statistics.median(v):6.1f} ms   p95 {v[int(0.95 * (len(v) - 1))]:6.1f} ms   max {v[-1]:6.1f} ms"


def sample_tiles(ds: Dataset, level: int, n: int, seed: int) -> list[float]:
    rng = np.random.default_rng(seed)
    lv = ds.levels[level]
    out = []
    for _ in range(n):
        c = int(rng.integers(0, len(ds.info.channels)))
        ty, tx = int(rng.integers(0, lv.tiles_y())), int(rng.integers(0, lv.tiles_x()))
        t = time.perf_counter()
        ds.tile(level, c, ty, tx)
        out.append(time.perf_counter() - t)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--cache-dir", type=Path, default=default_cache_dir())
    ap.add_argument("--discard", action="store_true", help="delete the pyramid afterwards")
    ap.add_argument("--full-res-cache", action="store_true", help="also copy full-resolution tiles into the cache")
    args = ap.parse_args()

    t = time.perf_counter()
    src = TiffSource(args.image)
    info = src.info
    print(f"image           {info.name}: {info.width} x {info.height} x {len(info.channels)} ch, {info.dtype}, "
          f"{info.layout.value}, {info.vendor}")
    print(f"open+metadata   {(time.perf_counter() - t) * 1e3:.0f} ms   channels "
          + ", ".join(f"{c.name} {c.excitation_nm:g}/{c.emission_nm:g}" if c.emission_nm else c.name
                      for c in info.channels)
          + (f"   {info.pixel_size_um:.4f} um/px" if info.pixel_size_um else ""))

    cache = PyramidCache(args.cache_dir, 20_000_000_000)
    key = cache.key_for(args.image)
    cache.discard(key)
    ds = Dataset(key, src, cache, EventBus(), cache_full_resolution=args.full_res_cache)
    print(f"L0 cold         {ms(sample_tiles(ds, 0, 16, seed=1))}   (new 512-row band read from the source)")
    print(f"L0 warm         {ms(sample_tiles(ds, 0, 16, seed=1))}   (same bands, from memory)")

    marks: list[tuple[float, float]] = []
    t0 = time.perf_counter()
    publish = ds._on_progress

    def hook(p):
        marks.append((time.perf_counter() - t0, p.fraction))
        publish(p)

    ds._on_progress = hook
    ds.build()
    total = time.perf_counter() - t0
    if ds.state != "ready":
        raise SystemExit(f"build {ds.state}: {ds.error}")
    src_bytes = info.width * info.height * len(info.channels) * np.dtype(info.dtype).itemsize
    half = next(t for t, f in marks if f >= 0.5)
    print(f"pyramid build   first band on disk after {marks[0][0] * 1e3:.0f} ms, 50% after {half:.1f} s, "
          f"complete in {total:.1f} s  ({src_bytes / 2**20 / total:.0f} MiB/s of source, {len(ds.levels)} levels)")
    print("build timings   " + "   ".join(f"{k} {v:.1f} s" for k, v in ds.builder.timings.items()))
    meta = cache.meta(key) or {}
    print(f"cache           {meta.get('bytes', 0) / 1e9:.2f} GB at {cache.dir(key)}")
    for level in (1, 2, len(ds.levels) - 1):
        print(f"L{level} from cache  {ms(sample_tiles(ds, level, 64, seed=level + 10))}")
    for c, ch in enumerate(info.channels):
        h = ds.histogram(c)
        p = h["percentiles"]
        print(f"histogram {ch.name:5s} min {h['min']:5d}  p0.5 {p['0.5']:5d}  p99.8 {p['99.8']:5d}  max {h['max']:5d}  "
              f"saturated {h['saturated'] / h['total']:.3%}")
    if args.discard:
        cache.discard(key)
    src.close()


if __name__ == "__main__":
    main()

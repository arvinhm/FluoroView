/**
 * Zoom levels and exact histograms, computed as the engine computes them (pyramid/store.py,
 * pyramid/builder.py, pyramid/kernels.py and datasets.histogram_summary), so a scan looks and
 * measures the same in the browser as in the installed app.
 */

import type { Histogram, LevelInfo } from "../api/types";
import type { Pixels } from "./source";

export const TILE = 512;
const PERCENTILES: [string, number][] = [
  ["0.1", 0.1], ["0.5", 0.5], ["1.0", 1.0], ["50.0", 50.0], ["99.0", 99.0], ["99.5", 99.5], ["99.8", 99.8], ["99.9", 99.9],
];

export function planLevels(width: number, height: number, tile = TILE): LevelInfo[] {
  const levels: LevelInfo[] = [{ index: 0, width, height }];
  for (let last = levels[0]!; Math.max(last.width, last.height) > tile; last = levels[levels.length - 1]!) {
    levels.push({ index: last.index + 1, width: (last.width + 1) >> 1, height: (last.height + 1) >> 1 });
  }
  return levels;
}

/** Rows per band: a multiple of the tile height that halves evenly down to the last level. */
export function bandRowsFor(nLevels: number, tile = TILE): number {
  const need = Math.max(tile, 2 ** (nLevels - 1));
  return Math.ceil(need / tile) * tile;
}

/** 2×2 area mean with round-half-up; odd edges average the pixels that exist. */
export function downsample2(a: Pixels, width: number, height: number): { data: Pixels; width: number; height: number } {
  const ow = (width + 1) >> 1;
  const oh = (height + 1) >> 1;
  const out = a instanceof Uint16Array ? new Uint16Array(ow * oh) : new Uint8Array(ow * oh);
  const even = width >> 1;
  for (let oy = 0; oy < oh; oy++) {
    const r0 = 2 * oy * width;
    const r1 = Math.min(2 * oy + 1, height - 1) * width;
    const o = oy * ow;
    for (let ox = 0; ox < even; ox++) {
      const x = 2 * ox;
      out[o + ox] = (a[r0 + x]! + a[r0 + x + 1]! + a[r1 + x]! + a[r1 + x + 1]! + 2) >> 2;
    }
    if (ow > even) {
      const x = width - 1;
      out[o + even] = (2 * a[r0 + x]! + 2 * a[r1 + x]! + 2) >> 2;
    }
  }
  return { data: out, width: ow, height: oh };
}

export function accumulate(a: Pixels, counts: Float64Array): void {
  for (let i = 0; i < a.length; i++) counts[a[i]!]!++;
}

/** The engine's histogram summary: counts rebinned to `bins`, and percentiles that leave out saturated pixels. */
export function histogramSummary(counts: Float64Array, saturation: number | null, bins: number, complete: boolean): Histogram {
  let lo = -1;
  let hi = -1;
  let total = 0;
  for (let v = 0; v < counts.length; v++) {
    const n = counts[v]!;
    if (!n) continue;
    if (lo < 0) lo = v;
    hi = v;
    total += n;
  }
  if (lo < 0) {
    return { complete, total: 0, counts: [], range: [0, 1], min: 0, max: 0, saturated: 0, saturation, percentiles: {} };
  }
  const limit = saturation !== null && saturation < counts.length ? saturation : counts.length;
  let saturated = 0;
  for (let v = limit; v < counts.length; v++) saturated += counts[v]!;
  const usable = total - saturated;
  const percentiles: Record<string, number> = {};
  for (const [key, p] of PERCENTILES) {
    if (!usable) {
      percentiles[key] = 0;
      continue;
    }
    const target = (usable * p) / 100;
    let cdf = 0;
    let v = 0;
    for (; v < limit; v++) {
      cdf += counts[v]!;
      if (cdf >= target) break;
    }
    percentiles[key] = Math.min(v, counts.length - 1);
  }
  const span = hi + 1;
  const out: number[] = [];
  if (span <= bins) {
    for (let v = 0; v < span; v++) out.push(counts[v]!);
  } else {
    const step = span / bins;
    for (let b = 0; b < bins; b++) {
      const start = Math.floor(b * step);
      const end = b + 1 < bins ? Math.floor((b + 1) * step) : span;
      let sum = 0;
      for (let v = start; v < end; v++) sum += counts[v]!;
      out.push(sum);
    }
  }
  return {
    complete, total, counts: out, range: [0, span], min: lo, max: hi, saturated, saturation, percentiles,
  };
}

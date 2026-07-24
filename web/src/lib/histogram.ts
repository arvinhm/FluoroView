import type { ChannelHistogram } from "./types";

/**
 * Bin an intensity raster into a histogram and derive a percentile-stretch
 * "auto" contrast window. Used for the per-channel histogram + auto-contrast
 * controls on both the Viv pyramid path (coarsest-level raster) and the
 * synthetic compositor path (in-memory intensity maps).
 */
export function binHistogram(
  data: ArrayLike<number>,
  bins = 128,
  domainHint?: [number, number]
): ChannelHistogram {
  const n = data.length;
  let min = domainHint ? domainHint[0] : Number.POSITIVE_INFINITY;
  let max = domainHint ? domainHint[1] : Number.NEGATIVE_INFINITY;
  if (!domainHint) {
    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (max <= min) max = min + 1;

  const counts = new Array<number>(bins).fill(0);
  const scale = (bins - 1) / (max - min);
  for (let i = 0; i < n; i++) {
    let b = ((data[i] - min) * scale) | 0;
    if (b < 0) b = 0;
    else if (b >= bins) b = bins - 1;
    counts[b]++;
  }

  const auto = percentileWindow(counts, min, max, n);
  let peak = 0;
  for (const c of counts) if (c > peak) peak = c;

  return { bins: counts, domain: [min, max], auto, peak };
}

/**
 * Fiji/Avivator-style saturated-percentile window: clip the lowest `loFrac`
 * and highest `1 - hiFrac` of the cumulative mass. Robust to the large zero /
 * background peak typical of fluorescence.
 */
function percentileWindow(
  counts: number[],
  min: number,
  max: number,
  total: number,
  loFrac = 0.02,
  hiFrac = 0.998
): [number, number] {
  const bins = counts.length;
  const binToValue = (b: number) => min + ((max - min) * b) / (bins - 1);
  const loTarget = total * loFrac;
  const hiTarget = total * hiFrac;
  let cum = 0;
  let lo = min;
  let hi = max;
  let loSet = false;
  for (let b = 0; b < bins; b++) {
    cum += counts[b];
    if (!loSet && cum >= loTarget) {
      lo = binToValue(b);
      loSet = true;
    }
    if (cum >= hiTarget) {
      hi = binToValue(b);
      break;
    }
  }
  if (hi <= lo) hi = lo + Math.max(1, (max - min) * 0.05);
  return [lo, hi];
}

/**
 * Compute a channel histogram from a Viv pixel-source pyramid using the
 * COARSEST level (a few thousand pixels — decodes in ~1 frame). `getRaster`
 * returns a typed array of raw intensities in the image dtype's units.
 */
export async function histogramFromLoader(
  loader: { getRaster: (opts: { selection: unknown }) => Promise<{ data: ArrayLike<number> }> }[],
  selection: { c: number; z: number; t: number },
  bins = 128,
  domainHint?: [number, number]
): Promise<ChannelHistogram> {
  const coarsest = loader[loader.length - 1];
  const { data } = await coarsest.getRaster({ selection });
  return binHistogram(data, bins, domainHint);
}

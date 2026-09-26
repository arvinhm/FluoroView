import type { Histogram } from "../api/types";

export const AUTO_LOW = "0.5";
export const AUTO_HIGH = "99.8";

/** Display window from exact whole-image percentiles; saturated pixels are already excluded. */
export function autoWindow(h: Histogram, low = AUTO_LOW, high = AUTO_HIGH): [number, number] {
  const lo = h.percentiles[low] ?? h.min;
  let hi = h.percentiles[high] ?? h.max;
  if (hi <= lo) hi = Math.max(lo + 1, h.max);
  return [lo, hi];
}

export function dtypeMax(dtype: string): number {
  return dtype.endsWith("u1") ? 255 : 65535;
}

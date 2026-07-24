/** Round down to a "nice" 1/2/5 × 10^n value near x (for scale bars, ticks). */
export function niceNumber(x: number): number {
  if (!isFinite(x) || x <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / pow;
  const nice = f >= 5 ? 5 : f >= 2 ? 2 : 1;
  return nice * pow;
}

/** Compact number formatting for stats/labels. */
export function fmt(x: number, digits = 2): string {
  if (!isFinite(x)) return "–";
  if (Math.abs(x) >= 1000) return x.toLocaleString();
  return x.toFixed(digits);
}

/**
 * Format an area (given in image px²) using the pixel-size calibration when
 * available: µm² below 1 mm², mm² above it; falls back to px² when uncalibrated
 * (never fabricates physical units).
 */
export function formatArea(areaPx: number, pixelSizeUm: number | null): string {
  if (pixelSizeUm && pixelSizeUm > 0) {
    const um2 = areaPx * pixelSizeUm * pixelSizeUm;
    if (um2 >= 1e6) return `${(um2 / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} mm²`;
    return `${Math.round(um2).toLocaleString()} µm²`;
  }
  return `${Math.round(areaPx).toLocaleString()} px²`;
}

/** Relative time like "just now", "3m ago", "2h ago", or a date. */
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleString();
}

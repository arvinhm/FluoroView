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

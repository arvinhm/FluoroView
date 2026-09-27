const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function fmtInt(v: number): string {
  return int.format(v);
}

export function fmt1(v: number): string {
  return one.format(v);
}

/** Area from the pixel count and, when the pixel size is known, square micrometres. */
export function fmtArea(px: number, um2: number | null): string {
  if (um2 === null) return `${int.format(px)} px`;
  if (um2 >= 1e6) return `${+(um2 / 1e6).toPrecision(3)} mm²`;
  return `${int.format(um2)} µm²`;
}

export function fmtSigned(v: number): string {
  return `${v < 0 ? "−" : "+"}${one.format(Math.abs(v))}`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

export function fmtPercent(fraction: number, digits = 2): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function fmtZoom(scale: number): string {
  const pct = scale * 100;
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

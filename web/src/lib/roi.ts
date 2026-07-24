import type { Cell, RoiShape } from "./types";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function roiBounds(s: RoiShape): Bounds {
  if (s.kind === "rect") return { x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.kind === "circle") return { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 };
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const [x, y] of s.points) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
}

export function pointInShape(s: RoiShape, x: number, y: number): boolean {
  if (s.kind === "rect") return x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;
  if (s.kind === "circle") {
    const dx = x - s.cx;
    const dy = y - s.cy;
    return dx * dx + dy * dy <= s.r * s.r;
  }
  const p = s.points;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0];
    const yi = p[i][1];
    const xj = p[j][0];
    const yj = p[j][1];
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Area in image px². */
export function shapeArea(s: RoiShape): number {
  if (s.kind === "rect") return Math.abs(s.w * s.h);
  if (s.kind === "circle") return Math.PI * s.r * s.r;
  let a = 0;
  const p = s.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  }
  return Math.abs(a / 2);
}

export function translateShape(s: RoiShape, dx: number, dy: number): RoiShape {
  if (s.kind === "rect") return { ...s, x: s.x + dx, y: s.y + dy };
  if (s.kind === "circle") return { ...s, cx: s.cx + dx, cy: s.cy + dy };
  return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
}

export function cellsInRoi(cells: Cell[], s: RoiShape): Cell[] {
  return cells.filter((c) => pointInShape(s, c.x, c.y));
}

export function shapeKindLabel(s: RoiShape): string {
  return s.kind === "rect" ? "Rectangle" : s.kind === "circle" ? "Circle" : "Polygon";
}

export interface ChannelStat {
  mean: number;
  sem: number;
  sd: number;
  median: number;
  min: number;
  max: number;
  n: number;
}

/** Per-channel intensity statistics over a set of cells. */
export function channelStats(cells: Cell[], channel: number): ChannelStat {
  const vals: number[] = [];
  for (const c of cells) {
    const v = c.markers[channel];
    if (v != null && !Number.isNaN(v)) vals.push(v);
  }
  const n = vals.length;
  if (n === 0) return { mean: 0, sem: 0, sd: 0, median: 0, min: 0, max: 0, n: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const sem = sd / Math.sqrt(n);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  return { mean, sem, sd, median, min: sorted[0], max: sorted[n - 1], n };
}

/**
 * Region geometry in full-resolution image pixels. Containment matches the engine's rasterization
 * (rectangles half-open, ellipses analytic, polygons even-odd), so what is outlined is what is measured.
 */

import type { Point, Region, RegionShape } from "../api/types";

/** x0, y0, x1, y1 with x0 <= x1 and y0 <= y1 */
export type Box = [number, number, number, number];

/** Polygons with more vertices than this are moved as a whole, not edited vertex by vertex. */
export const MAX_VERTEX_HANDLES = 400;
const ELLIPSE_SEGMENTS = 96;

export function bbox(points: readonly Point[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

const boxes = new WeakMap<Region, Box>();

/** Bounding box of a region, cached per region object (regions are replaced, never mutated). */
export function regionBox(region: Region): Box {
  let b = boxes.get(region);
  if (!b) boxes.set(region, (b = bbox(region.points)));
  return b;
}

function evenOdd(points: readonly Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function contains(shape: RegionShape, points: readonly Point[], x: number, y: number): boolean {
  switch (shape) {
    case "rectangle": {
      const [x0, y0, x1, y1] = bbox(points);
      return x >= x0 && x < x1 && y >= y0 && y < y1;
    }
    case "ellipse": {
      const [x0, y0, x1, y1] = bbox(points);
      const rx = (x1 - x0) / 2;
      const ry = (y1 - y0) / 2;
      const ex = (x - x0 - rx) / rx;
      const ey = (y - y0 - ry) / ry;
      return ex * ex + ey * ey <= 1;
    }
    case "polygon":
    case "freehand":
      return evenOdd(points, x, y);
    default: {
      const unreachable: never = shape;
      throw new Error(`unknown shape ${unreachable}`);
    }
  }
}

/** Closed outline as a polygon: the corners of a rectangle, a fine polygon for an ellipse. */
export function outline(shape: RegionShape, points: readonly Point[]): Point[] {
  switch (shape) {
    case "rectangle": {
      const [x0, y0, x1, y1] = bbox(points);
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    }
    case "ellipse": {
      const [x0, y0, x1, y1] = bbox(points);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      return Array.from({ length: ELLIPSE_SEGMENTS }, (_, i): Point => {
        const a = (2 * Math.PI * i) / ELLIPSE_SEGMENTS;
        return [cx + ((x1 - x0) / 2) * Math.cos(a), cy + ((y1 - y0) / 2) * Math.sin(a)];
      });
    }
    case "polygon":
    case "freehand":
      return points.slice();
    default: {
      const unreachable: never = shape;
      throw new Error(`unknown shape ${unreachable}`);
    }
  }
}

export function segmentDistance(px: number, py: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

export function outlineDistance(shape: RegionShape, points: readonly Point[], x: number, y: number): number {
  const ring = outline(shape, points);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, segmentDistance(x, y, ring[j]!, ring[i]!));
  }
  return best;
}

/** Enclosed area in square pixels (continuous geometry, used for ordering hits). */
export function area(shape: RegionShape, points: readonly Point[]): number {
  switch (shape) {
    case "rectangle": {
      const [x0, y0, x1, y1] = bbox(points);
      return (x1 - x0) * (y1 - y0);
    }
    case "ellipse": {
      const [x0, y0, x1, y1] = bbox(points);
      return (Math.PI * (x1 - x0) * (y1 - y0)) / 4;
    }
    case "polygon":
    case "freehand": {
      let s = 0;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        s += points[j]![0] * points[i]![1] - points[i]![0] * points[j]![1];
      }
      return Math.abs(s) / 2;
    }
    default: {
      const unreachable: never = shape;
      throw new Error(`unknown shape ${unreachable}`);
    }
  }
}

/**
 * Region under (x, y). An outline within `tol` wins (closest first), so a small region inside a
 * large one stays reachable; otherwise the smallest region containing the point.
 */
export function hitRegion(regions: readonly Region[], x: number, y: number, tol: number): string | null {
  let edge: { id: string; d: number } | null = null;
  let inner: { id: string; a: number } | null = null;
  for (const r of regions) {
    const [x0, y0, x1, y1] = regionBox(r);
    if (x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol) continue;
    const d = outlineDistance(r.shape, r.points, x, y);
    if (d <= tol && (!edge || d < edge.d)) edge = { id: r.id, d };
    if (!edge && contains(r.shape, r.points, x, y)) {
      const a = area(r.shape, r.points);
      if (!inner || a < inner.a) inner = { id: r.id, a };
    }
  }
  return edge?.id ?? inner?.id ?? null;
}

/** Draggable points: the four box corners of rectangles and ellipses, the vertices of polygons. */
export function handles(region: Region): Point[] {
  switch (region.shape) {
    case "rectangle":
    case "ellipse": {
      const [x0, y0, x1, y1] = regionBox(region);
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    }
    case "polygon":
      return region.points.length <= MAX_VERTEX_HANDLES ? region.points.slice() : [];
    case "freehand":
      return [];
    default: {
      const unreachable: never = region.shape;
      throw new Error(`unknown shape ${unreachable}`);
    }
  }
}

export function snap(p: Point): Point {
  return [Math.round(p[0]), Math.round(p[1])];
}

/**
 * Corners of a box dragged from `a` to `b`, on whole pixels. `square` keeps width and height
 * equal; `fromCenter` grows the box around `a`.
 */
export function dragBox(a: Point, b: Point, square: boolean, fromCenter: boolean): [Point, Point] {
  const [ax, ay] = snap(a);
  const [bx, by] = snap(b);
  let dx = bx - ax;
  let dy = by - ay;
  if (square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * m;
    dy = (dy < 0 ? -1 : 1) * m;
  }
  return fromCenter ? [[ax - dx, ay - dy], [ax + dx, ay + dy]] : [[ax, ay], [ax + dx, ay + dy]];
}

/** New points after dragging handle `index` of `region` to `p`. */
export function moveHandle(region: Region, index: number, p: Point, square: boolean): Point[] {
  if (region.shape === "rectangle" || region.shape === "ellipse") {
    const corners = handles(region);
    const opposite = corners[(index + 2) % 4]!;
    return dragBox(opposite, p, square, false);
  }
  return region.points.map((q, i): Point => (i === index ? p : q));
}

export function translate(points: readonly Point[], dx: number, dy: number): Point[] {
  return points.map(([x, y]): Point => [x + dx, y + dy]);
}

export function hasArea(shape: RegionShape, points: readonly Point[]): boolean {
  if (shape === "rectangle" || shape === "ellipse") {
    const [x0, y0, x1, y1] = bbox(points);
    return x1 - x0 >= 1 && y1 - y0 >= 1;
  }
  return points.length >= 3 && area(shape, points) > 0;
}

/** Ramer–Douglas–Peucker: drop points that deviate less than `tol` from the simplified path. */
export function simplify(points: readonly Point[], tol: number): Point[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let worst = -1;
    let dmax = tol;
    for (let k = i + 1; k < j; k++) {
      const d = segmentDistance(points[k]![0], points[k]![1], points[i]!, points[j]!);
      if (d > dmax) {
        dmax = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return points.filter((_, k) => keep[k] === 1);
}

/** Keep a line horizontal, vertical or diagonal, as with Shift in drawing tools. */
export function constrainAngle(a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = Math.hypot(dx, dy);
  return [a[0] + len * Math.cos(angle), a[1] + len * Math.sin(angle)];
}

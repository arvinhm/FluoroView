/**
 * Regions, notes, the profile line and drawings in progress, painted with Canvas2D over the image in
 * the same animation frame, once per gallery panel. Everything is in device pixels.
 */

import type { Annotation, CountPoint, Point, Region, RegionShape } from "../api/types";
import { type Camera, formatLength } from "./camera";
import type { Rect } from "./gallery";
import { bbox, type Box, handles, regionBox } from "./geometry";
import type { Draft } from "./tools";

export interface OverlayPanel {
  rect: Rect;
  cam: Camera;
  /** channels whose raw values are printed in each pixel at deep zoom */
  values: { index: number; color: string }[];
}

/** Height of the line-profile drawer over the bottom of the viewer, CSS px. */
export const PROFILE_DRAWER_CSS = 212;

/** A box in CSS pixels relative to the viewer, for DOM elements that follow the image. */
export interface Anchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bounds {
  w: number;
  h: number;
}

function overlap(a: Anchor, b: Anchor): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where to put a `w` x `h` panel next to `target`: right, left, below or above it, kept inside
 * `bounds`. The choice covers the target least, then the `avoid` boxes least; ties keep that order.
 */
export function placeBeside(target: Anchor, w: number, h: number, bounds: Bounds, avoid: readonly Anchor[],
  gap = 14, margin = 10, bottomClear = 0): { x: number; y: number } {
  const clampX = (x: number) => Math.max(margin, Math.min(x, bounds.w - w - margin));
  const clampY = (y: number) => Math.max(margin, Math.min(y, bounds.h - h - bottomClear));
  const cx = target.x + target.w / 2 - w / 2;
  const candidates = [
    { x: target.x + target.w + gap, y: target.y },
    { x: target.x - gap - w, y: target.y },
    { x: cx, y: target.y + target.h + gap },
    { x: cx, y: target.y - gap - h },
  ].map((c) => ({ x: clampX(c.x), y: clampY(c.y) }));
  let best = candidates[0]!;
  let bestScore = Infinity;
  for (const c of candidates) {
    const box = { x: c.x, y: c.y, w, h };
    const score = overlap(box, target) * 1000 + avoid.reduce((sum, a) => sum + overlap(box, a), 0);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export interface OverlayScene {
  /** raw full-resolution value, or null when that tile is not loaded */
  valueAt: (x: number, y: number, c: number) => number | null;
  imageSize: [number, number];
  regions: readonly Region[];
  /** Cell Counter points, and the colour of each category */
  points: readonly CountPoint[];
  counterColors: ReadonlyMap<string, string>;
  background: string | null;
  selected: string | null;
  /** further selected regions (⇧-click); highlighted, without handles */
  also: readonly string[];
  hover: string | null;
  notes: readonly Annotation[];
  selectedNote: string | null;
  noteDraft: Point | null;
  draft: Draft | null;
  line: { x0: number; y0: number; x1: number; y1: number } | null;
  marker: Point | null;
  handles: boolean;
  pixelSize: number | null;
  accent: string;
  accentInk: string;
  dpr: number;
}

const HALO = "rgba(0, 0, 0, 0.62)";
const INK = "#0c0d0f";
const TEXT = "#ededef";
const LABEL_BG = "rgba(7, 7, 8, 0.82)";
const LABEL_EDGE = "#2a2b31";
const FONT = '"IBM Plex Sans", -apple-system, system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
/** Regions narrower than this (CSS px) on screen get no name label. */
const LABEL_MIN_CSS = 44;
/** Pixels at least this wide (CSS px) show their raw values; one line per channel that fits. */
export const VALUES_FROM_CSS = 32;
const VALUE_LINE_CSS = 11.5;

export class PanelView {
  constructor(readonly rect: Rect, readonly cam: Camera) {}

  x(ix: number): number {
    return this.rect.x + (ix - this.cam.cx) * this.cam.scale + this.rect.width / 2;
  }

  y(iy: number): number {
    return this.rect.y + (iy - this.cam.cy) * this.cam.scale + this.rect.height / 2;
  }

  /** Visible image area of the panel, in image pixels. */
  bounds(): Box {
    const hw = this.rect.width / 2 / this.cam.scale;
    const hh = this.rect.height / 2 / this.cam.scale;
    return [this.cam.cx - hw, this.cam.cy - hh, this.cam.cx + hw, this.cam.cy + hh];
  }
}

export function withAlpha(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
}

function trace(ctx: CanvasRenderingContext2D, v: PanelView, shape: RegionShape, points: readonly Point[], box: Box): void {
  const s = v.cam.scale;
  const [x0, y0, x1, y1] = box;
  ctx.beginPath();
  switch (shape) {
    case "rectangle":
      ctx.rect(v.x(x0), v.y(y0), (x1 - x0) * s, (y1 - y0) * s);
      return;
    case "ellipse":
      ctx.ellipse(v.x((x0 + x1) / 2), v.y((y0 + y1) / 2), ((x1 - x0) / 2) * s, ((y1 - y0) / 2) * s, 0, 0, 2 * Math.PI);
      return;
    case "polygon":
    case "freehand":
      polyline(ctx, v, points);
      ctx.closePath();
      return;
    default: {
      const unreachable: never = shape;
      throw new Error(`unknown shape ${unreachable}`);
    }
  }
}

/** Screen-space decimation: consecutive points closer than ~1 device px are skipped. */
function polyline(ctx: CanvasRenderingContext2D, v: PanelView, points: readonly Point[]): void {
  let lx = 0;
  let ly = 0;
  points.forEach(([x, y], i) => {
    const sx = v.x(x);
    const sy = v.y(y);
    if (i === 0) ctx.moveTo(sx, sy);
    else if (Math.abs(sx - lx) + Math.abs(sy - ly) < 0.9 && i < points.length - 1) return;
    else ctx.lineTo(sx, sy);
    lx = sx;
    ly = sy;
  });
}

function stroke(ctx: CanvasRenderingContext2D, color: string, width: number, dpr: number, dash: number[] = []): void {
  ctx.setLineDash(dash);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = width + 2 * dpr;
  ctx.strokeStyle = HALO;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Small text tag with its top-left corner at (x, y), kept inside the panel. */
function tag(ctx: CanvasRenderingContext2D, v: PanelView, x: number, y: number, text: string, s: OverlayScene,
  opts: { mono?: boolean; accent?: boolean; above?: boolean } = {}): void {
  const d = s.dpr;
  ctx.font = opts.mono ? `500 ${10.5 * d}px ${MONO}` : `500 ${11 * d}px ${FONT}`;
  const w = ctx.measureText(text).width + 12 * d;
  const h = 18 * d;
  const { rect } = v;
  const left = Math.min(Math.max(x, rect.x + 4 * d), rect.x + rect.width - w - 4 * d);
  const top = Math.min(Math.max(opts.above ? y - h : y, rect.y + 4 * d), rect.y + rect.height - h - 4 * d);
  ctx.beginPath();
  ctx.roundRect(left, top, w, h, 3 * d);
  ctx.fillStyle = LABEL_BG;
  ctx.fill();
  ctx.lineWidth = d;
  ctx.strokeStyle = opts.accent ? s.accent : LABEL_EDGE;
  ctx.stroke();
  ctx.fillStyle = TEXT;
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + 6 * d, top + h / 2 + 0.5 * d);
}

function size(w: number, h: number, pixelSize: number | null): string {
  return pixelSize ? `${formatLength(w * pixelSize)} × ${formatLength(h * pixelSize)}`
    : `${Math.round(w)} × ${Math.round(h)} px`;
}

function drawRegions(ctx: CanvasRenderingContext2D, v: PanelView, s: OverlayScene): void {
  const d = s.dpr;
  const [vx0, vy0, vx1, vy1] = v.bounds();
  const labels: { x: number; y: number; text: string; accent: boolean }[] = [];
  let selected: Region | undefined;
  for (const r of s.regions) {
    const box = regionBox(r);
    const [x0, y0, x1, y1] = box;
    if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
    const isSel = r.id === s.selected || s.also.includes(r.id);
    const isHover = r.id === s.hover;
    const isBg = r.id === s.background;
    if (r.id === s.selected) selected = r;
    const color = isSel ? s.accent : r.color;
    const w = (x1 - x0) * v.cam.scale;
    const h = (y1 - y0) * v.cam.scale;
    if (w < 3 * d && h < 3 * d) {
      ctx.beginPath();
      ctx.arc(v.x((x0 + x1) / 2), v.y((y0 + y1) / 2), 2 * d, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      continue;
    }
    trace(ctx, v, r.shape, r.points, box);
    for (const ring of r.rings ?? []) {
      polyline(ctx, v, ring);
      ctx.closePath();
    }
    if (isSel || isHover) {
      ctx.fillStyle = isSel ? withAlpha(s.accent, 0.1) : "rgba(255, 255, 255, 0.05)";
      ctx.fill("evenodd");
    }
    stroke(ctx, color, (isSel ? 2 : isHover ? 1.75 : 1.25) * d, d, isBg ? [5 * d, 4 * d] : []);
    if (isSel || w >= LABEL_MIN_CSS * d) {
      labels.push({ x: v.x(x0), y: v.y(y0) - 5 * d, text: isBg ? `${r.name} · background` : r.name, accent: isSel });
    }
  }
  for (const l of labels) tag(ctx, v, l.x, l.y, l.text, s, { accent: l.accent, above: true });
  if (selected && s.handles) {
    const box = selected.shape === "rectangle" || selected.shape === "ellipse";
    for (const [hx, hy] of handles(selected)) {
      const x = v.x(hx);
      const y = v.y(hy);
      ctx.beginPath();
      if (box) ctx.rect(x - 3.5 * d, y - 3.5 * d, 7 * d, 7 * d);
      else ctx.arc(x, y, 3.5 * d, 0, 2 * Math.PI);
      ctx.fillStyle = INK;
      ctx.fill();
      ctx.lineWidth = 1.5 * d;
      ctx.strokeStyle = s.accent;
      ctx.stroke();
    }
  }
}

function endpoint(ctx: CanvasRenderingContext2D, x: number, y: number, s: OverlayScene): void {
  ctx.beginPath();
  ctx.arc(x, y, 4 * s.dpr, 0, 2 * Math.PI);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.lineWidth = 1.5 * s.dpr;
  ctx.strokeStyle = s.accent;
  ctx.stroke();
}

function drawLine(ctx: CanvasRenderingContext2D, v: PanelView, l: NonNullable<OverlayScene["line"]>, s: OverlayScene): void {
  const d = s.dpr;
  const [ax, ay, bx, by] = [v.x(l.x0), v.y(l.y0), v.x(l.x1), v.y(l.y1)];
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  stroke(ctx, s.accent, 1.5 * d, d);
  endpoint(ctx, ax, ay, s);
  endpoint(ctx, bx, by, s);
  const len = Math.hypot(l.x1 - l.x0, l.y1 - l.y0);
  tag(ctx, v, bx + 10 * d, by + 6 * d, s.pixelSize ? formatLength(len * s.pixelSize) : `${Math.round(len)} px`, s, { mono: true });
}

function drawDraft(ctx: CanvasRenderingContext2D, v: PanelView, draft: Draft, s: OverlayScene): void {
  const d = s.dpr;
  switch (draft.kind) {
    case "box": {
      const box = bbox(draft.corners);
      trace(ctx, v, draft.shape, draft.corners, box);
      ctx.fillStyle = withAlpha(s.accent, 0.1);
      ctx.fill();
      stroke(ctx, s.accent, 1.5 * d, d);
      const w = box[2] - box[0];
      const h = box[3] - box[1];
      if (w > 0 && h > 0) tag(ctx, v, v.x(box[2]) + 8 * d, v.y(box[3]) + 8 * d, size(w, h, s.pixelSize), s, { mono: true });
      return;
    }
    case "path": {
      ctx.beginPath();
      polyline(ctx, v, draft.points);
      if (draft.cursor) ctx.lineTo(v.x(draft.cursor[0]), v.y(draft.cursor[1]));
      stroke(ctx, s.accent, 1.5 * d, d);
      if (draft.shape === "polygon") {
        draft.points.forEach(([x, y], i) => {
          const r = (i === 0 && draft.closing ? 5.5 : 3) * d;
          ctx.beginPath();
          ctx.arc(v.x(x), v.y(y), r, 0, 2 * Math.PI);
          ctx.fillStyle = i === 0 && draft.closing ? withAlpha(s.accent, 0.35) : INK;
          ctx.fill();
          ctx.lineWidth = 1.5 * d;
          ctx.strokeStyle = s.accent;
          ctx.stroke();
        });
      }
      return;
    }
    case "line":
      drawLine(ctx, v, { x0: draft.a[0], y0: draft.a[1], x1: draft.b[0], y1: draft.b[1] }, s);
      return;
    default: {
      const unreachable: never = draft;
      throw new Error(`unknown draft ${JSON.stringify(unreachable)}`);
    }
  }
}

function pin(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, active: boolean, s: OverlayScene): void {
  const d = s.dpr;
  ctx.beginPath();
  ctx.arc(x, y, 8 * d, 0, 2 * Math.PI);
  ctx.fillStyle = active ? s.accent : TEXT;
  ctx.fill();
  ctx.lineWidth = 1.5 * d;
  ctx.strokeStyle = HALO;
  ctx.stroke();
  ctx.fillStyle = active ? s.accentInk : INK;
  ctx.fillText(label, x, y + 0.5 * d);
}

function drawCountPoints(ctx: CanvasRenderingContext2D, v: PanelView, s: OverlayScene): void {
  if (!s.points.length) return;
  const d = s.dpr;
  const [x0, y0, x1, y1] = v.bounds();
  const r = 3.5 * d;
  ctx.lineWidth = 1.25 * d;
  ctx.strokeStyle = HALO;
  for (const p of s.points) {
    if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
    ctx.beginPath();
    ctx.arc(v.x(p.x), v.y(p.y), r, 0, 2 * Math.PI);
    ctx.fillStyle = s.counterColors.get(p.counter) ?? TEXT;
    ctx.fill();
    ctx.stroke();
  }
}

function drawNotes(ctx: CanvasRenderingContext2D, v: PanelView, s: OverlayScene): void {
  const d = s.dpr;
  const { rect } = v;
  ctx.font = `600 ${9.5 * d}px ${MONO}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  s.notes.forEach((n, i) => {
    const x = v.x(n.x);
    const y = v.y(n.y);
    if (x < rect.x - 10 * d || y < rect.y - 10 * d || x > rect.x + rect.width + 10 * d || y > rect.y + rect.height + 10 * d) return;
    pin(ctx, x, y, String(i + 1), n.id === s.selectedNote, s);
  });
  if (s.noteDraft) pin(ctx, v.x(s.noteDraft[0]), v.y(s.noteDraft[1]), "+", true, s);
  ctx.textAlign = "start";
}

/** Raw values written inside each pixel, one line per channel in its colour, over a dark halo. */
function drawPixelValues(ctx: CanvasRenderingContext2D, v: PanelView, s: OverlayScene,
  channels: OverlayPanel["values"]): void {
  const d = s.dpr;
  const cellCss = v.cam.scale / d;
  if (!channels.length || cellCss < VALUES_FROM_CSS) return;
  const lines = Math.min(channels.length, Math.floor((cellCss - 6) / VALUE_LINE_CSS));
  if (lines < 1) return;
  const shown = channels.slice(0, lines);
  const [bx0, by0, bx1, by1] = v.bounds();
  const [w, h] = s.imageSize;
  const x0 = Math.max(0, Math.floor(bx0));
  const y0 = Math.max(0, Math.floor(by0));
  const x1 = Math.min(w - 1, Math.floor(bx1));
  const y1 = Math.min(h - 1, Math.floor(by1));
  const lineH = VALUE_LINE_CSS * d;
  ctx.font = `500 ${Math.min(11, 7 + cellCss / 16) * d}px ${MONO}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3 * d;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.72)";
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cx = v.x(x + 0.5);
      const cy = v.y(y + 0.5);
      shown.forEach((ch, i) => {
        const value = s.valueAt(x, y, ch.index);
        if (value === null) return;
        const ty = cy + (i - (shown.length - 1) / 2) * lineH;
        const text = String(value);
        ctx.strokeText(text, cx, ty);
        ctx.fillStyle = ch.color;
        ctx.fillText(text, cx, ty);
      });
    }
  }
  ctx.textAlign = "start";
}

export function drawOverlay(ctx: CanvasRenderingContext2D, panels: readonly OverlayPanel[], s: OverlayScene): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const p of panels) {
    const v = new PanelView(p.rect, p.cam);
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.rect.x, p.rect.y, p.rect.width, p.rect.height);
    ctx.clip();
    drawPixelValues(ctx, v, s, p.values);
    drawRegions(ctx, v, s);
    if (s.line) drawLine(ctx, v, s.line, s);
    if (s.marker) {
      ctx.beginPath();
      ctx.arc(v.x(s.marker[0]), v.y(s.marker[1]), 4.5 * s.dpr, 0, 2 * Math.PI);
      ctx.fillStyle = s.accent;
      ctx.fill();
      ctx.lineWidth = 2 * s.dpr;
      ctx.strokeStyle = HALO;
      ctx.stroke();
    }
    if (s.draft) drawDraft(ctx, v, s.draft, s);
    drawCountPoints(ctx, v, s);
    drawNotes(ctx, v, s);
    ctx.restore();
  }
}

/**
 * What pointer and key input does on the image for each tool. Drawing tools are one-shot: after a
 * shape is finished the Move tool is active again. In the Move tool, input the controller does not
 * take (empty image) pans the view.
 */

import type { Point } from "../api/types";
import {
  cancelNote, commitRegion, createRegion, deleteNote, deleteRegion, EMPTY_SCAN, editNote, previewNote, previewRegion,
  revertRegion, select, setLine, startNote, useProject,
} from "../state/project";
import { type Tool, useStudio } from "../state/store";
import {
  type Box, constrainAngle, dragBox, handles, hasArea, hitRegion, moveHandle, regionBox, simplify, translate,
} from "./geometry";

export interface PointerSample {
  /** full-resolution image position */
  x: number;
  y: number;
  /** device pixels per image pixel in the panel under the pointer */
  scale: number;
  dpr: number;
  shift: boolean;
  alt: boolean;
}

export type Draft =
  | { kind: "box"; shape: "rectangle" | "ellipse"; anchor: Point; corners: [Point, Point] }
  | { kind: "path"; shape: "polygon" | "freehand"; points: Point[]; cursor: Point | null; closing: boolean }
  | { kind: "line"; a: Point; b: Point };

type Gesture =
  | { kind: "draw" }
  | { kind: "move-region"; id: string; start: Point; origin: Point[]; moved: boolean }
  | { kind: "handle"; id: string; index: number; anchor: Point | null; origin: Point[] }
  | { kind: "line-end"; end: 0 | 1 }
  | { kind: "move-note"; id: string; start: Point; origin: Point; moved: boolean };

export type Hover =
  | { kind: "region"; id: string; selected: boolean }
  | { kind: "handle"; index: number; box: boolean }
  | { kind: "line-end" }
  | { kind: "note"; id: string }
  | null;

const HANDLE_CSS = 6;
const EDGE_CSS = 5;
const PIN_CSS = 9;
const CLOSE_CSS = 8;
const DRAG_START_CSS = 3;
const FREEHAND_STEP_CSS = 1.5;
const FREEHAND_TOL_CSS = 0.4;
const MIN_LINE_CSS = 4;

function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Index of the point closest to `p` within `tol`, or -1. Later points win ties (drawn on top). */
function nearest(points: readonly Point[], p: Point, tol: number): number {
  let best = -1;
  let bestD = tol;
  points.forEach((q, i) => {
    const d = dist(q, p);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

export class ToolController {
  draft: Draft | null = null;
  hover: Hover = null;
  private gesture: Gesture | null = null;

  constructor(
    private readonly dsId: string,
    private readonly changed: () => void,
    private readonly focus: (box: Box) => void,
  ) {}

  private get tool(): Tool {
    return useStudio.getState().tool;
  }

  private scan() {
    return useProject.getState().scans[this.dsId] ?? EMPTY_SCAN;
  }

  private region(id: string) {
    return this.scan().regions.find((r) => r.id === id);
  }

  private tol(p: PointerSample, css: number): number {
    return (css * p.dpr) / p.scale;
  }

  /** One-shot tools hand back to Move once their shape is done. */
  private finish(): void {
    this.draft = null;
    this.gesture = null;
    useStudio.getState().setTool("move");
    this.changed();
  }

  get busy(): boolean {
    return this.gesture !== null || this.draft !== null;
  }

  /** Returns false when the press is not for the controller, so the viewer pans instead. */
  down(p: PointerSample): boolean {
    const pt: Point = [p.x, p.y];
    const tool = this.tool;
    switch (tool) {
      case "move":
        return this.grab(p);
      case "rectangle":
      case "ellipse":
        this.draft = { kind: "box", shape: tool, anchor: pt, corners: [pt, pt] };
        this.gesture = { kind: "draw" };
        break;
      case "freehand":
        this.draft = { kind: "path", shape: "freehand", points: [pt], cursor: null, closing: false };
        this.gesture = { kind: "draw" };
        break;
      case "polygon":
        this.polygonClick(p);
        break;
      case "line":
        this.draft = { kind: "line", a: pt, b: pt };
        this.gesture = { kind: "draw" };
        break;
      case "note":
        startNote(pt);
        this.finish();
        return true;
      default: {
        const unreachable: never = tool;
        throw new Error(`unknown tool ${unreachable}`);
      }
    }
    this.changed();
    return true;
  }

  private target(p: PointerSample): Hover {
    const st = useProject.getState();
    const scan = this.scan();
    const pt: Point = [p.x, p.y];
    if (st.selection?.kind === "region") {
      const r = this.region(st.selection.id);
      if (r) {
        const i = nearest(handles(r), pt, this.tol(p, HANDLE_CSS));
        if (i >= 0) return { kind: "handle", index: i, box: r.shape === "rectangle" || r.shape === "ellipse" };
      }
    }
    const line = st.line;
    if (line?.dsId === this.dsId && nearest([[line.x0, line.y0], [line.x1, line.y1]], pt, this.tol(p, HANDLE_CSS)) >= 0) {
      return { kind: "line-end" };
    }
    const n = nearest(scan.notes.map((note): Point => [note.x, note.y]), pt, this.tol(p, PIN_CSS));
    if (n >= 0) return { kind: "note", id: scan.notes[n]!.id };
    const id = hitRegion(scan.regions, p.x, p.y, this.tol(p, EDGE_CSS));
    return id ? { kind: "region", id, selected: st.selection?.id === id } : null;
  }

  private grab(p: PointerSample): boolean {
    const hit = this.target(p);
    const pt: Point = [p.x, p.y];
    if (!hit) return false;
    switch (hit.kind) {
      case "handle": {
        const sel = useProject.getState().selection!;
        const r = this.region(sel.id)!;
        const anchor = hit.box ? handles(r)[(hit.index + 2) % 4]! : null;
        this.gesture = { kind: "handle", id: r.id, index: hit.index, anchor, origin: r.points };
        break;
      }
      case "line-end": {
        const l = useProject.getState().line!;
        this.gesture = { kind: "line-end", end: dist(pt, [l.x0, l.y0]) <= dist(pt, [l.x1, l.y1]) ? 0 : 1 };
        break;
      }
      case "note": {
        const note = this.scan().notes.find((n) => n.id === hit.id)!;
        select({ kind: "note", id: note.id });
        this.gesture = { kind: "move-note", id: note.id, start: pt, origin: [note.x, note.y], moved: false };
        break;
      }
      case "region": {
        const r = this.region(hit.id)!;
        select({ kind: "region", id: r.id });
        this.gesture = { kind: "move-region", id: r.id, start: pt, origin: r.points, moved: false };
        break;
      }
      default: {
        const unreachable: never = hit;
        throw new Error(`unknown target ${JSON.stringify(unreachable)}`);
      }
    }
    this.hover = hit;
    this.changed();
    return true;
  }

  move(p: PointerSample): void {
    const g = this.gesture;
    const pt: Point = [p.x, p.y];
    if (!g) {
      const d = this.draft;
      if (d?.kind === "path" && d.shape === "polygon") {
        d.cursor = pt;
        d.closing = d.points.length >= 3 && dist(pt, d.points[0]!) <= this.tol(p, CLOSE_CSS);
        this.changed();
        return;
      }
      const hover = this.tool === "move" ? this.target(p) : null;
      if (JSON.stringify(hover) !== JSON.stringify(this.hover)) {
        this.hover = hover;
        this.changed();
      }
      return;
    }
    switch (g.kind) {
      case "draw":
        this.extend(p);
        break;
      case "move-region": {
        const dx = p.x - g.start[0];
        const dy = p.y - g.start[1];
        if (!g.moved && Math.hypot(dx, dy) * p.scale < DRAG_START_CSS * p.dpr) return;
        g.moved = true;
        const r = this.region(g.id);
        if (!r) return;
        const whole = r.shape === "rectangle" || r.shape === "ellipse";
        previewRegion(this.dsId, g.id, translate(g.origin, whole ? Math.round(dx) : dx, whole ? Math.round(dy) : dy));
        break;
      }
      case "handle": {
        const r = this.region(g.id);
        if (!r) return;
        previewRegion(this.dsId, g.id, g.anchor ? dragBox(g.anchor, pt, p.shift, false) : moveHandle(r, g.index, pt, false));
        break;
      }
      case "line-end": {
        const l = useProject.getState().line;
        if (!l) return;
        const fixed: Point = g.end === 0 ? [l.x1, l.y1] : [l.x0, l.y0];
        const q = p.shift ? constrainAngle(fixed, pt) : pt;
        setLine(this.dsId, g.end === 0 ? { x0: q[0], y0: q[1], x1: l.x1, y1: l.y1 } : { x0: l.x0, y0: l.y0, x1: q[0], y1: q[1] });
        break;
      }
      case "move-note": {
        const dx = p.x - g.start[0];
        const dy = p.y - g.start[1];
        if (!g.moved && Math.hypot(dx, dy) * p.scale < DRAG_START_CSS * p.dpr) return;
        g.moved = true;
        previewNote(this.dsId, g.id, [g.origin[0] + dx, g.origin[1] + dy]);
        break;
      }
      default: {
        const unreachable: never = g;
        throw new Error(`unknown gesture ${JSON.stringify(unreachable)}`);
      }
    }
    this.changed();
  }

  private extend(p: PointerSample): void {
    const d = this.draft;
    const pt: Point = [p.x, p.y];
    if (!d) return;
    switch (d.kind) {
      case "box":
        d.corners = dragBox(d.anchor, pt, p.shift, p.alt);
        break;
      case "path": {
        const last = d.points[d.points.length - 1]!;
        if (dist(last, pt) >= this.tol(p, FREEHAND_STEP_CSS)) d.points.push(pt);
        break;
      }
      case "line":
        d.b = p.shift ? constrainAngle(d.a, pt) : pt;
        break;
      default: {
        const unreachable: never = d;
        throw new Error(`unknown draft ${JSON.stringify(unreachable)}`);
      }
    }
  }

  up(p: PointerSample): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    switch (g.kind) {
      case "draw":
        this.complete(p);
        return;
      case "move-region": {
        const r = this.region(g.id);
        if (g.moved && r) void commitRegion(this.dsId, g.id, r.points);
        break;
      }
      case "handle": {
        const r = this.region(g.id);
        if (r && hasArea(r.shape, r.points)) void commitRegion(this.dsId, g.id, r.points);
        else if (r) revertRegion(this.dsId, g.id, g.origin);
        break;
      }
      case "line-end":
        break;
      case "move-note": {
        const note = this.scan().notes.find((n) => n.id === g.id);
        if (g.moved && note) void editNote(this.dsId, g.id, { x: note.x, y: note.y });
        break;
      }
      default: {
        const unreachable: never = g;
        throw new Error(`unknown gesture ${JSON.stringify(unreachable)}`);
      }
    }
    this.changed();
  }

  private complete(p: PointerSample): void {
    const d = this.draft;
    if (!d) return;
    switch (d.kind) {
      case "box":
        if (hasArea(d.shape, d.corners)) void createRegion(this.dsId, d.shape, d.corners);
        this.finish();
        return;
      case "path":
        if (d.shape === "freehand") {
          const pts = simplify(d.points, this.tol(p, FREEHAND_TOL_CSS));
          if (hasArea("freehand", pts)) void createRegion(this.dsId, "freehand", pts);
          this.finish();
        }
        return;
      case "line":
        if (dist(d.a, d.b) * p.scale >= MIN_LINE_CSS * p.dpr) {
          setLine(this.dsId, { x0: d.a[0], y0: d.a[1], x1: d.b[0], y1: d.b[1] });
        }
        this.finish();
        return;
      default: {
        const unreachable: never = d;
        throw new Error(`unknown draft ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private polygonClick(p: PointerSample): void {
    const pt: Point = [p.x, p.y];
    const d = this.draft;
    if (d?.kind !== "path" || d.shape !== "polygon") {
      this.draft = { kind: "path", shape: "polygon", points: [pt], cursor: pt, closing: false };
      return;
    }
    if (d.points.length >= 3 && dist(pt, d.points[0]!) <= this.tol(p, CLOSE_CSS)) {
      this.closePolygon();
      return;
    }
    if (dist(pt, d.points[d.points.length - 1]!) > this.tol(p, 1)) d.points.push(pt);
  }

  private closePolygon(): void {
    const d = this.draft;
    if (d?.kind !== "path" || d.shape !== "polygon") return;
    if (hasArea("polygon", d.points)) void createRegion(this.dsId, "polygon", d.points);
    this.finish();
  }

  /** Viewer click on empty image (a press that did not pan). */
  click(): void {
    if (this.tool === "move" && useProject.getState().selection) select(null);
  }

  /** Double-click: closes a polygon, or focuses the region under the pointer. */
  dblclick(p: PointerSample): boolean {
    if (this.draft?.kind === "path" && this.draft.shape === "polygon") {
      this.closePolygon();
      return true;
    }
    if (this.tool !== "move") return true;
    const id = hitRegion(this.scan().regions, p.x, p.y, this.tol(p, EDGE_CSS));
    const r = id ? this.region(id) : undefined;
    if (!r) return false;
    this.focus(regionBox(r));
    return true;
  }

  /** Keys that act on the drawing or the selection. Returns true when handled. */
  key(e: KeyboardEvent): boolean {
    const d = this.draft;
    const st = useProject.getState();
    const sel = st.selection;
    switch (e.key) {
      case "Escape":
        if (d || this.tool !== "move") {
          this.finish();
          return true;
        }
        if (st.noteDraft) cancelNote();
        else if (sel) select(null);
        else if (st.line) setLine(this.dsId, null);
        else return false;
        return true;
      case "Enter":
        if (d?.kind === "path" && d.shape === "polygon") {
          this.closePolygon();
          return true;
        }
        return false;
      case "Backspace":
      case "Delete":
        if (d?.kind === "path" && d.shape === "polygon") {
          d.points.pop();
          if (!d.points.length) this.draft = null;
          this.changed();
          return true;
        }
        if (sel?.kind === "region") void deleteRegion(this.dsId, sel.id);
        else if (sel?.kind === "note") void deleteNote(this.dsId, sel.id);
        else return false;
        return true;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        const r = sel?.kind === "region" ? this.region(sel.id) : undefined;
        if (!r || d) return false;
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        void commitRegion(this.dsId, r.id, translate(r.points, dx, dy));
        return true;
      }
      default:
        return false;
    }
  }

  cursor(space: boolean, panning: boolean): string {
    if (panning) return "grabbing";
    if (space) return "grab";
    if (this.tool !== "move") return "crosshair";
    if (this.gesture?.kind === "move-region" || this.gesture?.kind === "move-note") return "move";
    const h = this.hover;
    if (!h) return "grab";
    switch (h.kind) {
      case "handle":
        return h.box ? (h.index % 2 === 0 ? "nwse-resize" : "nesw-resize") : "move";
      case "line-end":
        return "move";
      case "note":
        return "pointer";
      case "region":
        return h.selected ? "move" : "pointer";
      default: {
        const unreachable: never = h;
        throw new Error(`unknown hover ${JSON.stringify(unreachable)}`);
      }
    }
  }
}

/** The controller of the mounted viewer, so global shortcuts can reach the drawing in progress. */
export const activeTools: { current: ToolController | null } = { current: null };

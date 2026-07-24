import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, ZoomIn, ZoomOut, Hand, Square, Circle as CircleIcon, PenTool, ScanSearch, Layers, Trash2, MapPin, Download, Loader2, MessageSquare } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import type { RoiShape } from "../../lib/types";
import { Compositor, fitRect, type ViewTransform } from "../../lib/compositor";
import { clusterColor } from "../../lib/palette";
import { niceNumber } from "../../lib/format";
import { roiBounds, shapeArea, shapeKindLabel, translateShape, pointInShape, cellsInRoi } from "../../lib/roi";
import { exportRoisZip } from "../../lib/roiExport";
import { toast } from "../../lib/toast";
import { Panel, Slider, Chip } from "../ui";
import RoiAnalysis from "./RoiAnalysis";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 40;

type RoiTool = "pan" | "rect" | "circle" | "polygon";

interface V {
  zoom: number;
  panX: number;
  panY: number;
}

type DrawState =
  | { kind: "rect" | "circle"; x0: number; y0: number; x: number; y: number }
  | { kind: "polygon"; points: [number, number][]; cur: [number, number] };

export default function Viewer() {
  const tissue = useStore((s) => s.tissue);
  const maps = useStore((s) => s.maps);
  const boundaries = useStore((s) => s.boundaries);
  const channels = useStore((s) => s.channels);
  const activeChannels = useStore((s) => s.activeChannels);
  const cellTypes = useStore((s) => s.cellTypes);
  const pixelSizeUm = useStore((s) => s.pixelSizeUm);
  const rois = useStore((s) => s.rois);
  const addRoi = useStore((s) => s.addRoi);
  const updateRoi = useStore((s) => s.updateRoi);
  const removeRoi = useStore((s) => s.removeRoi);
  const selectedRoiId = useStore((s) => s.selectedRoiId);
  const selectRoi = useStore((s) => s.selectRoi);
  const segmented = useStore((s) => s.segmented);
  const setSegmented = useStore((s) => s.setSegmented);
  const presetChannels = useStore((s) => s.presetChannels);
  const showAllChannels = useStore((s) => s.showAllChannels);
  const [roiTool, setRoiTool] = useState<RoiTool>("pan");

  const presets = useMemo(() => {
    const names = activeChannels.map((c) => c.name);
    const defaults = activeChannels.filter((c) => c.defaultOn).map((c) => c.name);
    const nuclear = activeChannels.filter((c) => c.kind === "nuclear").map((c) => c.name);
    const out: { name: string; markers: string[] }[] = [
      { name: "Default", markers: defaults.length ? defaults : names },
    ];
    if (nuclear.length) out.push({ name: "Nuclei", markers: nuclear });
    out.push({ name: "All", markers: names });
    return out;
  }, [activeChannels]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const prevRoiCount = useRef(0);
  const compRef = useRef<Compositor | null>(null);
  const viewRef = useRef<V>({ zoom: 1, panX: 0, panY: 0 });
  const rafRef = useRef(0);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const drawRef = useRef<DrawState | null>(null);
  const moveRef = useRef<{ id: number; lastTx: number; lastTy: number } | null>(null);
  const [glOk, setGlOk] = useState(true);
  const [zoomPct, setZoomPct] = useState(100);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; name: string; color: string } | null>(null);
  // Refs let native (non-passive) listeners always read the latest values.
  const scheduleRef = useRef<() => void>(() => {});
  const mapsRef = useRef(maps);

  const getVT = useCallback((): ViewTransform => {
    const el = wrapRef.current!;
    return {
      zoom: viewRef.current.zoom,
      panX: viewRef.current.panX,
      panY: viewRef.current.panY,
      canvasW: el.clientWidth,
      canvasH: el.clientHeight,
    };
  }, []);

  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const el = wrapRef.current;
    if (!overlay || !el || !maps || !tissue) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (overlay.width !== cw * dpr || overlay.height !== ch * dpr) {
      overlay.width = cw * dpr;
      overlay.height = ch * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const vt = getVT();
    const rect = fitRect(maps.width, maps.height, vt);
    const k = maps.scale * rect.s; // tissue units -> screen px
    const toX = (tx: number) => rect.x + tx * k;
    const toY = (ty: number) => rect.y + ty * k;

    // Segmentation overlay. For real data we render the TRUE per-cell boundaries
    // (a transparent outline image derived from the label mask) aligned 1:1 with
    // the composite so it pans/zooms with it. This replaces the old per-cell
    // circles, which ballooned into huge overlapping rings when zoomed in because
    // each tiny (1–14 px) cell was drawn as `radius = c.r * zoom`.
    if (segmented) {
      const clustered = tissue.cells.some((c) => c.cluster != null);
      if (boundaries) {
        // Keep outlines crisp when magnified past the mask's native pixels;
        // smooth them when the whole strip is shrunk into view.
        ctx.imageSmoothingEnabled = rect.s <= 3;
        ctx.globalAlpha = clustered ? 0.42 : 0.9;
        ctx.drawImage(boundaries, rect.x, rect.y, rect.w, rect.h);
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = true;
      }
      // Per-cell marker dots: the synthetic demo (no mask) always uses them, and
      // real data uses them ON TOP of the boundaries once cells carry a cluster/
      // type color. Radii are capped so they never balloon at high zoom.
      if (!boundaries || clustered || cellTypes) {
        const paths = new Map<string, Path2D>();
        const strokeMode = !boundaries && k > 0.9;
        ctx.lineWidth = Math.max(0.5, Math.min(2, k * 0.8));
        for (const c of tissue.cells) {
          const sx = toX(c.x);
          const sy = toY(c.y);
          if (sx < -20 || sy < -20 || sx > cw + 20 || sy > ch + 20) continue;
          const col = c.cluster != null ? clusterColor(c.cluster) : cellTypes ? cellTypes[c.typeIndex]?.color ?? "#22d3ee" : "#22d3ee";
          let path = paths.get(col);
          if (!path) {
            path = new Path2D();
            paths.set(col, path);
          }
          const rr = Math.min(6, Math.max(strokeMode ? 1.4 : 0.7, c.r * k));
          path.moveTo(sx + rr, sy);
          path.arc(sx, sy, rr, 0, Math.PI * 2);
        }
        for (const [col, path] of paths) {
          if (strokeMode) {
            ctx.strokeStyle = hexA(col, 0.85);
            ctx.stroke(path);
          } else {
            ctx.fillStyle = hexA(col, 0.85);
            ctx.fill(path);
          }
        }
      }
    }

    // ROIs (rect / circle / polygon). Labels are drawn at a fixed screen size
    // so they stay legible and zoom-independent.
    ctx.font = "600 12px Inter, sans-serif";
    const shapePath = (s: RoiShape) => {
      ctx.beginPath();
      if (s.kind === "rect") roundRect(ctx, toX(s.x), toY(s.y), s.w * k, s.h * k, 4);
      else if (s.kind === "circle") ctx.arc(toX(s.cx), toY(s.cy), s.r * k, 0, Math.PI * 2);
      else {
        s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(toX(p[0]), toY(p[1])) : ctx.lineTo(toX(p[0]), toY(p[1]))));
        ctx.closePath();
      }
    };
    for (const r of rois) {
      const selected = r.id === selectedRoiId;
      shapePath(r.shape);
      ctx.fillStyle = hexA(r.color, selected ? 0.16 : 0.08);
      ctx.fill();
      ctx.lineWidth = selected ? 2.75 : 1.75;
      ctx.strokeStyle = r.color;
      ctx.stroke();
      const b = roiBounds(r.shape);
      const lx = toX(b.x);
      const ly = toY(b.y);
      const tw = ctx.measureText(r.label).width;
      ctx.fillStyle = "rgba(5,7,13,0.72)";
      roundRect(ctx, lx, ly - 18, tw + 10, 16, 4);
      ctx.fill();
      ctx.fillStyle = r.color;
      ctx.fillText(r.label, lx + 5, ly - 6);
      if (r.comments.length) {
        ctx.fillStyle = "#f0abfc";
        ctx.beginPath();
        ctx.arc(lx + tw + 14, ly - 10, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // active shape being drawn
    const d = drawRef.current;
    if (d) {
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = "#a78bfa";
      ctx.fillStyle = "rgba(167,139,250,0.10)";
      ctx.beginPath();
      if (d.kind === "polygon") {
        const pts = [...d.points, d.cur];
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(toX(p[0]), toY(p[1])) : ctx.lineTo(toX(p[0]), toY(p[1]))));
      } else if (d.kind === "rect") {
        ctx.rect(toX(Math.min(d.x0, d.x)), toY(Math.min(d.y0, d.y)), Math.abs(d.x - d.x0) * k, Math.abs(d.y - d.y0) * k);
      } else {
        ctx.arc(toX(d.x0), toY(d.y0), Math.hypot(d.x - d.x0, d.y - d.y0) * k, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // scale bar — physical microns when the pixel size is known, else pixels.
    const targetScreen = Math.min(cw * 0.26, 170);
    let barLabel: string;
    let barPx: number;
    if (pixelSizeUm && pixelSizeUm > 0) {
      const screenPerUm = k / pixelSizeUm;
      const um = niceNumber(targetScreen / screenPerUm);
      barPx = um * screenPerUm;
      barLabel = um >= 1000 ? `${um / 1000} mm` : `${um} µm`;
    } else {
      const px = niceNumber(targetScreen / k);
      barPx = px * k;
      barLabel = `${px.toLocaleString()} px`;
    }
    if (barPx > 24 && barPx < cw * 0.9) {
      const bx = cw - barPx - 24;
      const by = ch - 28;
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + barPx, by);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "600 11px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(barLabel, bx + barPx / 2, by - 7);
      ctx.textAlign = "left";
    }
  }, [maps, tissue, boundaries, rois, selectedRoiId, segmented, getVT, cellTypes, pixelSizeUm]);

  const render = useCallback(() => {
    const comp = compRef.current;
    if (comp && comp.ok) comp.render(getVT());
    drawOverlay();
  }, [getVT, drawOverlay]);

  const schedule = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(render);
  }, [render]);

  useEffect(() => {
    scheduleRef.current = schedule;
  }, [schedule]);
  useEffect(() => {
    mapsRef.current = maps;
  }, [maps]);

  /** Zoom keeping the image point under (clientX, clientY) fixed on screen. */
  const zoomAtPoint = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const el = wrapRef.current;
      const m = mapsRef.current;
      if (!el || !m) return;
      const r = el.getBoundingClientRect();
      const sx = clientX - r.left;
      const sy = clientY - r.top;
      const before = fitRect(m.width, m.height, getVT());
      const kb = m.scale * before.s;
      const tx = (sx - before.x) / kb;
      const ty = (sy - before.y) / kb;
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, viewRef.current.zoom * factor));
      viewRef.current.zoom = next;
      const after = fitRect(m.width, m.height, getVT());
      const ka = m.scale * after.s;
      const wAfter = m.width * after.s;
      const hAfter = m.height * after.s;
      viewRef.current.panX = sx - tx * ka - (el.clientWidth - wAfter) / 2;
      viewRef.current.panY = sy - ty * ka - (el.clientHeight - hAfter) / 2;
      setZoomPct(Math.round(next * 100));
      scheduleRef.current();
    },
    [getVT]
  );

  const zoomByCenter = useCallback(
    (factor: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      zoomAtPoint(r.left + el.clientWidth / 2, r.top + el.clientHeight / 2, factor);
    },
    [zoomAtPoint]
  );

  const fit = useCallback(() => {
    viewRef.current = { zoom: 1, panX: 0, panY: 0 };
    setZoomPct(100);
    scheduleRef.current();
  }, []);

  const oneToOne = useCallback(() => {
    const el = wrapRef.current;
    const m = mapsRef.current;
    if (!el || !m) return;
    const base = Math.min(el.clientWidth / m.width, el.clientHeight / m.height) || 1;
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, 1 / base));
    viewRef.current = { zoom, panX: 0, panY: 0 };
    setZoomPct(Math.round(zoom * 100));
    scheduleRef.current();
  }, []);

  const onDoubleClick = (e: React.MouseEvent) => {
    zoomAtPoint(e.clientX, e.clientY, e.altKey ? 1 / 1.6 : 1.6);
  };

  // init compositor
  useEffect(() => {
    const gl = glRef.current;
    if (!gl || !maps) return;
    const comp = new Compositor(gl);
    compRef.current = comp;
    setGlOk(comp.ok);
    if (comp.ok) {
      comp.upload(maps);
      comp.setChannels(channels.map((c) => ({ color: activeChannels[c.index]?.color ?? "#ffffff", gain: c.gain, gamma: c.gamma, visible: c.visible })));
    }
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maps]);

  // channel changes
  useEffect(() => {
    const comp = compRef.current;
    if (comp && comp.ok) {
      comp.setChannels(channels.map((c) => ({ color: activeChannels[c.index]?.color ?? "#ffffff", gain: c.gain, gamma: c.gamma, visible: c.visible })));
    }
    schedule();
  }, [channels, activeChannels, schedule]);

  useEffect(() => {
    schedule();
  }, [rois, segmented, schedule]);

  // When a new ROI is drawn, bring the analysis + comments panel into view so
  // the user actually sees the live bar graph and the comments affordance.
  useEffect(() => {
    if (rois.length > prevRoiCount.current) {
      requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
    prevRoiCount.current = rois.length;
  }, [rois.length]);

  // resize
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => schedule());
    ro.observe(el);
    return () => ro.disconnect();
  }, [schedule]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Non-passive wheel listener so the PAGE never scrolls while zooming over the
  // canvas. React's synthetic onWheel is registered passively and cannot
  // preventDefault(), which is the root cause of the page-scroll bug.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      // Normalize deltaMode (0 = pixel, 1 = line, 2 = page) so mice & trackpads
      // behave consistently.
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= el.clientHeight;
      // macOS trackpad pinch arrives as ctrlKey + wheel; make it a touch finer.
      const intensity = e.ctrlKey ? 0.01 : 0.0025;
      const factor = Math.exp(-dy * intensity);
      zoomAtPoint(e.clientX, e.clientY, factor);
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [zoomAtPoint]);

  // Keyboard zoom: +/= in, -/_ out, 0 fit, 1 actual pixels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomByCenter(1.25);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomByCenter(1 / 1.25);
      } else if (e.key === "0") {
        e.preventDefault();
        fit();
      } else if (e.key === "1") {
        e.preventDefault();
        oneToOne();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomByCenter, fit, oneToOne]);

  // ROI keyboard: tool shortcuts, Delete removes selection, Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.key === "Escape") {
        drawRef.current = null;
        setRoiTool("pan");
        scheduleRef.current();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedRoiId != null) {
        e.preventDefault();
        removeRoi(selectedRoiId);
      } else if (key === "v") setRoiTool("pan");
      else if (key === "r") setRoiTool("rect");
      else if (key === "c") setRoiTool("circle");
      else if (key === "p") setRoiTool("polygon");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRoiId, removeRoi]);

  const screenToTissue = (clientX: number, clientY: number) => {
    const el = wrapRef.current!;
    const r = el.getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const rect = fitRect(maps!.width, maps!.height, getVT());
    const k = maps!.scale * rect.s;
    return { tx: (sx - rect.x) / k, ty: (sy - rect.y) / k, sx, sy };
  };

  const finishShape = (shape: RoiShape, minPx = 6) => {
    const b = roiBounds(shape);
    if (shape.kind !== "polygon" && Math.max(b.w, b.h) < minPx) return;
    addRoi({ id: Date.now(), label: `ROI ${rois.length + 1}`, color: clusterColor(rois.length), shape, comments: [] });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = screenToTissue(e.clientX, e.clientY);
    if (roiTool === "rect" || roiTool === "circle") {
      drawRef.current = { kind: roiTool, x0: p.tx, y0: p.ty, x: p.tx, y: p.ty };
      return;
    }
    if (roiTool === "polygon") {
      drawRef.current = { kind: "polygon", points: [[p.tx, p.ty]], cur: [p.tx, p.ty] };
      return;
    }
    // pan tool: clicking inside an ROI selects & moves it; empty space pans.
    const hit = [...rois].reverse().find((r) => pointInShape(r.shape, p.tx, p.ty));
    if (hit) {
      selectRoi(hit.id);
      moveRef.current = { id: hit.id, lastTx: p.tx, lastTy: p.ty };
      return;
    }
    dragRef.current = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawRef.current;
    if (d && maps) {
      const p = screenToTissue(e.clientX, e.clientY);
      if (d.kind === "polygon") {
        const rect = fitRect(maps.width, maps.height, getVT());
        const k = maps.scale * rect.s;
        const last = d.points[d.points.length - 1];
        if (Math.hypot(p.tx - last[0], p.ty - last[1]) * k > 3) d.points.push([p.tx, p.ty]);
        d.cur = [p.tx, p.ty];
      } else {
        d.x = p.tx;
        d.y = p.ty;
      }
      schedule();
      return;
    }
    if (moveRef.current) {
      const p = screenToTissue(e.clientX, e.clientY);
      const dx = p.tx - moveRef.current.lastTx;
      const dy = p.ty - moveRef.current.lastTy;
      moveRef.current.lastTx = p.tx;
      moveRef.current.lastTy = p.ty;
      const r = rois.find((x) => x.id === moveRef.current!.id);
      if (r) updateRoi(r.id, { shape: translateShape(r.shape, dx, dy) });
      return;
    }
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      dragRef.current = { x: e.clientX, y: e.clientY };
      viewRef.current.panX += dx;
      viewRef.current.panY += dy;
      schedule();
      return;
    }
    // hover to identify the nearest cell (cell ids are not array indices)
    if (tissue && maps) {
      const p = screenToTissue(e.clientX, e.clientY);
      let bestCell: (typeof tissue.cells)[number] | null = null;
      let bd = 18 * 18;
      for (const c of tissue.cells) {
        const dd = (c.x - p.tx) ** 2 + (c.y - p.ty) ** 2;
        if (dd < bd) {
          bd = dd;
          bestCell = c;
        }
      }
      if (bestCell) {
        const c = bestCell;
        const name = cellTypes ? cellTypes[c.typeIndex].name : c.cluster != null ? `Cluster ${c.cluster}` : `Cell #${c.id}`;
        const color = cellTypes ? cellTypes[c.typeIndex].color : c.cluster != null ? clusterColor(c.cluster) : "#67e8f9";
        setHoverInfo({ x: p.sx, y: p.sy, name, color });
      } else setHoverInfo(null);
    }
  };

  const onPointerUp = () => {
    const d = drawRef.current;
    if (d) {
      if (d.kind === "polygon") {
        if (d.points.length >= 3) finishShape({ kind: "polygon", points: d.points });
      } else if (d.kind === "rect") {
        finishShape({ kind: "rect", x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) });
      } else {
        finishShape({ kind: "circle", cx: d.x0, cy: d.y0, r: Math.hypot(d.x - d.x0, d.y - d.y0) });
      }
      drawRef.current = null;
      schedule();
    }
    moveRef.current = null;
    dragRef.current = null;
  };


  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Panel className="relative overflow-hidden p-0" strong>
        {/* toolbar */}
        <div className="absolute left-3 top-3 z-20 flex flex-wrap items-center gap-1.5">
          {presets.map((p) => (
            <Chip key={p.name} onClick={() => (p.name === "All" ? showAllChannels() : presetChannels(p.markers))}>
              {p.name}
            </Chip>
          ))}
        </div>
        <div className="absolute right-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-end gap-1.5">
          <ToolBtn active={roiTool === "pan"} onClick={() => setRoiTool("pan")} title="Pan / move ROI (V)"><Hand className="h-4 w-4" /></ToolBtn>
          <ToolBtn active={roiTool === "rect"} onClick={() => setRoiTool("rect")} title="Rectangle ROI (R)"><Square className="h-4 w-4" /></ToolBtn>
          <ToolBtn active={roiTool === "circle"} onClick={() => setRoiTool("circle")} title="Circle ROI (C)"><CircleIcon className="h-4 w-4" /></ToolBtn>
          <ToolBtn active={roiTool === "polygon"} onClick={() => setRoiTool("polygon")} title="Freehand polygon ROI (P)"><PenTool className="h-4 w-4" /></ToolBtn>
          <span className="mx-0.5 h-6 w-px bg-white/10" />
          <ToolBtn onClick={() => zoomByCenter(1.25)} title="Zoom in (+)"><ZoomIn className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={() => zoomByCenter(1 / 1.25)} title="Zoom out (−)"><ZoomOut className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={fit} title="Fit to view (0)"><Maximize2 className="h-4 w-4" /></ToolBtn>
          <ToolBtn onClick={oneToOne} title="Actual pixels (1)"><span className="text-[11px] font-bold leading-none">1:1</span></ToolBtn>
          <ToolBtn active={segmented} onClick={() => setSegmented(!segmented, "manual")} title="Toggle segmentation">
            <ScanSearch className="h-4 w-4" />
          </ToolBtn>
        </div>

        <div
          ref={wrapRef}
          className={clsx("relative h-[420px] w-full select-none touch-none overscroll-contain sm:h-[560px] lg:h-[640px]", roiTool !== "pan" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { onPointerUp(); setHoverInfo(null); }}
          onDoubleClick={onDoubleClick}
        >
          <canvas ref={glRef} className="absolute inset-0 h-full w-full" />
          <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
          {!glOk && (
            <div className="absolute inset-0 grid place-items-center text-sm text-white/60">
              WebGL2 unavailable in this browser.
            </div>
          )}
          {hoverInfo && (
            <div
              className="pointer-events-none absolute z-20 flex items-center gap-1.5 rounded-lg glass-strong px-2 py-1 text-xs"
              style={{ left: hoverInfo.x + 14, top: hoverInfo.y + 14 }}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: hoverInfo.color }} />
              {hoverInfo.name}
            </div>
          )}
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-lg glass px-2.5 py-1 font-mono text-[11px] text-white/60">
            {zoomPct}% · {roiTool === "pan" ? "scroll = zoom · drag = pan" : `${roiTool} ROI — drag to draw · Esc cancels`}
          </div>
        </div>
      </Panel>

      <ChannelPanel />
      </div>
      <RoiListPanel />
      {/* Per-ROI analysis + comments — always mounted so the bar graph and
          comments panel are discoverable; it renders an empty-state prompt
          until a region is drawn/selected. */}
      <div ref={inspectorRef}>
        <RoiAnalysis />
      </div>
    </div>
  );
}

function ToolBtn({ children, onClick, active, title }: { children: React.ReactNode; onClick: () => void; active?: boolean; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={clsx(
        "grid h-9 w-9 place-items-center rounded-xl glass text-white/70 transition hover:text-white",
        active && "!bg-cyan-400/20 text-cyan-200 ring-1 ring-cyan-300/40"
      )}
    >
      {children}
    </button>
  );
}

function ChannelPanel() {
  const channels = useStore((s) => s.channels);
  const activeChannels = useStore((s) => s.activeChannels);
  const toggle = useStore((s) => s.toggleChannel);
  const setGain = useStore((s) => s.setGain);
  const setGamma = useStore((s) => s.setGamma);
  const soloChannel = useStore((s) => s.soloChannel);
  const [expanded, setExpanded] = useState<number | null>(0);

  return (
    <Panel className="flex max-h-[640px] flex-col overflow-hidden" strong>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-bold">
          <Layers className="h-4 w-4 text-cyan-300" /> Channels
        </div>
        <span className="text-xs text-white/40">{channels.filter((c) => c.visible).length}/{channels.length} on</span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {channels.map((c) => {
          const mk = activeChannels[c.index];
          if (!mk) return null;
          const open = expanded === c.index;
          return (
            <div key={c.index} className={clsx("rounded-xl px-2 py-1.5 transition", c.visible ? "bg-white/[0.03]" : "opacity-55")}>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggle(c.index)}
                  className="grid h-6 w-6 place-items-center rounded-md"
                  style={{ background: c.visible ? `${mk.color}33` : "transparent", boxShadow: `inset 0 0 0 1px ${mk.color}66` }}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.visible ? mk.color : "transparent", boxShadow: c.visible ? `0 0 8px ${mk.color}` : "none" }} />
                </button>
                <button onClick={() => setExpanded(open ? null : c.index)} className="flex-1 text-left text-sm font-semibold">
                  {mk.name}
                  <span className="ml-1.5 text-[10px] font-normal text-white/35">{mk.kind}</span>
                </button>
                <button onClick={() => soloChannel(c.index)} className="rounded-md px-1.5 py-0.5 text-[10px] text-white/40 hover:bg-white/10 hover:text-white">
                  solo
                </button>
              </div>
              {open && (
                <div className="mt-2 space-y-2 px-1 pb-1">
                  <LabeledSlider label="Gain" value={c.gain} min={0.2} max={3} onChange={(v) => setGain(c.index, v)} accent={mk.color} />
                  <LabeledSlider label="Gamma" value={c.gamma} min={0.3} max={2.4} onChange={(v) => setGamma(c.index, v)} accent={mk.color} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function RoiListPanel() {
  const rois = useStore((s) => s.rois);
  const tissue = useStore((s) => s.tissue);
  const maps = useStore((s) => s.maps);
  const activeChannels = useStore((s) => s.activeChannels);
  const channelStates = useStore((s) => s.channels);
  const pixelSizeUm = useStore((s) => s.pixelSizeUm);
  const datasetLabel = useStore((s) => s.datasetLabel);
  const selectedRoiId = useStore((s) => s.selectedRoiId);
  const selectRoi = useStore((s) => s.selectRoi);
  const removeRoi = useStore((s) => s.removeRoi);
  const updateRoi = useStore((s) => s.updateRoi);
  const clearRois = useStore((s) => s.clearRois);
  const [exporting, setExporting] = useState(false);

  const exportAll = async () => {
    if (!tissue || !maps) return;
    setExporting(true);
    try {
      await exportRoisZip(rois, { maps, defs: activeChannels, channels: channelStates, cells: tissue.cells, pixelSizeUm, datasetLabel }, "fluoroview-rois.zip");
      toast.success("ROIs exported", `${rois.length} ROI folder${rois.length > 1 ? "s" : ""} in fluoroview-rois.zip`);
    } catch (e) {
      toast.error("Export failed", e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Panel className="p-4" strong>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-bold">
          <MapPin className="h-4 w-4 text-cyan-300" /> Regions of interest
          <span className="font-normal text-white/40">({rois.length})</span>
        </div>
        {rois.length > 0 && (
          <div className="flex items-center gap-3">
            <button onClick={exportAll} disabled={exporting} className="inline-flex items-center gap-1.5 text-xs text-white/60 transition hover:text-cyan-300 disabled:opacity-50">
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export all (.zip)
            </button>
            <button onClick={clearRois} className="text-xs text-white/45 transition hover:text-rose-300">
              Clear all
            </button>
          </div>
        )}
      </div>
      {rois.length === 0 ? (
        <p className="max-w-2xl text-xs leading-relaxed text-white/45">
          Pick the <span className="text-white/70">Rectangle</span>, <span className="text-white/70">Circle</span>, or{" "}
          <span className="text-white/70">Freehand polygon</span> tool in the viewer toolbar (or press R / C / P), then draw on the
          image. With the Pan tool (V) click an ROI to select it and drag to move; press Delete to remove the selected one.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rois.map((r) => {
            const n = tissue ? cellsInRoi(tissue.cells, r.shape).length : 0;
            const area = Math.round(shapeArea(r.shape));
            const sel = r.id === selectedRoiId;
            return (
              <div
                key={r.id}
                onClick={() => selectRoi(r.id)}
                className={clsx(
                  "cursor-pointer rounded-xl border p-3 transition",
                  sel ? "border-cyan-400/50 bg-cyan-400/[0.06]" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: r.color }} />
                  <input
                    value={r.label}
                    onChange={(e) => updateRoi(r.id, { label: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 rounded bg-transparent text-sm font-semibold text-white outline-none focus:bg-white/5"
                    aria-label="ROI label"
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      selectRoi(r.id);
                    }}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-white/45 transition hover:bg-white/10 hover:text-fuchsia-300"
                    title="View analysis & comments for this ROI"
                    aria-label="View comments"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {r.comments.length > 0 && <span>{r.comments.length}</span>}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRoi(r.id);
                    }}
                    className="rounded-md p-1 text-white/40 transition hover:bg-white/10 hover:text-rose-300"
                    aria-label="Delete ROI"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/50">
                  <span>{shapeKindLabel(r.shape)}</span>
                  <span className="text-white/70">{n.toLocaleString()} cells</span>
                  <span>{area.toLocaleString()} px²</span>
                  {r.comments.length > 0 && <span className="text-fuchsia-300">{r.comments.length} note{r.comments.length > 1 ? "s" : ""}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function LabeledSlider({ label, value, min, max, onChange, accent }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; accent: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 text-[11px] text-white/45">{label}</span>
      <Slider value={value} min={min} max={max} onChange={onChange} accent={accent} />
      <span className="w-8 text-right font-mono text-[11px] text-white/55">{value.toFixed(1)}</span>
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

import { LayoutGrid, Maximize, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { DatasetInfo } from "../api/types";
import { fmtZoom, hexToRgb } from "../lib/format";
import { approach, ease, reducedMotion, tween } from "../motion/motion";
import { type ChannelDisplay, type Options, useStudio } from "../state/store";
import {
  type Camera, clampCenter, clampScale, fit, type ScaleBar, scaleBar, screenToImage, type Viewport, zoomAt,
} from "./camera";
import { onViewerCommand, type ViewerCommand } from "./commands";
import { type Flight, flight, flightDuration } from "./flight";
import { galleryLayout, lerpRect, panelShrink, type Rect } from "./gallery";
import { type ChannelUniforms, Renderer } from "./renderer";
import { TileManager } from "./tiles";

const MINIMAP_CSS = 184;
const MINIMAP_MARGIN_CSS = 12;
const GRID_FROM_SCALE = 8;
const GALLERY_MS = 320;
const SURFACE: [number, number, number] = [12 / 255, 13 / 255, 15 / 255];

type Motion =
  | { kind: "flight"; f: Flight; start: number; duration: number }
  | { kind: "zoom"; sx: number; sy: number; target: number }
  | { kind: "inertia"; vx: number; vy: number };

interface Panel {
  channel: number | null;
  rect: Rect;
}

interface Label {
  key: string;
  x: number;
  y: number;
  name: string;
  color: string;
}

interface Overlay {
  minimap: [number, number, number, number] | null;
  bar: ScaleBar | null;
  /** read position during a pyramid build; `below` is the unread image height under it (CSS px) */
  scan: { x: number; y: number; width: number; below: number; line: boolean } | null;
  labels: Label[];
  labelOpacity: number;
}

const EMPTY: Overlay = { minimap: null, bar: null, scan: null, labels: [], labelOpacity: 0 };

function uniformsFor(ds: DatasetInfo, display: ChannelDisplay[], channels: number[]): ChannelUniforms[] {
  const saturation = ds.saturation ?? (ds.dtype.endsWith("u1") ? 255 : 65535);
  return channels.map((i) => {
    const d = display[i]!;
    return { layer: i, lo: d.lo, hi: d.hi, gamma: d.gamma, color: hexToRgb(d.color), saturation };
  });
}

function sameOverlay(a: Overlay, b: Overlay): boolean {
  return a.minimap?.join() === b.minimap?.join() && a.bar?.label === b.bar?.label && a.bar?.cssPx === b.bar?.cssPx
    && a.scan?.y === b.scan?.y && a.scan?.x === b.scan?.x && a.scan?.width === b.scan?.width
    && a.scan?.below === b.scan?.below && a.scan?.line === b.scan?.line
    && a.labelOpacity === b.labelOpacity && JSON.stringify(a.labels) === JSON.stringify(b.labels);
}

export function Viewer({ dataset }: { dataset: DatasetInfo }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const tiles = useRef<TileManager | null>(null);
  const camera = useRef<Camera | null>(null);
  const viewport = useRef<Viewport>({ width: 1, height: 1, dpr: 1 });
  const motion = useRef<Motion | null>(null);
  const panels = useRef<Panel[]>([]);
  const galleryT = useRef(0);
  const scanShown = useRef(0);
  const lastFrame = useRef(0);
  const frameRequested = useRef(false);
  const drag = useRef<{ x: number; y: number; cam: Camera; k: number; samples: [number, number, number][] } | null>(null);
  const pixelAbort = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(EMPTY);

  const setView = useStudio((s) => s.setView);
  const setCursor = useStudio((s) => s.setCursor);
  const setOption = useStudio((s) => s.setOption);
  const options = useStudio((s) => s.options);
  const optionsRef = useRef<Options>(options);
  optionsRef.current = options;
  const dsRef = useRef(dataset);
  dsRef.current = dataset;
  const W = dataset.width;
  const H = dataset.height;

  const panelAt = useCallback((sx: number, sy: number): Panel => {
    const list = panels.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]!;
      if (sx >= p.rect.x && sx < p.rect.x + p.rect.width && sy >= p.rect.y && sy < p.rect.y + p.rect.height) return p;
    }
    return list[0] ?? { channel: null, rect: { x: 0, y: 0, ...viewport.current } };
  }, []);

  /** Shared-camera zoom by `factor` about screen point (sx, sy) of whichever panel it falls in. */
  const zoomAtPoint = useCallback((cam: Camera, sx: number, sy: number, factor: number): Camera => {
    const vp = viewport.current;
    const p = panelAt(sx, sy);
    const k = panelShrink(p.rect, vp.width, vp.height);
    const pvp = { width: p.rect.width, height: p.rect.height, dpr: vp.dpr };
    const target = clampScale(cam.scale * factor, W, H, vp) * k;
    const z = zoomAt({ ...cam, scale: cam.scale * k }, pvp, sx - p.rect.x, sy - p.rect.y, target / (cam.scale * k), W, H);
    return { cx: z.cx, cy: z.cy, scale: z.scale / k };
  }, [W, H, panelAt]);

  const stepMotion = useCallback((dt: number, now: number): boolean => {
    const m = motion.current;
    const cam = camera.current;
    if (!m || !cam) return false;
    switch (m.kind) {
      case "flight": {
        const s = Math.min(1, (now - m.start) / m.duration);
        camera.current = clampCenter(m.f.at(ease.inOutCubic(s)), W, H);
        if (s >= 1) motion.current = null;
        break;
      }
      case "zoom": {
        const next = Math.exp(approach(Math.log(cam.scale), Math.log(m.target), dt, 65));
        camera.current = zoomAtPoint(cam, m.sx, m.sy, next / cam.scale);
        if (Math.abs(Math.log(next / m.target)) < 1e-3) motion.current = null;
        break;
      }
      case "inertia": {
        camera.current = clampCenter({ ...cam, cx: cam.cx + m.vx * dt, cy: cam.cy + m.vy * dt }, W, H);
        const decay = Math.exp(-dt / 170);
        m.vx *= decay;
        m.vy *= decay;
        if (Math.hypot(m.vx, m.vy) * cam.scale < 0.015) motion.current = null;
        break;
      }
      default: {
        const unreachable: never = m;
        throw new Error(`unknown motion ${JSON.stringify(unreachable)}`);
      }
    }
    return motion.current !== null;
  }, [W, H, zoomAtPoint]);

  const draw = useCallback((now: number) => {
    frameRequested.current = false;
    const r = renderer.current;
    const tm = tiles.current;
    if (!r || !tm || !camera.current) return;
    const ds = dsRef.current;
    const dt = lastFrame.current ? Math.min(64, now - lastFrame.current) : 16;
    lastFrame.current = now;
    let animating = stepMotion(dt, now);
    const cam = camera.current;
    const vp = viewport.current;
    const opts = optionsRef.current;
    const display = useStudio.getState().display[ds.id] ?? [];
    const visible = display.flatMap((d, i) => (d.visible ? [i] : []));

    const g = galleryT.current;
    const full: Rect = { x: 0, y: 0, width: vp.width, height: vp.height };
    const layout: Panel[] = [{ channel: null, rect: full }];
    if (g > 0 && visible.length > 0) {
      const cells = galleryLayout(visible.length + 1, vp.width, vp.height, Math.round(2 * vp.dpr));
      layout[0] = { channel: null, rect: lerpRect(full, cells[0]!, g) };
      visible.forEach((c, i) => layout.push({ channel: c, rect: lerpRect(full, cells[i + 1]!, g) }));
    }
    panels.current = layout;
    const views = layout.map((p) => ({
      cam: { ...cam, scale: cam.scale * panelShrink(p.rect, vp.width, vp.height) },
      vp: { width: p.rect.width, height: p.rect.height, dpr: vp.dpr },
    }));

    const { plans } = tm.planViews(views, visible, opts.smooth);
    r.resize(vp.width, vp.height);
    r.clear(undefined, g > 0 ? SURFACE : [0, 0, 0]);
    const composite = uniformsFor(ds, display, visible);
    for (let i = layout.length - 1; i >= 0; i--) {
      const p = layout[i]!;
      const view = views[i]!;
      if (g > 0) r.clear(p.rect);
      r.setChannels(p.channel === null ? composite : uniformsFor(ds, display, [p.channel]));
      const grid = opts.grid && view.cam.scale >= GRID_FROM_SCALE
        ? Math.min(1, (view.cam.scale - GRID_FROM_SCALE) / 8 + 0.35) : 0;
      r.begin(p.rect, view.cam, { clip: opts.clip, grid });
      for (const d of plans[i]!.draws) r.draw(d);
      r.end();
      if (plans[i]!.fading) animating = true;
    }

    const main = views[0]!;
    const mainRect = layout[0]!.rect;
    let minimap: Overlay["minimap"] = null;
    if (opts.minimap && g < 0.5) {
      const m = MINIMAP_CSS * vp.dpr;
      const mh = Math.round((m * H) / W);
      const region = { x: vp.width - m - MINIMAP_MARGIN_CSS * vp.dpr, y: MINIMAP_MARGIN_CSS * vp.dpr, width: Math.round(m), height: mh };
      r.clear(region);
      r.setChannels(composite);
      r.begin(region, { cx: W / 2, cy: H / 2, scale: m / W }, { clip: false, grid: 0 });
      for (const d of tm.overview(visible)) r.draw(d);
      r.end();
      const [x0, y0] = screenToImage(main.cam, main.vp, 0, 0);
      const [x1, y1] = screenToImage(main.cam, main.vp, main.vp.width, main.vp.height);
      const k = MINIMAP_CSS / W;
      minimap = [x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k];
    }

    let scan: Overlay["scan"] = null;
    const building = ds.build.state === "building" || ds.build.state === "queued";
    if (building) {
      scanShown.current = reducedMotion() ? ds.build.progress
        : approach(scanShown.current, ds.build.progress, dt, 140);
      const s = main.cam.scale;
      const y = mainRect.y + (scanShown.current * H - main.cam.cy) * s + mainRect.height / 2;
      const left = Math.max(mainRect.x, mainRect.x + (0 - main.cam.cx) * s + mainRect.width / 2);
      const right = Math.min(mainRect.x + mainRect.width, mainRect.x + (W - main.cam.cx) * s + mainRect.width / 2);
      const bottom = Math.min(mainRect.y + mainRect.height, mainRect.y + (H - main.cam.cy) * s + mainRect.height / 2);
      const top = Math.max(mainRect.y, y);
      if (bottom > top && right > left) {
        scan = { x: left / vp.dpr, y: top / vp.dpr, width: (right - left) / vp.dpr, below: (bottom - top) / vp.dpr,
          line: y >= mainRect.y };
      }
      animating = true;
    } else {
      scanShown.current = 0;
    }

    const labels: Label[] = g > 0 ? layout.map((p) => ({
      key: p.channel === null ? "composite" : String(p.channel),
      x: p.rect.x / vp.dpr + 10,
      y: p.rect.y / vp.dpr + 9,
      name: p.channel === null ? "Composite" : ds.channels[p.channel]!.name,
      color: p.channel === null ? "" : display[p.channel]!.color,
    })) : [];

    const cssPerImage = main.cam.scale / vp.dpr;
    setView({ scale: main.cam.scale, level: plans[0]!.level, cssPxPerImagePx: cssPerImage });
    const next: Overlay = {
      minimap,
      bar: ds.pixel_size_um ? scaleBar(ds.pixel_size_um / cssPerImage) : null,
      scan,
      labels,
      labelOpacity: Math.round(g * 100) / 100,
    };
    setOverlay((prev) => (sameOverlay(prev, next) ? prev : next));
    if (animating) requestFrameRef.current();
  }, [W, H, setView, stepMotion]);

  const requestFrameRef = useRef<() => void>(() => undefined);
  const requestFrame = useCallback(() => {
    if (frameRequested.current) return;
    frameRequested.current = true;
    requestAnimationFrame(draw);
  }, [draw]);
  requestFrameRef.current = requestFrame;

  useEffect(() => {
    try {
      renderer.current = new Renderer(canvasRef.current!);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    tiles.current = new TileManager(renderer.current.gl, dsRef.current, () => requestFrameRef.current());
    camera.current = null;
    motion.current = null;
    return () => {
      tiles.current?.dispose();
      tiles.current = null;
      renderer.current = null;
    };
  }, [dataset.id]);

  useEffect(() => {
    const host = hostRef.current!;
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = host.getBoundingClientRect();
      viewport.current = { width: Math.max(1, Math.round(rect.width * dpr)), height: Math.max(1, Math.round(rect.height * dpr)), dpr };
      if (!camera.current) camera.current = fit(W, H, viewport.current);
      requestFrame();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [dataset.id, W, H, requestFrame]);

  useEffect(() => useStudio.subscribe((s, prev) => {
    if (s.display[dataset.id] !== prev.display[dataset.id] || s.options !== prev.options) requestFrame();
    const build = s.datasets[dataset.id]?.build;
    if (build && build !== prev.datasets[dataset.id]?.build) {
      tiles.current?.onBuild(build.rows_ready);
      requestFrame();
    }
  }), [dataset.id, requestFrame]);

  useEffect(() => {
    const target = options.gallery ? 1 : 0;
    const from = galleryT.current;
    if (from === target) return;
    return tween(GALLERY_MS, (t) => {
      galleryT.current = from + (target - from) * t;
      requestFrame();
    }, ease.outExpo);
  }, [options.gallery, requestFrame]);

  const fly = useCallback((target: Camera) => {
    const cam = camera.current;
    if (!cam) return;
    const vp = viewport.current;
    const goal = clampCenter({ ...target, scale: clampScale(target.scale, W, H, vp) }, W, H);
    if (reducedMotion()) {
      motion.current = null;
      camera.current = goal;
    } else {
      const f = flight(cam, goal, vp);
      motion.current = { kind: "flight", f, start: performance.now(), duration: flightDuration(f) };
    }
    requestFrame();
  }, [W, H, requestFrame]);

  const command = useCallback((cmd: ViewerCommand) => {
    const cam = camera.current;
    if (!cam) return;
    const vp = viewport.current;
    switch (cmd) {
      case "zoom-in":
        fly({ ...cam, scale: cam.scale * 2 });
        break;
      case "zoom-out":
        fly({ ...cam, scale: cam.scale / 2 });
        break;
      case "fit":
        fly(fit(W, H, vp));
        break;
      case "actual":
        fly({ ...cam, scale: 1 / panelShrink(panels.current[0]?.rect ?? { x: 0, y: 0, ...vp }, vp.width, vp.height) });
        break;
      default: {
        const unreachable: never = cmd;
        throw new Error(`unknown viewer command ${unreachable}`);
      }
    }
  }, [W, H, fly]);

  useEffect(() => onViewerCommand(command), [command]);

  const devicePoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = hostRef.current!.getBoundingClientRect();
    const dpr = viewport.current.dpr;
    return [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
  };

  const updateCursor = (sx: number, sy: number) => {
    const cam = camera.current;
    const tm = tiles.current;
    if (!cam || !tm) return;
    const vp = viewport.current;
    const p = panelAt(sx, sy);
    const pcam = { ...cam, scale: cam.scale * panelShrink(p.rect, vp.width, vp.height) };
    const [fx, fy] = screenToImage(pcam, { width: p.rect.width, height: p.rect.height, dpr: vp.dpr }, sx - p.rect.x, sy - p.rect.y);
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    if (x < 0 || y < 0 || x >= W || y >= H) {
      setCursor(null);
      return;
    }
    const values = dataset.channels.map((_, c) => tm.valueAt(x, y, c));
    setCursor({ x, y, values });
    if (values.some((v) => v === null)) {
      pixelAbort.current?.abort();
      const ctl = (pixelAbort.current = new AbortController());
      api.pixel(dataset.id, x, y, ctl.signal)
        .then((res) => {
          const cur = useStudio.getState().cursor;
          if (cur && cur.x === x && cur.y === y) setCursor({ x, y, values: res.values });
        })
        .catch(() => undefined);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !camera.current) return;
    motion.current = null;
    (e.target as Element).setPointerCapture(e.pointerId);
    const [x, y] = devicePoint(e);
    const vp = viewport.current;
    const k = panelShrink(panelAt(x, y).rect, vp.width, vp.height);
    drag.current = { x, y, cam: camera.current, k, samples: [[performance.now(), x, y]] };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [x, y] = devicePoint(e);
    const d = drag.current;
    if (d) {
      const s = d.cam.scale * d.k;
      camera.current = clampCenter({ ...d.cam, cx: d.cam.cx - (x - d.x) / s, cy: d.cam.cy - (y - d.y) / s }, W, H);
      const now = performance.now();
      d.samples.push([now, x, y]);
      while (d.samples.length > 2 && now - d.samples[0]![0] > 100) d.samples.shift();
      requestFrame();
    }
    updateCursor(x, y);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (!d || reducedMotion() || d.samples.length < 2) return;
    const [t0, x0, y0] = d.samples[0]!;
    const [t1, x1, y1] = d.samples[d.samples.length - 1]!;
    const dt = t1 - t0;
    if (dt <= 0 || performance.now() - t1 > 60) return;
    const s = d.cam.scale * d.k;
    const vx = -((x1 - x0) / dt) / s;
    const vy = -((y1 - y0) / dt) / s;
    if (Math.hypot(vx, vy) * s > 0.25) {
      motion.current = { kind: "inertia", vx, vy };
      requestFrame();
    }
  };

  useEffect(() => {
    const host = hostRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camera.current;
      if (!cam) return;
      const [sx, sy] = devicePoint(e);
      const vp = viewport.current;
      const pinch = e.ctrlKey;
      const mouseWheel = !pinch && (e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY)));
      if (pinch) {
        motion.current = null;
        camera.current = zoomAtPoint(cam, sx, sy, Math.exp(-e.deltaY * 0.012));
      } else if (mouseWheel) {
        const factor = Math.exp(-e.deltaY * 0.0025 * (e.deltaMode === 1 ? 33 : 1));
        const m = motion.current;
        if (reducedMotion()) {
          camera.current = zoomAtPoint(cam, sx, sy, factor);
        } else if (m?.kind === "zoom") {
          m.target = clampScale(m.target * factor, W, H, vp);
          m.sx = sx;
          m.sy = sy;
        } else {
          motion.current = { kind: "zoom", sx, sy, target: clampScale(cam.scale * factor, W, H, vp) };
        }
      } else {
        motion.current = null;
        const k = panelShrink(panelAt(sx, sy).rect, vp.width, vp.height);
        camera.current = clampCenter({ ...cam, cx: cam.cx + (e.deltaX * vp.dpr) / (cam.scale * k), cy: cam.cy + (e.deltaY * vp.dpr) / (cam.scale * k) }, W, H);
      }
      requestFrame();
      updateCursor(sx, sy);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [dataset.id, W, H, requestFrame, zoomAtPoint, panelAt]);

  const onDoubleClick = (e: React.MouseEvent) => {
    const cam = camera.current;
    if (!cam) return;
    const [sx, sy] = devicePoint(e);
    fly(zoomAtPoint(cam, sx, sy, e.altKey ? 0.5 : 2));
  };

  const onMinimap = (e: React.PointerEvent) => {
    e.stopPropagation();
    const cam = camera.current;
    if (!cam || (e.type === "pointermove" && e.buttons !== 1)) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = W / MINIMAP_CSS;
    const target = { ...cam, cx: (e.clientX - rect.left) * k, cy: (e.clientY - rect.top) * k };
    if (e.type === "pointerdown") {
      (e.target as Element).setPointerCapture(e.pointerId);
      fly(target);
    } else {
      motion.current = null;
      camera.current = clampCenter(target, W, H);
      requestFrame();
    }
  };

  const view = useStudio((s) => s.view);
  const minimapHeight = (MINIMAP_CSS * H) / W;

  return (
    <div
      ref={hostRef}
      className="viewer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} className="viewer-canvas" />
      {error && <div className="viewer-error">{error}</div>}
      {overlay.scan && (
        <div className="scan-curtain" style={{
          transform: `translate(${overlay.scan.x}px, ${overlay.scan.y}px)`, width: overlay.scan.width, height: overlay.scan.below,
        }}>
          {overlay.scan.line && <div className="scanline" />}
        </div>
      )}
      {overlay.labels.map((l) => (
        <div key={l.key} className="panel-label" style={{ transform: `translate(${l.x}px, ${l.y}px)`, opacity: overlay.labelOpacity }}>
          {l.color && <span className="sw" style={{ background: l.color }} />}
          {l.name}
        </div>
      ))}
      {options.minimap && overlay.minimap && (
        <div className="minimap" style={{ width: MINIMAP_CSS, height: minimapHeight }}
          onPointerDown={onMinimap} onPointerMove={onMinimap} onDoubleClick={(e) => e.stopPropagation()}>
          <span className="minimap-vp" style={{
            left: Math.max(0, overlay.minimap[0]), top: Math.max(0, overlay.minimap[1]),
            width: Math.min(MINIMAP_CSS, overlay.minimap[2]), height: Math.min(minimapHeight, overlay.minimap[3]),
          }} />
        </div>
      )}
      {overlay.bar && (
        <div className="scalebar">
          {overlay.bar.label}
          <div className="scalebar-bar" style={{ width: overlay.bar.cssPx }} />
        </div>
      )}
      <div className="zoom" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className={`ib${options.gallery ? " on" : ""}`} title="Channel gallery (G)"
          onClick={() => setOption("gallery", !options.gallery)}><LayoutGrid /></button>
        <span className="zoom-sep" />
        <button className="ib" title="Zoom out (⌘−)" onClick={() => command("zoom-out")}><Minus /></button>
        <button className="zoom-value" title="Actual pixels (⌘1)" onClick={() => command("actual")}>
          {view ? fmtZoom(view.scale) : "—"}
        </button>
        <button className="ib" title="Zoom in (⌘=)" onClick={() => command("zoom-in")}><Plus /></button>
        <button className="ib" title="Fit to window (⌘0)" onClick={() => command("fit")}><Maximize /></button>
      </div>
    </div>
  );
}

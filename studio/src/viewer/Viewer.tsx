import { Maximize, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { DatasetInfo } from "../api/types";
import { fmtZoom, hexToRgb } from "../lib/format";
import { type ChannelDisplay, type Options, useStudio } from "../state/store";
import { type Camera, clampCenter, fit, scaleBar, screenToImage, type Viewport, zoomAt } from "./camera";
import { onViewerCommand, type ViewerCommand } from "./commands";
import { type ChannelUniforms, type Region, Renderer } from "./renderer";
import { TileManager } from "./tiles";

const MINIMAP_CSS = 184;
const MINIMAP_MARGIN_CSS = 12;
const GRID_FROM_SCALE = 8;

interface Props {
  dataset: DatasetInfo;
}

function channelUniforms(ds: DatasetInfo, display: ChannelDisplay[]): { uniforms: ChannelUniforms[]; visible: number[] } {
  const saturation = ds.saturation ?? (ds.dtype.endsWith("u1") ? 255 : 65535);
  const visible: number[] = [];
  const uniforms: ChannelUniforms[] = [];
  display.forEach((d, i) => {
    if (!d.visible) return;
    visible.push(i);
    uniforms.push({ layer: i, lo: d.lo, hi: d.hi, gamma: d.gamma, color: hexToRgb(d.color), saturation });
  });
  return { uniforms, visible };
}

export function Viewer({ dataset }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const tiles = useRef<TileManager | null>(null);
  const camera = useRef<Camera | null>(null);
  const viewport = useRef<Viewport>({ width: 1, height: 1, dpr: 1 });
  const frameRequested = useRef(false);
  const drag = useRef<{ x: number; y: number; cam: Camera } | null>(null);
  const pixelAbort = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<{ vp: [number, number, number, number] | null; bar: ReturnType<typeof scaleBar> | null }>(
    { vp: null, bar: null });

  const setView = useStudio((s) => s.setView);
  const setCursor = useStudio((s) => s.setCursor);
  const options = useStudio((s) => s.options);
  const optionsRef = useRef<Options>(options);
  optionsRef.current = options;

  const draw = useCallback(() => {
    frameRequested.current = false;
    const r = renderer.current;
    const tm = tiles.current;
    const cam = camera.current;
    if (!r || !tm || !cam) return;
    const vp = viewport.current;
    const display = useStudio.getState().display[dataset.id] ?? [];
    const { uniforms, visible } = channelUniforms(dataset, display);
    const opts = optionsRef.current;
    r.setChannels(uniforms);
    r.resize(vp.width, vp.height);
    r.clear();

    const plan = tm.plan(cam, vp, visible, opts.smooth);
    const grid = opts.grid && cam.scale >= GRID_FROM_SCALE ? Math.min(1, (cam.scale - GRID_FROM_SCALE) / 8 + 0.35) : 0;
    const full: Region = { x: 0, y: 0, width: vp.width, height: vp.height };
    r.begin(full, cam, { clip: opts.clip, grid });
    for (const d of plan.draws) r.draw(d);
    r.end();

    let vpRect: [number, number, number, number] | null = null;
    if (opts.minimap) {
      const m = MINIMAP_CSS * vp.dpr;
      const mh = Math.round((m * dataset.height) / dataset.width);
      const region: Region = { x: vp.width - m - MINIMAP_MARGIN_CSS * vp.dpr, y: MINIMAP_MARGIN_CSS * vp.dpr,
        width: Math.round(m), height: mh };
      r.clear(region);
      r.begin(region, { cx: dataset.width / 2, cy: dataset.height / 2, scale: m / dataset.width }, { clip: false, grid: 0 });
      for (const d of tm.overview(visible)) r.draw(d);
      r.end();
      const [x0, y0] = screenToImage(cam, vp, 0, 0);
      const [x1, y1] = screenToImage(cam, vp, vp.width, vp.height);
      const k = MINIMAP_CSS / dataset.width;
      vpRect = [x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k];
    }

    const cssPerImage = cam.scale / vp.dpr;
    setView({ scale: cam.scale, level: plan.level, cssPxPerImagePx: cssPerImage });
    const bar = dataset.pixel_size_um ? scaleBar(dataset.pixel_size_um / cssPerImage) : null;
    setOverlay((prev) =>
      prev.bar?.cssPx === bar?.cssPx && prev.bar?.label === bar?.label && prev.vp?.join() === vpRect?.join()
        ? prev
        : { vp: vpRect, bar });
  }, [dataset, setView]);

  const requestFrame = useCallback(() => {
    if (frameRequested.current) return;
    frameRequested.current = true;
    requestAnimationFrame(draw);
  }, [draw]);

  // GL setup per dataset
  useEffect(() => {
    const canvas = canvasRef.current!;
    try {
      renderer.current = new Renderer(canvas);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    tiles.current = new TileManager(renderer.current.gl, dataset, requestFrame);
    camera.current = null;
    return () => {
      tiles.current?.dispose();
      tiles.current = null;
      renderer.current = null;
    };
  }, [dataset.id]);

  // size
  useEffect(() => {
    const host = hostRef.current!;
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = host.getBoundingClientRect();
      viewport.current = { width: Math.max(1, Math.round(rect.width * dpr)), height: Math.max(1, Math.round(rect.height * dpr)), dpr };
      if (!camera.current) camera.current = fit(dataset.width, dataset.height, viewport.current);
      requestFrame();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [dataset.id, dataset.width, dataset.height, requestFrame]);

  // redraw on display / option changes and build progress
  useEffect(() => useStudio.subscribe((s, prev) => {
    if (s.display[dataset.id] !== prev.display[dataset.id] || s.options !== prev.options) requestFrame();
    const build = s.datasets[dataset.id]?.build;
    if (build && build !== prev.datasets[dataset.id]?.build) tiles.current?.onBuild(build.rows_ready);
  }), [dataset.id, requestFrame]);

  const command = useCallback((cmd: ViewerCommand) => {
    const cam = camera.current;
    if (!cam) return;
    const vp = viewport.current;
    switch (cmd) {
      case "zoom-in":
        camera.current = zoomAt(cam, vp, vp.width / 2, vp.height / 2, 2, dataset.width, dataset.height);
        break;
      case "zoom-out":
        camera.current = zoomAt(cam, vp, vp.width / 2, vp.height / 2, 0.5, dataset.width, dataset.height);
        break;
      case "fit":
        camera.current = fit(dataset.width, dataset.height, vp);
        break;
      case "actual":
        camera.current = zoomAt(cam, vp, vp.width / 2, vp.height / 2, 1 / cam.scale, dataset.width, dataset.height);
        break;
      default: {
        const unreachable: never = cmd;
        throw new Error(`unknown viewer command ${unreachable}`);
      }
    }
    requestFrame();
  }, [dataset.width, dataset.height, requestFrame]);

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
    const [fx, fy] = screenToImage(cam, viewport.current, sx, sy);
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    if (x < 0 || y < 0 || x >= dataset.width || y >= dataset.height) {
      setCursor(null);
      return;
    }
    const values = dataset.channels.map((_, c) => tm.valueAt(x, y, c));
    setCursor({ x, y, values });
    if (values.some((v) => v === null)) {
      pixelAbort.current?.abort();
      const ctl = (pixelAbort.current = new AbortController());
      api.pixel(dataset.id, x, y, ctl.signal)
        .then((r) => {
          const cur = useStudio.getState().cursor;
          if (cur && cur.x === x && cur.y === y) setCursor({ x, y, values: r.values });
        })
        .catch(() => undefined);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !camera.current) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const [x, y] = devicePoint(e);
    drag.current = { x, y, cam: camera.current };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [x, y] = devicePoint(e);
    const d = drag.current;
    if (d) {
      camera.current = clampCenter({ ...d.cam, cx: d.cam.cx - (x - d.x) / d.cam.scale, cy: d.cam.cy - (y - d.y) / d.cam.scale },
        dataset.width, dataset.height);
      requestFrame();
    }
    updateCursor(x, y);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
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
      if (pinch || mouseWheel) {
        const factor = Math.exp(-e.deltaY * (pinch ? 0.012 : 0.0025) * (e.deltaMode === 1 ? 33 : 1));
        camera.current = zoomAt(cam, vp, sx, sy, factor, dataset.width, dataset.height);
      } else {
        camera.current = clampCenter({ ...cam, cx: cam.cx + (e.deltaX * vp.dpr) / cam.scale, cy: cam.cy + (e.deltaY * vp.dpr) / cam.scale },
          dataset.width, dataset.height);
      }
      requestFrame();
      updateCursor(sx, sy);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [dataset.id, dataset.width, dataset.height, requestFrame]);

  const onDoubleClick = (e: React.MouseEvent) => {
    const cam = camera.current;
    if (!cam) return;
    const [sx, sy] = devicePoint(e);
    camera.current = zoomAt(cam, viewport.current, sx, sy, e.altKey ? 0.5 : 2, dataset.width, dataset.height);
    requestFrame();
  };

  const onMinimap = (e: React.PointerEvent) => {
    e.stopPropagation();
    const cam = camera.current;
    if (!cam || (e.type === "pointermove" && e.buttons !== 1)) return;
    if (e.type === "pointerdown") (e.target as Element).setPointerCapture(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = dataset.width / MINIMAP_CSS;
    camera.current = clampCenter({ ...cam, cx: (e.clientX - rect.left) * k, cy: (e.clientY - rect.top) * k }, dataset.width, dataset.height);
    requestFrame();
  };

  const build = dataset.build;
  const view = useStudio((s) => s.view);
  const minimapHeight = (MINIMAP_CSS * dataset.height) / dataset.width;

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
      {options.minimap && overlay.vp && (
        <div className="minimap" style={{ width: MINIMAP_CSS, height: minimapHeight }}
          onPointerDown={onMinimap} onPointerMove={onMinimap} onDoubleClick={(e) => e.stopPropagation()}>
          <span className="minimap-vp" style={{
            left: Math.max(0, overlay.vp[0]), top: Math.max(0, overlay.vp[1]),
            width: Math.min(MINIMAP_CSS, overlay.vp[2]), height: Math.min(minimapHeight, overlay.vp[3]),
          }} />
        </div>
      )}
      {overlay.bar && (
        <div className="scalebar">
          {overlay.bar.label}
          <div className="scalebar-bar" style={{ width: overlay.bar.cssPx }} />
        </div>
      )}
      {build.state === "building" || build.state === "queued" ? (
        <div className="build-strip" title="Building the zoom pyramid from the source file">
          <span style={{ width: `${build.progress * 100}%` }} />
        </div>
      ) : null}
      <div className="zoom" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className="ib" title="Zoom out (⌘−)" onClick={() => command("zoom-out")}><Minus /></button>
        <button className="zoom-value" title="Actual pixels (⌘1)" onClick={() => command("actual")}>
          {view ? fmtZoom(view.scale) : "—"}
        </button>
        <button className="ib" title="Zoom in (⌘=)" onClick={() => command("zoom-in")}><Plus /></button>
        <button className="ib zoom-fit" title="Fit to window (⌘0)" onClick={() => command("fit")}><Maximize /></button>
      </div>
    </div>
  );
}

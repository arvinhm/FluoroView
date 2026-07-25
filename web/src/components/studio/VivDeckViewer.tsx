import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Deck, OrthographicView } from "@deck.gl/core";
import { PolygonLayer } from "@deck.gl/layers";
import { MultiscaleImageLayer, ImageLayer, ColorPaletteExtension, MAX_CHANNELS } from "@hms-dbmi/viv";
import { Maximize2, ZoomIn, ZoomOut, Hand, Square, Circle as CircleIcon, PenTool, ScanSearch, Crosshair } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import type { RoiShape } from "../../lib/types";
import { pickCompositedChannels, safeContrastLimits, safeGamma } from "../../lib/channelGuards";
import { fitRect, type ViewTransform } from "../../lib/compositor";
import { clampPan, contentInViewport, fitView, nearestContent, viewportNorm } from "../../lib/viewport";
import { clusterColor, scaleRgb } from "../../lib/palette";
import { niceNumber } from "../../lib/format";
import { roiBounds, translateShape, pointInShape } from "../../lib/roi";
import { histogramFromLoader } from "../../lib/histogram";
import { chaikinClosed, dedupeRing } from "../../lib/geometry";
import GammaContrastExtension from "../../lib/viv/GammaContrastExtension";
import { Panel } from "../ui";
import RoiAnalysis from "./RoiAnalysis";
import { Minimap, type ViewportRect } from "./Minimap";
import { ScaleBarCalibrator } from "./ScaleBarCalibrator";
import { ChannelPanel, RoiListPanel, ToolBtn, roundRect, hexA } from "./ViewerPanels";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 60;

type RoiTool = "pan" | "rect" | "circle" | "polygon";

interface V {
  zoom: number;
  panX: number;
  panY: number;
}

type DrawState =
  | { kind: "rect" | "circle"; x0: number; y0: number; x: number; y: number }
  | { kind: "polygon"; points: [number, number][]; cur: [number, number] };

/**
 * Full-resolution pyramid viewer for the real multiplex scan.
 *
 * - The image is a tiled multi-resolution OME-TIFF rendered by Viv's
 *   `MultiscaleImageLayer` (deck.gl): zooming streams higher-res tiles, so real
 *   detail appears instead of an upscaled bitmap, and memory stays bounded.
 * - Cell boundaries are VECTOR polygons (extracted from the full-res label mask)
 *   drawn by a deck.gl `PolygonLayer` — razor-sharp at any zoom, no blocky raster.
 * - Pan/zoom + ROI tooling reuse the proven interaction model (viewRef + fitRect),
 *   feeding deck a controlled OrthographicView state so the image, the boundaries
 *   and the overlay (ROIs / scale bar / hover) share one exact transform.
 */
export default function VivDeckViewer() {
  const tissue = useStore((s) => s.tissue);
  const scanMeta = useStore((s) => s.scanMeta);
  const imageSource = useStore((s) => s.imageSource);
  const datasetId = useStore((s) => s.datasetId);
  const boundaryPolys = useStore((s) => s.boundaryPolys);
  const channels = useStore((s) => s.channels);
  const activeChannels = useStore((s) => s.activeChannels);
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
  const setChannelStat = useStore((s) => s.setChannelStat);
  const maps = useStore((s) => s.maps);
  const contentExtent = useStore((s) => s.contentExtent);
  const [roiTool, setRoiTool] = useState<RoiTool>("pan");
  const [lostInVoid, setLostInVoid] = useState(false);

  // Display-only smoothed outlines (Chaikin). The TRUE mask/centroids still
  // drive analysis & ROI membership — smoothing never touches accuracy.
  const smoothedBoundaries = useMemo(() => {
    if (!boundaryPolys) return null;
    return boundaryPolys.map((b) => ({ id: b.id, path: chaikinClosed(dedupeRing(b.path, 0.6), 2) }));
  }, [boundaryPolys]);

  // world image size (native full-resolution pixels)
  const imgW = scanMeta?.width ?? tissue?.width ?? 1;
  const imgH = scanMeta?.height ?? tissue?.height ?? 1;

  const presets = useMemo(() => {
    const names = activeChannels.map((c) => c.name);
    const defaults = activeChannels.filter((c) => c.defaultOn).map((c) => c.name);
    const nuclear = activeChannels.filter((c) => c.kind === "nuclear").map((c) => c.name);
    const out: { name: string; markers: string[] }[] = [{ name: "Default", markers: defaults.length ? defaults : names }];
    if (nuclear.length) out.push({ name: "Nuclei", markers: nuclear });
    out.push({ name: "All", markers: names });
    return out;
  }, [activeChannels]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const deckCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const prevRoiCount = useRef(0);
  const deckRef = useRef<Deck | null>(null);
  const viewRef = useRef<V>({ zoom: 1, panX: 0, panY: 0 });
  // Read inside the RAF loop and native listeners, which must always see the
  // extent of the dataset that is on screen right now.
  const extentRef = useRef(contentExtent);
  const hadContentRef = useRef(true);
  const minimapRectRef = useRef<ViewportRect>({ x0: 0, y0: 0, x1: 1, y1: 1 });
  const rafRef = useRef(0);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const drawRef = useRef<DrawState | null>(null);
  const moveRef = useRef<{ id: number; lastTx: number; lastTy: number } | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; name: string; color: string } | null>(null);
  const scheduleRef = useRef<() => void>(() => {});

  const getVT = useCallback((): ViewTransform => {
    const el = wrapRef.current!;
    return { zoom: viewRef.current.zoom, panX: viewRef.current.panX, panY: viewRef.current.panY, canvasW: el.clientWidth, canvasH: el.clientHeight };
  }, []);

  /** deck OrthographicView state derived from the same fitRect transform the
   *  overlay uses, so image + boundaries + overlay stay pixel-aligned. */
  const deckViewState = useCallback(() => {
    const el = wrapRef.current!;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const rect = fitRect(imgW, imgH, getVT());
    const k = rect.s; // screen px per world (image) px
    return {
      target: [(cw / 2 - rect.x) / k, (ch / 2 - rect.y) / k, 0] as [number, number, number],
      zoom: Math.log2(k),
    };
  }, [getVT, imgW, imgH]);

  // ---- deck.gl layers (image pyramid + vector boundaries) ----
  const buildLayers = useCallback(() => {
    const layers: unknown[] = [];
    if (imageSource && imageSource.length) {
      const usable = channels.filter((c) => c.index < activeChannels.length);
      const picked = pickCompositedChannels(usable, MAX_CHANNELS);
      if (picked.length) {
        const multiscale = imageSource.length > 1;
        const selections = picked.map((i) => ({ c: i, z: 0, t: 0 }));
        // Per-channel appearance → Viv props. Opacity is folded into the LUT color
        // (additive blend), gamma is applied by GammaContrastExtension.
        const colors = picked.map((i) => scaleRgb(channels[i].color, channels[i].opacity));
        const channelsVisible = picked.map((i) => channels[i].visible);
        const contrastLimits = picked.map((i) => safeContrastLimits(channels[i]));
        const gammas = picked.map((i) => safeGamma(channels[i].gamma));
        const props = {
          // The id carries the dataset so switching datasets builds a NEW layer:
          // deck's tile cache lives on the layer instance, so a shared id made it
          // paint the previous dataset's tiles under the new one.
          id: `viv-image-${datasetId}`,
          loader: multiscale ? imageSource : imageSource[0],
          selections,
          contrastLimits,
          colors,
          channelsVisible,
          gammas,
          extensions: [new ColorPaletteExtension(), new GammaContrastExtension()],
        };
        layers.push(multiscale ? new MultiscaleImageLayer(props as never) : new ImageLayer(props as never));
      }
    }
    if (segmented && smoothedBoundaries && smoothedBoundaries.length) {
      layers.push(
        new PolygonLayer({
          id: "cell-boundaries",
          data: smoothedBoundaries,
          getPolygon: (d: { path: [number, number][] }) => d.path,
          stroked: true,
          filled: false,
          getLineColor: [103, 232, 249, 205],
          lineWidthUnits: "pixels",
          getLineWidth: 1,
          lineWidthMinPixels: 0.75,
          lineWidthMaxPixels: 2,
          pickable: false,
          parameters: { depthTest: false },
        } as never)
      );
    }
    return layers;
  }, [imageSource, activeChannels, channels, segmented, smoothedBoundaries, datasetId]);

  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const el = wrapRef.current;
    if (!overlay || !el) return;
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
    const rect = fitRect(imgW, imgH, vt);
    const k = rect.s;
    const toX = (tx: number) => rect.x + tx * k;
    const toY = (ty: number) => rect.y + ty * k;

    // ROIs (rect / circle / polygon), labels at fixed screen size.
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

    // scale bar — pixels (no physical µm metadata for this scan). World units are
    // native full-resolution pixels, so the count reflects real image pixels.
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
      // Sit above the bottom-right minimap so the two never overlap.
      const bx = cw - barPx - 24;
      const by = ch - 140;
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
  }, [imgW, imgH, rois, selectedRoiId, pixelSizeUm, getVT]);

  /** Keep the tissue reachable: pan can never carry the data off screen. Applied
   *  in the render funnel so every path (drag, wheel, keys, minimap) is covered. */
  const clampView = useCallback(() => {
    const el = wrapRef.current;
    if (!el || !el.clientWidth || !el.clientHeight) return;
    const next = clampPan(viewRef.current, extentRef.current, imgW, imgH, el.clientWidth, el.clientHeight);
    viewRef.current.panX = next.panX;
    viewRef.current.panY = next.panY;
  }, [imgW, imgH]);

  const render = useCallback(() => {
    clampView();
    const deck = deckRef.current;
    if (deck) deck.setProps({ viewState: deckViewState() } as never);
    drawOverlay();
    const el = wrapRef.current;
    if (el) {
      const nr = viewportNorm(imgW, imgH, getVT());
      minimapRectRef.current = nr;
      // The clamp only guarantees the data's bounding box stays in reach; a thin
      // diagonal strip still leaves that box mostly empty, so tell the user when
      // they are looking at pure background instead of letting the view look broken.
      const has = contentInViewport(extentRef.current, nr);
      if (has !== hadContentRef.current) {
        hadContentRef.current = has;
        setLostInVoid(!has);
      }
    }
  }, [clampView, deckViewState, drawOverlay, getVT, imgW, imgH]);

  /** Recenter the view so world point (wx,wy) sits at the viewport center. */
  const centerOnWorld = useCallback(
    (wx: number, wy: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      const rect = fitRect(imgW, imgH, getVT());
      const s = rect.s;
      viewRef.current.panX = cw / 2 - (cw - imgW * s) / 2 - wx * s;
      viewRef.current.panY = ch / 2 - (ch - imgH * s) / 2 - wy * s;
      scheduleRef.current();
    },
    [getVT, imgW, imgH]
  );

  const schedule = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(render);
  }, [render]);

  useEffect(() => {
    scheduleRef.current = schedule;
  }, [schedule]);

  useEffect(() => {
    extentRef.current = contentExtent;
  }, [contentExtent]);

  // init deck
  useEffect(() => {
    const canvas = deckCanvasRef.current;
    if (!canvas) return;
    const deck = new Deck({
      canvas,
      views: [new OrthographicView({ id: "ortho", flipY: true })],
      controller: false,
      viewState: deckViewState(),
      layers: buildLayers(),
      useDevicePixels: true,
    } as never);
    deckRef.current = deck;
    schedule();
    return () => {
      deck.finalize();
      deckRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // rebuild layers when appearance / segmentation changes
  useEffect(() => {
    const deck = deckRef.current;
    if (deck) deck.setProps({ layers: buildLayers() } as never);
  }, [buildLayers]);

  // Compute per-channel histograms + auto contrast from the coarsest pyramid
  // level once the image source is ready (a few thousand pixels → ~1 frame).
  useEffect(() => {
    if (!imageSource || !imageSource.length) return;
    let cancelled = false;
    void (async () => {
      const chs = useStore.getState().channels;
      const existing = useStore.getState().channelStats;
      for (let i = 0; i < chs.length; i++) {
        // Uploads measure their histograms while decoding (on a much larger
        // sample than the coarsest tile) — don't overwrite those.
        if (existing[i]) continue;
        try {
          const hist = await histogramFromLoader(imageSource as never, { c: chs[i].index, z: 0, t: 0 }, 128, chs[i].domain);
          if (cancelled) return;
          setChannelStat(i, hist, true);
        } catch {
          /* channel raster unavailable — leave stats null (panel degrades gracefully) */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageSource, setChannelStat]);

  useEffect(() => {
    schedule();
  }, [rois, selectedRoiId, segmented, schedule]);

  // bring analysis panel into view when a new ROI is drawn
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
    const ro = new ResizeObserver(() => scheduleRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  /** Zoom keeping the image point under (clientX, clientY) fixed on screen. */
  const zoomAtPoint = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const sx = clientX - r.left;
      const sy = clientY - r.top;
      const before = fitRect(imgW, imgH, getVT());
      const kb = before.s;
      const tx = (sx - before.x) / kb;
      const ty = (sy - before.y) / kb;
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, viewRef.current.zoom * factor));
      viewRef.current.zoom = next;
      const after = fitRect(imgW, imgH, getVT());
      const ka = after.s;
      const wAfter = imgW * after.s;
      const hAfter = imgH * after.s;
      viewRef.current.panX = sx - tx * ka - (el.clientWidth - wAfter) / 2;
      viewRef.current.panY = sy - ty * ka - (el.clientHeight - hAfter) / 2;
      setZoomPct(Math.round((after.s / after.base) * 100));
      scheduleRef.current();
    },
    [getVT, imgW, imgH]
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

  /** Frame the TISSUE, not the blank canvas around it. */
  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el || !el.clientWidth) return;
    const v = fitView(extentRef.current, imgW, imgH, el.clientWidth, el.clientHeight, { zoomMin: ZOOM_MIN, zoomMax: ZOOM_MAX });
    viewRef.current = v;
    setZoomPct(Math.round(v.zoom * 100));
    scheduleRef.current();
  }, [imgW, imgH]);

  /** Keep the current magnification, jump to the nearest tissue. */
  const recenterOnContent = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const nr = viewportNorm(imgW, imgH, getVT());
    const t = nearestContent(extentRef.current, (nr.x0 + nr.x1) / 2, (nr.y0 + nr.y1) / 2);
    centerOnWorld(t.x * imgW, t.y * imgH);
  }, [centerOnWorld, getVT, imgW, imgH]);

  const oneToOne = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const base = Math.min(el.clientWidth / imgW, el.clientHeight / imgH) || 1;
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, 1 / base));
    const e = extentRef.current;
    viewRef.current.zoom = zoom;
    setZoomPct(Math.round(zoom * 100));
    // Stay on the tissue when switching to actual pixels.
    centerOnWorld(((e.x0 + e.x1) / 2) * imgW, ((e.y0 + e.y1) / 2) * imgH);
  }, [centerOnWorld, imgW, imgH]);

  // Open every dataset framed on its own tissue (and re-frame when it changes),
  // so a scan whose signal fills a fraction of the canvas is never off screen.
  useEffect(() => {
    fit();
  }, [datasetId, contentExtent, fit]);

  const onDoubleClick = (e: React.MouseEvent) => zoomAtPoint(e.clientX, e.clientY, e.altKey ? 1 / 1.6 : 1.6);

  // non-passive wheel so the page never scrolls while zooming over the canvas
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= el.clientHeight;
      const intensity = e.ctrlKey ? 0.01 : 0.0025;
      zoomAtPoint(e.clientX, e.clientY, Math.exp(-dy * intensity));
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [zoomAtPoint]);

  // keyboard zoom + tool shortcuts
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
      } else if (e.key === "Escape") {
        drawRef.current = null;
        setRoiTool("pan");
        scheduleRef.current();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedRoiId != null) {
        e.preventDefault();
        removeRoi(selectedRoiId);
      } else {
        const key = e.key.toLowerCase();
        if (key === "v") setRoiTool("pan");
        else if (key === "r") setRoiTool("rect");
        else if (key === "c") setRoiTool("circle");
        else if (key === "p") setRoiTool("polygon");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomByCenter, fit, oneToOne, selectedRoiId, removeRoi]);

  const screenToWorld = (clientX: number, clientY: number) => {
    const el = wrapRef.current!;
    const r = el.getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const rect = fitRect(imgW, imgH, getVT());
    const k = rect.s;
    return { tx: (sx - rect.x) / k, ty: (sy - rect.y) / k, sx, sy };
  };

  const finishShape = (shape: RoiShape, minPx = 6) => {
    const b = roiBounds(shape);
    if (shape.kind !== "polygon" && Math.max(b.w, b.h) < minPx) return;
    addRoi({ id: Date.now(), label: `ROI ${rois.length + 1}`, color: clusterColor(rois.length), shape, comments: [] });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = screenToWorld(e.clientX, e.clientY);
    if (roiTool === "rect" || roiTool === "circle") {
      drawRef.current = { kind: roiTool, x0: p.tx, y0: p.ty, x: p.tx, y: p.ty };
      return;
    }
    if (roiTool === "polygon") {
      drawRef.current = { kind: "polygon", points: [[p.tx, p.ty]], cur: [p.tx, p.ty] };
      return;
    }
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
    if (d) {
      const p = screenToWorld(e.clientX, e.clientY);
      if (d.kind === "polygon") {
        const rect = fitRect(imgW, imgH, getVT());
        const k = rect.s;
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
      const p = screenToWorld(e.clientX, e.clientY);
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
    // hover to identify the nearest cell (tolerance in world px², generous so a
    // cell is easy to hit even when zoomed out)
    if (tissue) {
      const p = screenToWorld(e.clientX, e.clientY);
      let best: (typeof tissue.cells)[number] | null = null;
      let bd = 30 * 30;
      for (const c of tissue.cells) {
        const dd = (c.x - p.tx) ** 2 + (c.y - p.ty) ** 2;
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      if (best) setHoverInfo({ x: p.sx, y: p.sy, name: `Cell #${best.id}`, color: "#67e8f9" });
      else setHoverInfo(null);
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
          <div className="absolute left-3 top-3 z-20 flex flex-wrap items-center gap-1.5">
            {presets.map((p) => (
              <button
                key={p.name}
                onClick={() => (p.name === "All" ? showAllChannels() : presetChannels(p.markers))}
                className="rounded-full glass px-3 py-1 text-xs font-medium text-white/70 transition hover:text-white"
              >
                {p.name}
              </button>
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
            <ToolBtn onClick={fit} title="Fit tissue to view (0)"><Maximize2 className="h-4 w-4" /></ToolBtn>
            <ToolBtn onClick={oneToOne} title="Actual pixels (1)"><span className="text-[11px] font-bold leading-none">1:1</span></ToolBtn>
            <ToolBtn active={segmented} onClick={() => setSegmented(!segmented, "manual")} title="Toggle segmentation"><ScanSearch className="h-4 w-4" /></ToolBtn>
          </div>

          <div
            ref={wrapRef}
            className={clsx("relative h-[420px] w-full select-none touch-none overscroll-contain sm:h-[560px] lg:h-[640px]", roiTool !== "pan" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => {
              onPointerUp();
              setHoverInfo(null);
            }}
            onDoubleClick={onDoubleClick}
          >
            <canvas ref={deckCanvasRef} className="absolute inset-0 h-full w-full" />
            <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
            {hoverInfo && (
              <div className="pointer-events-none absolute z-20 flex items-center gap-1.5 rounded-lg glass-strong px-2 py-1 text-xs" style={{ left: hoverInfo.x + 14, top: hoverInfo.y + 14 }}>
                <span className="h-2 w-2 rounded-full" style={{ background: hoverInfo.color }} />
                {hoverInfo.name}
              </div>
            )}
            {lostInVoid && (
              <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-3">
                <button
                  onClick={recenterOnContent}
                  className="pointer-events-auto flex items-center gap-2 rounded-xl glass-strong px-3.5 py-2 text-sm font-semibold text-white shadow-panel ring-1 ring-cyan-400/40 transition hover:ring-cyan-300"
                >
                  <Crosshair className="h-4 w-4 shrink-0 text-cyan-300" />
                  Recenter on tissue
                  <span className="hidden text-xs font-normal text-white/50 sm:inline">this area is empty background</span>
                </button>
              </div>
            )}
            <div className="absolute bottom-3 left-3 z-20 flex flex-col items-start gap-1.5">
              <ScaleBarCalibrator />
              <div className="pointer-events-none rounded-lg glass px-2.5 py-1 font-mono text-[11px] text-white/60">
                {zoomPct}% · {roiTool === "pan" ? "scroll = zoom · drag = pan" : `${roiTool} ROI — drag to draw · Esc cancels`}
              </div>
            </div>
            <Minimap maps={maps} channels={channels} rectRef={minimapRectRef} onNavigate={(nx, ny) => centerOnWorld(nx * imgW, ny * imgH)} />
          </div>
        </Panel>

        <ChannelPanel />
      </div>
      <RoiListPanel />
      <div ref={inspectorRef}>
        <RoiAnalysis />
      </div>
    </div>
  );
}

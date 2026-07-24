import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { ChannelState } from "../../lib/types";
import type { ChannelMaps } from "../../lib/synth";
import { hexToRgb } from "../../lib/palette";

export interface ViewportRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Whole-slide minimap: a small composited thumbnail (from the bounded intensity
 * `maps`, which exist for both the Viv pyramid and synthetic paths) with a live
 * rectangle showing the current viewport. Click or drag to recenter the main
 * view. The rectangle tracks pan/zoom via `rectRef`, which the parent updates
 * inside its own render loop (outside React), so a lightweight RAF here keeps
 * the overlay in sync without re-rendering the component.
 */
export function Minimap({
  maps,
  channels,
  rectRef,
  onNavigate,
  width = 176,
}: {
  maps: ChannelMaps | null;
  channels: ChannelState[];
  rectRef: MutableRefObject<ViewportRect>;
  onNavigate: (nx: number, ny: number) => void;
  width?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thumbRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);

  const aspect = maps ? maps.width / maps.height : 1.5;
  const height = Math.round(width / aspect);

  // Rebuild the thumbnail whenever the maps or channel appearance change.
  useEffect(() => {
    if (!maps) return;
    const tw = width;
    const th = height;
    const off = document.createElement("canvas");
    off.width = tw;
    off.height = th;
    const ctx = off.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(tw, th);
    const cols = channels.map((c) => hexToRgb(c.color));
    const win = channels.map((c) => {
      const [dlo, dhi] = c.domain;
      const range = Math.max(1, dhi - dlo);
      const lo = (c.contrastLimits[0] - dlo) / range;
      const hi = Math.max(lo + 1e-4, (c.contrastLimits[1] - dlo) / range);
      return { lo, hi, gamma: c.gamma, opacity: c.opacity, visible: c.visible };
    });
    const sx = maps.width / tw;
    const sy = maps.height / th;
    for (let y = 0; y < th; y++) {
      const myRow = Math.min(maps.height - 1, (y * sy) | 0) * maps.width;
      for (let x = 0; x < tw; x++) {
        const src = myRow + Math.min(maps.width - 1, (x * sx) | 0);
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < channels.length; i++) {
          const w = win[i];
          if (!w.visible) continue;
          const inten = maps.maps[i][src] / 255;
          let t = Math.min(1, Math.max(0, (inten - w.lo) / (w.hi - w.lo)));
          t = Math.pow(t, 1 / Math.max(0.02, w.gamma)) * w.opacity;
          r += cols[i][0] * t;
          g += cols[i][1] * t;
          b += cols[i][2] * t;
        }
        const o = (y * tw + x) * 4;
        img.data[o] = Math.min(255, r);
        img.data[o + 1] = Math.min(255, g);
        img.data[o + 2] = Math.min(255, b);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    thumbRef.current = off;
  }, [maps, channels, width, height]);

  // RAF: draw thumbnail + current viewport rectangle.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const canvas = canvasRef.current;
      const thumb = thumbRef.current;
      if (canvas && thumb) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
          canvas.width = width * dpr;
          canvas.height = height * dpr;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(thumb, 0, 0, width, height);
          const r = rectRef.current;
          const rx = Math.max(0, Math.min(1, r.x0)) * width;
          const ry = Math.max(0, Math.min(1, r.y0)) * height;
          const rw = Math.max(0, Math.min(1, r.x1 - r.x0)) * width;
          const rh = Math.max(0, Math.min(1, r.y1 - r.y0)) * height;
          ctx.fillStyle = "rgba(103,232,249,0.14)";
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeStyle = "rgba(103,232,249,0.95)";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, rw - 1), Math.max(1, rh - 1));
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [width, height, rectRef]);

  const navFromEvent = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const ny = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    onNavigate(nx, ny);
  };

  if (!maps) return null;

  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 z-20 overflow-hidden rounded-lg border border-white/15 bg-ink-950/70 shadow-panel backdrop-blur">
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="block cursor-pointer touch-none"
        onPointerDown={(e) => {
          e.stopPropagation();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          draggingRef.current = true;
          navFromEvent(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          e.stopPropagation();
          navFromEvent(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          e.stopPropagation();
        }}
      />
    </div>
  );
}

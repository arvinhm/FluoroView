import { useEffect, useRef } from "react";
import type { Histogram } from "../api/types";

interface Props {
  histogram: Histogram | undefined;
  lo: number;
  hi: number;
  color: string;
  onWindow: (lo: number, hi: number) => void;
}

const BASE = "#2e3035";
const INSIDE = "#7d828b";
const HANDLE = "#e6e7e9";

/** Exact whole-image histogram (log counts) with the display window as two draggable edges. */
export function HistogramView({ histogram, lo, hi, color, onWindow }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<"lo" | "hi" | null>(null);
  const span = histogram?.range[1] ?? 65536;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(el.clientWidth * dpr);
    const h = Math.round(el.clientHeight * dpr);
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    const g = el.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const x0 = (lo / span) * w;
    const x1 = (Math.min(hi, span) / span) * w;
    if (histogram && histogram.counts.length) {
      const counts = histogram.counts;
      const top = Math.log1p(Math.max(...counts)) || 1;
      const bw = w / counts.length;
      counts.forEach((n, i) => {
        if (!n) return;
        const bh = (Math.log1p(n) / top) * (h - 3 * dpr);
        const x = i * bw;
        const inside = x + bw > x0 && x < x1;
        g.fillStyle = inside ? INSIDE : BASE;
        g.fillRect(x, h - bh, Math.max(bw, 1), bh);
      });
    }
    g.fillStyle = color;
    g.fillRect(x0, h - 1.5 * dpr, Math.max(x1 - x0, 1), 1.5 * dpr);
    g.fillStyle = HANDLE;
    for (const x of [x0, x1 - dpr]) {
      g.fillRect(x, 0, dpr, h);
      g.fillRect(x - 2 * dpr, 0, 5 * dpr, 5 * dpr);
    }
  }, [histogram, lo, hi, color, span]);

  const valueAt = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * span);
  };

  const apply = (edge: "lo" | "hi", v: number) => {
    if (edge === "lo") onWindow(Math.min(v, hi - 1), hi);
    else onWindow(lo, Math.max(v, lo + 1));
  };

  return (
    <div
      className="hist"
      onPointerDown={(e) => {
        const v = valueAt(e);
        dragging.current = Math.abs(v - lo) <= Math.abs(v - hi) ? "lo" : "hi";
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        apply(dragging.current, v);
      }}
      onPointerMove={(e) => dragging.current && apply(dragging.current, valueAt(e))}
      onPointerUp={() => (dragging.current = null)}
      title="Drag to set the display window"
    >
      <canvas ref={canvas} />
      {!histogram && <span className="hist-pending">reading pixels…</span>}
    </div>
  );
}

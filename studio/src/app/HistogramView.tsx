import { useEffect, useRef, useState } from "react";
import type { Histogram } from "../api/types";
import { fmtInt, hexToRgb } from "../lib/format";
import { ease, tween } from "../motion/motion";

interface Props {
  histogram: Histogram | undefined;
  lo: number;
  hi: number;
  gamma: number;
  color: string;
  log: boolean;
  onWindow: (lo: number, hi: number) => void;
}

const BASE = "#26272c";
const INSIDE = "#7f838d";
const HANDLE = "#ededef";

function heights(h: Histogram | undefined, log: boolean): number[] {
  if (!h || !h.counts.length) return [];
  const f = log ? Math.log1p : (n: number) => n;
  const top = f(Math.max(...h.counts)) || 1;
  return h.counts.map((n) => f(n) / top);
}

/** Exact whole-image histogram with the display window as two draggable edges. New data morphs in. */
export function HistogramView({ histogram, lo, hi, gamma, color, log, onWindow }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const shown = useRef<number[]>([]);
  const [drag, setDrag] = useState<"lo" | "hi" | null>(null);
  const span = histogram?.range[1] ?? 65536;
  const windowRef = useRef({ lo, hi, color, span });
  windowRef.current = { lo, hi, color, span };

  const paint = (bars: number[]) => {
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
    const { lo: l, hi: u, color: c, span: s } = windowRef.current;
    g.clearRect(0, 0, w, h);
    const x0 = (l / s) * w;
    const x1 = (Math.min(u, s) / s) * w;
    const bw = bars.length ? w / bars.length : 0;
    bars.forEach((v, i) => {
      if (v <= 0) return;
      const bh = v * (h - 3 * dpr);
      const x = i * bw;
      g.fillStyle = x + bw > x0 && x < x1 ? INSIDE : BASE;
      g.fillRect(x, h - bh, Math.max(bw - (bw > 3 ? 0.5 : 0), 1), bh);
    });
    g.fillStyle = c;
    g.fillRect(x0, h - 1.5 * dpr, Math.max(x1 - x0, 1), 1.5 * dpr);
    g.fillStyle = HANDLE;
    for (const x of [x0, x1 - dpr]) {
      g.fillRect(x, 0, dpr, h);
      g.fillRect(x - 2 * dpr, 0, 5 * dpr, 5 * dpr);
    }
  };

  useEffect(() => {
    const target = heights(histogram, log);
    const from = shown.current.length === target.length ? shown.current : target.map(() => 0);
    return tween(260, (t) => {
      shown.current = target.map((v, i) => from[i]! + (v - from[i]!) * t);
      paint(shown.current);
    }, ease.outCubic);
  }, [histogram, log]);

  useEffect(() => paint(shown.current), [lo, hi, color, span]);

  const valueAt = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * span);
  };
  const apply = (edge: "lo" | "hi", v: number) => {
    if (edge === "lo") onWindow(Math.min(v, hi - 1), hi);
    else onWindow(lo, Math.max(v, lo + 1));
  };
  const tipValue = drag === "lo" ? lo : hi;

  return (
    <>
      <div
        className="hist"
        onPointerDown={(e) => {
          const v = valueAt(e);
          const edge = Math.abs(v - lo) <= Math.abs(v - hi) ? "lo" : "hi";
          setDrag(edge);
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          apply(edge, v);
        }}
        onPointerMove={(e) => drag && apply(drag, valueAt(e))}
        onPointerUp={() => setDrag(null)}
        title="Drag to set the display window"
      >
        <canvas ref={canvas} />
        {!histogram && <span className="hist-pending">reading pixels…</span>}
        {drag && <span className="hist-tip" style={{ left: `${(Math.min(tipValue, span) / span) * 100}%` }}>{fmtInt(tipValue)}</span>}
      </div>
      <LutRamp lo={lo} hi={hi} gamma={gamma} color={color} span={span} />
    </>
  );
}

/** The display mapping itself: black below the window, rising to the channel colour with gamma. */
function LutRamp({ lo, hi, gamma, color, span }: { lo: number; hi: number; gamma: number; color: string; span: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(el.clientWidth * dpr);
    const h = Math.max(1, Math.round(el.clientHeight * dpr));
    el.width = w;
    el.height = h;
    const g = el.getContext("2d");
    if (!g) return;
    const [r, gg, b] = hexToRgb(color);
    for (let x = 0; x < w; x++) {
      const v = ((x + 0.5) / w) * span;
      const t = Math.min(1, Math.max(0, (v - lo) / Math.max(hi - lo, 1))) ** (1 / Math.max(gamma, 0.01));
      g.fillStyle = `rgb(${Math.round(r * t * 255)},${Math.round(gg * t * 255)},${Math.round(b * t * 255)})`;
      g.fillRect(x, 0, 1, h);
    }
  }, [lo, hi, gamma, color, span]);
  return <div className="lut"><canvas ref={canvas} /></div>;
}

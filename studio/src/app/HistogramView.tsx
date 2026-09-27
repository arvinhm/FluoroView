import { useEffect, useRef, useState } from "react";
import type { Histogram } from "../api/types";
import { fmtInt } from "../lib/format";
import { type ChannelLook, lookup, lutFor } from "../lib/lut";
import { ease, tween } from "../motion/motion";

interface Props {
  histogram: Histogram | undefined;
  lo: number;
  hi: number;
  gamma: number;
  look: ChannelLook;
  log: boolean;
  onWindow: (lo: number, hi: number) => void;
  onGamma: (gamma: number) => void;
}

const BASE = "#26272c";
const INSIDE = "#7f838d";
const HANDLE = "#ededef";
const MID_HANDLE = "#a7a9b0";
const GAMMA_MIN = 0.1;
const GAMMA_MAX = 5;

type Edge = "lo" | "mid" | "hi";

/** Where the midtone handle sits: the value shown at half brightness, as in Photoshop's Levels. */
export function midtone(lo: number, hi: number, gamma: number): number {
  return lo + (hi - lo) * 0.5 ** gamma;
}

/** The gamma that puts the midtone at `v`. */
export function gammaForMidtone(lo: number, hi: number, v: number): number {
  const t = Math.min(0.99, Math.max(0.01, (v - lo) / Math.max(hi - lo, 1)));
  const g = Math.log(t) / Math.log(0.5);
  return Math.round(Math.min(GAMMA_MAX, Math.max(GAMMA_MIN, g)) * 100) / 100;
}

function heights(h: Histogram | undefined, log: boolean): number[] {
  if (!h || !h.counts.length) return [];
  const f = log ? Math.log1p : (n: number) => n;
  const top = f(Math.max(...h.counts)) || 1;
  return h.counts.map((n) => f(n) / top);
}

/** Exact whole-image histogram with black, midtone and white handles (Levels). New data morphs in. */
export function HistogramView({ histogram, lo, hi, gamma, look, log, onWindow, onGamma }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const shown = useRef<number[]>([]);
  const [drag, setDrag] = useState<Edge | null>(null);
  const span = histogram?.range[1] ?? 65536;
  const color = look.lut === "color" ? look.color : HANDLE;
  const windowRef = useRef({ lo, hi, gamma, color, span });
  windowRef.current = { lo, hi, gamma, color, span };

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
    const { lo: l, hi: u, gamma: gm, color: c, span: s } = windowRef.current;
    g.clearRect(0, 0, w, h);
    const x0 = (l / s) * w;
    const x1 = (Math.min(u, s) / s) * w;
    const xm = (Math.min(midtone(l, u, gm), s) / s) * w;
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
    g.fillStyle = MID_HANDLE;
    g.fillRect(xm, 0, dpr, h);
    g.beginPath();
    g.moveTo(xm + 0.5 * dpr, 0);
    g.lineTo(xm + 3.5 * dpr, 3.5 * dpr);
    g.lineTo(xm + 0.5 * dpr, 7 * dpr);
    g.lineTo(xm - 2.5 * dpr, 3.5 * dpr);
    g.fill();
  };

  useEffect(() => {
    const target = heights(histogram, log);
    const from = shown.current.length === target.length ? shown.current : target.map(() => 0);
    return tween(260, (t) => {
      shown.current = target.map((v, i) => from[i]! + (v - from[i]!) * t);
      paint(shown.current);
    }, ease.outCubic);
  }, [histogram, log]);

  useEffect(() => paint(shown.current), [lo, hi, gamma, color, span]);

  const mid = midtone(lo, hi, gamma);
  const valueAt = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * span);
  };
  const apply = (edge: Edge, v: number) => {
    if (edge === "lo") onWindow(Math.min(v, hi - 1), hi);
    else if (edge === "hi") onWindow(lo, Math.max(v, lo + 1));
    else onGamma(gammaForMidtone(lo, hi, v));
  };
  const tip = drag === "lo" ? fmtInt(lo) : drag === "hi" ? fmtInt(hi) : `γ ${gamma.toFixed(2)}`;
  const tipAt = drag === "lo" ? lo : drag === "hi" ? hi : mid;

  return (
    <>
      <div
        className="hist"
        onPointerDown={(e) => {
          const v = valueAt(e);
          const edges: [Edge, number][] = [["lo", lo], ["mid", mid], ["hi", hi]];
          const edge = edges.reduce((best, cur) => (Math.abs(v - cur[1]) < Math.abs(v - best[1]) ? cur : best))[0];
          setDrag(edge);
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          if (edge !== "mid") apply(edge, v);
        }}
        onPointerMove={(e) => drag && apply(drag, valueAt(e))}
        onPointerUp={() => setDrag(null)}
        title="Drag the black, midtone and white points"
      >
        <canvas ref={canvas} />
        {!histogram && <span className="hist-pending">reading pixels…</span>}
        {drag && <span className="hist-tip" style={{ left: `${(Math.min(tipAt, span) / span) * 100}%` }}>{tip}</span>}
      </div>
      <LutRamp lo={lo} hi={hi} gamma={gamma} look={look} span={span} />
    </>
  );
}

/** The display mapping itself: each raw value's colour after the window, gamma and the channel's look. */
function LutRamp({ lo, hi, gamma, look, span }: { lo: number; hi: number; gamma: number; look: ChannelLook; span: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { key, table } = lutFor(look);
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
    for (let x = 0; x < w; x++) {
      const v = ((x + 0.5) / w) * span;
      const t = Math.min(1, Math.max(0, (v - lo) / Math.max(hi - lo, 1))) ** (1 / Math.max(gamma, 0.01));
      const [r, gg, b] = lookup(table, t);
      g.fillStyle = `rgb(${Math.round(Math.min(1, r) * 255)},${Math.round(Math.min(1, gg) * 255)},${Math.round(Math.min(1, b) * 255)})`;
      g.fillRect(x, 0, 1, h);
    }
  }, [lo, hi, gamma, key, table, span]);
  return <div className="lut"><canvas ref={canvas} /></div>;
}

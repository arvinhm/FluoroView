import { RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DatasetInfo } from "../api/types";
import { COLORMAPS, type ColorMap, colormapAt, type CurvePoint, IDENTITY_CURVE, isIdentity, MAX_CURVE_POINTS, toneCurve } from "../lib/lut";
import { type ChannelDisplay, useStudio } from "../state/store";
import { Checkbox } from "./Checkbox";

export const PRESET_COLORS: [string, string][] = [
  ["#3d6bff", "Blue"], ["#00d8ff", "Cyan"], ["#2cff5a", "Green"], ["#ffe03a", "Yellow"],
  ["#ff9b2f", "Orange"], ["#ff3a3a", "Red"], ["#ff3af0", "Magenta"], ["#ffffff", "White"],
];
const POP_WIDTH = 232;
const POP_HEIGHT = 300;
const MIN_GAP = 0.01;
const HIT_CSS = 8;

function rgbCss([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function mapGradient(name: ColorMap, reverse = false): string {
  const stops = Array.from({ length: 9 }, (_, i) => `${rgbCss(colormapAt(name, reverse ? 1 - i / 8 : i / 8))} ${i * 12.5}%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** The channel's mapping as a ramp: black to its colour, or its colour map (reversed when inverted). */
export function rampGradient(d: Pick<ChannelDisplay, "lut" | "color" | "invert">): string {
  if (d.lut !== "color") return mapGradient(d.lut, d.invert);
  return d.invert ? `linear-gradient(90deg, ${d.color}, #000)` : `linear-gradient(90deg, #000, ${d.color})`;
}

function useChannel(ds: DatasetInfo, c: number): (patch: Partial<ChannelDisplay>) => void {
  const setChannel = useStudio((s) => s.setChannel);
  return (patch) => setChannel(ds.id, c, patch);
}

/** The colour swatch of a channel and its panel: colours, colour maps and Invert. */
export function ColorButton({ ds, c, d }: { ds: DatasetInfo; c: number; d: ChannelDisplay }) {
  const set = useChannel(ds, c);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const name = ds.channels[c]!.name;

  const toggle = () => {
    if (at) return setAt(null);
    const r = button.current!.getBoundingClientRect();
    const below = r.bottom + 6 + POP_HEIGHT <= window.innerHeight;
    setAt({ left: Math.max(8, r.right - POP_WIDTH), top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - POP_HEIGHT) });
  };

  useEffect(() => {
    if (!at) return;
    const away = (e: PointerEvent) => {
      if (!pop.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setAt(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setAt(null);
    };
    const close = () => setAt(null);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [at]);

  return (
    <>
      <button ref={button} className="ch-color" style={{ background: rampGradient(d) }} aria-haspopup="dialog"
        aria-expanded={at !== null} title={`Colour of ${name}`} onClick={toggle} />
      {at && (
        <div ref={pop} className="color-pop" role="dialog" aria-label={`Colour of ${name}`}
          style={{ left: at.left, top: at.top, width: POP_WIDTH }}>
          <span className="caps">Colour</span>
          <div className="color-grid">
            {PRESET_COLORS.map(([hex, label]) => (
              <button key={hex} className={`color-cell${d.lut === "color" && d.color.toLowerCase() === hex ? " on" : ""}`}
                style={{ background: hex }} title={label} aria-label={label} onClick={() => set({ lut: "color", color: hex })} />
            ))}
            <label className="color-cell custom" title="Any colour">
              <input type="color" value={d.color} aria-label="Any colour"
                onChange={(e) => set({ lut: "color", color: e.target.value })} />
            </label>
          </div>
          <span className="caps">Colour map</span>
          <div className="map-list">
            {COLORMAPS.map(([map, label]) => (
              <button key={map} className={`map-row${d.lut === map ? " on" : ""}`} onClick={() => set({ lut: map })}>
                <span className="map-ramp" style={{ background: mapGradient(map) }} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <Checkbox checked={d.invert} onChange={(v) => set({ invert: v })}>Invert</Checkbox>
        </div>
      )}
    </>
  );
}

function Slider({ label, value, min, max, unit = "", title, onChange }: {
  label: string; value: number; min: number; max: number; unit?: string; title: string; onChange: (v: number) => void;
}) {
  return (
    <label className="slider-row" title={title}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="val">{min < 0 && value > 0 ? "+" : ""}{value}{unit}</span>
    </label>
  );
}

/** Brightness and Contrast (ImageJ: they move and narrow the display window), intensity and the tone curve. */
export function Adjustments({ ds, c, d, top }: { ds: DatasetInfo; c: number; d: ChannelDisplay; top: number }) {
  const set = useChannel(ds, c);
  const center = (d.lo + d.hi) / 2;
  const width = Math.max(d.hi - d.lo, 1);
  const brightness = Math.round(Math.max(-100, Math.min(100, 100 * (1 - (2 * center) / top))));
  const contrast = Math.round(Math.max(0, Math.min(100, -25 * Math.log2(width / top))));
  const windowAt = (mid: number, w: number) => {
    let lo = Math.round(mid - w / 2);
    let hi = Math.round(mid + w / 2);
    if (lo < 0) {
      hi -= lo;
      lo = 0;
    }
    if (hi > top) {
      lo = Math.max(0, lo - (hi - top));
      hi = top;
    }
    return { lo, hi: Math.max(hi, lo + 1) };
  };
  return (
    <div className="adjust">
      <Slider label="Brightness" value={brightness} min={-100} max={100} title="Moves the display window"
        onChange={(v) => set(windowAt((top * (1 - v / 100)) / 2, width))} />
      <Slider label="Contrast" value={contrast} min={0} max={100} title="Narrows the display window around its centre"
        onChange={(v) => set(windowAt(center, top * 2 ** (-v / 25)))} />
      <Slider label="Intensity" value={Math.round(d.intensity * 100)} min={0} max={100} unit="%"
        title="Output level of this channel in the composite" onChange={(v) => set({ intensity: v / 100 })} />
      <CurveEditor curve={d.curve} color={d.lut === "color" ? d.color : "#ededef"} onChange={(curve) => set({ curve })} />
    </div>
  );
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Photoshop-style Curves: output against input, after the window and gamma. */
function CurveEditor({ curve, color, onChange }: {
  curve: readonly CurvePoint[]; color: string; onChange: (curve: CurvePoint[]) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [readout, setReadout] = useState<CurvePoint | null>(null);

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(el.clientWidth * dpr);
    const h = Math.round(el.clientHeight * dpr);
    el.width = w;
    el.height = h;
    const g = el.getContext("2d")!;
    const X = (x: number) => x * (w - 1);
    const Y = (y: number) => (1 - y) * (h - 1);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = "#1c1d21";
    g.lineWidth = dpr;
    for (const q of [0.25, 0.5, 0.75]) {
      g.beginPath();
      g.moveTo(X(q), 0);
      g.lineTo(X(q), h);
      g.moveTo(0, Y(q));
      g.lineTo(w, Y(q));
      g.stroke();
    }
    g.setLineDash([3 * dpr, 3 * dpr]);
    g.strokeStyle = "#45474e";
    g.beginPath();
    g.moveTo(X(0), Y(0));
    g.lineTo(X(1), Y(1));
    g.stroke();
    g.setLineDash([]);
    const f = toneCurve(curve);
    g.strokeStyle = color;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    for (let i = 0; i <= 256; i++) {
      const x = i / 256;
      if (i === 0) g.moveTo(X(x), Y(f(x)));
      else g.lineTo(X(x), Y(f(x)));
    }
    g.stroke();
    curve.forEach(([x, y], i) => {
      g.beginPath();
      g.arc(X(x), Y(y), 3.5 * dpr, 0, 2 * Math.PI);
      g.fillStyle = i === drag ? color : "#070708";
      g.fill();
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = color;
      g.stroke();
    });
  }, [curve, color, drag]);

  const pointAt = (e: React.PointerEvent | React.MouseEvent): CurvePoint => {
    const r = box.current!.getBoundingClientRect();
    return [round3(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))),
      round3(Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)))];
  };
  const hit = (e: React.PointerEvent | React.MouseEvent): number => {
    const r = box.current!.getBoundingClientRect();
    let best = -1;
    let bestD = HIT_CSS;
    curve.forEach(([x, y], i) => {
      const d = Math.hypot(r.left + x * r.width - e.clientX, r.top + (1 - y) * r.height - e.clientY);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  };
  const moved = (i: number, [x, y]: CurvePoint): CurvePoint[] => curve.map((p, k): CurvePoint => {
    if (k !== i) return [p[0], p[1]];
    if (k === 0 || k === curve.length - 1) return [p[0], y];
    return [round3(Math.min(curve[k + 1]![0] - MIN_GAP, Math.max(curve[k - 1]![0] + MIN_GAP, x))), y];
  });

  return (
    <div className="curve">
      <div className="curve-h">
        <span className="caps">Curves</span>
        <button className="ib" title="Straight curve" disabled={isIdentity(curve)} onClick={() => onChange([...IDENTITY_CURVE])}>
          <RotateCcw />
        </button>
      </div>
      <div
        ref={box}
        className="curve-box"
        onPointerDown={(e) => {
          const p = pointAt(e);
          let i = hit(e);
          let start = curve[i] ?? p;
          if (i < 0) {
            const k = curve.findIndex((q, j) => j < curve.length - 1 && q[0] < p[0] && curve[j + 1]![0] > p[0]);
            if (k < 0 || curve.length >= MAX_CURVE_POINTS || p[0] - curve[k]![0] < MIN_GAP
              || curve[k + 1]![0] - p[0] < MIN_GAP) return;
            i = k + 1;
            start = p;
            onChange([...curve.slice(0, i).map((q): CurvePoint => [q[0], q[1]]), p,
              ...curve.slice(i).map((q): CurvePoint => [q[0], q[1]])]);
          }
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDrag(i);
          setReadout(start);
        }}
        onPointerMove={(e) => {
          if (drag === null) return;
          const next = moved(drag, pointAt(e));
          setReadout(next[drag]!);
          onChange(next);
        }}
        onPointerUp={() => setDrag(null)}
        onDoubleClick={(e) => {
          const i = hit(e);
          if (i > 0 && i < curve.length - 1) onChange(curve.filter((_, k) => k !== i).map((q): CurvePoint => [q[0], q[1]]));
        }}
      >
        <canvas ref={canvas} />
      </div>
      <span className="curve-read">
        {readout && drag !== null
          ? `Input ${Math.round(readout[0] * 100)}% → output ${Math.round(readout[1] * 100)}%`
          : "Click to add a point · drag to shape · double-click to remove"}
      </span>
    </div>
  );
}

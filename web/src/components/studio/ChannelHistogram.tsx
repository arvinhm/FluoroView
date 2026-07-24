import { useRef } from "react";
import type { ChannelHistogram as Hist } from "../../lib/types";

/**
 * Per-channel histogram with a dual-handle min/max (black-point / white-point)
 * overlay — the Photoshop "Levels" affordance. Dragging the LEFT handle raises
 * the black point; the RIGHT handle lowers the white point. Values are in data
 * units and map straight onto Viv `contrastLimits` (and the compositor's
 * uLo/uHi). Numeric inputs give precise entry for 16-bit-style ranges.
 */
export function ChannelHistogram({
  hist,
  domain,
  value,
  color,
  onChange,
  onAuto,
  onReset,
}: {
  hist: Hist | null;
  domain: [number, number];
  value: [number, number];
  color: string;
  onChange: (lo: number, hi: number) => void;
  onAuto: () => void;
  onReset: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = Math.max(1e-6, domain[1] - domain[0]);
  const loFrac = clamp01((value[0] - domain[0]) / span);
  const hiFrac = clamp01((value[1] - domain[0]) / span);

  const valueAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return value[0];
    const r = el.getBoundingClientRect();
    const f = clamp01((clientX - r.left) / r.width);
    return domain[0] + f * span;
  };

  const startDrag = (which: "lo" | "hi") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const v = valueAt(ev.clientX);
      if (which === "lo") onChange(Math.min(v, value[1]), value[1]);
      else onChange(value[0], Math.max(v, value[0]));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onTrackDown = (e: React.PointerEvent) => {
    const v = valueAt(e.clientX);
    // move whichever handle is nearer
    if (Math.abs(v - value[0]) <= Math.abs(v - value[1])) onChange(Math.min(v, value[1]), value[1]);
    else onChange(value[0], Math.max(v, value[0]));
  };

  const bins = hist?.bins ?? [];
  const peak = Math.max(1, hist?.peak ?? 1);
  const decimals = span <= 4 ? 3 : 0;

  return (
    <div className="space-y-1.5">
      <div ref={trackRef} data-fv="hist-track" className="relative h-12 w-full cursor-crosshair select-none touch-none" onPointerDown={onTrackDown}>
        {/* histogram (log-y so faint tails read against a dominant background peak) */}
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <rect x={0} y={0} width={100} height={40} className="fill-white/[0.04]" rx={1} />
          {bins.length > 0 &&
            bins.map((c, i) => {
              const h = c > 0 ? (Math.log1p(c) / Math.log1p(peak)) * 40 : 0;
              return <rect key={i} x={(i / bins.length) * 100} y={40 - h} width={100 / bins.length + 0.4} height={h} fill={color} opacity={0.5} />;
            })}
          {/* selected window highlight */}
          <rect x={loFrac * 100} y={0} width={Math.max(0, (hiFrac - loFrac) * 100)} height={40} fill={color} opacity={0.14} />
          <line x1={loFrac * 100} y1={0} x2={loFrac * 100} y2={40} stroke={color} strokeWidth={0.6} />
          <line x1={hiFrac * 100} y1={0} x2={hiFrac * 100} y2={40} stroke={color} strokeWidth={0.6} />
        </svg>
        {/* draggable handles */}
        <Handle frac={loFrac} color={color} onPointerDown={startDrag("lo")} title="Black point (min)" testId="handle-lo" />
        <Handle frac={hiFrac} color={color} onPointerDown={startDrag("hi")} title="White point (max)" testId="handle-hi" />
      </div>

      <div className="flex items-center gap-1.5">
        <NumberBox value={value[0]} decimals={decimals} min={domain[0]} max={value[1]} onCommit={(v) => onChange(Math.min(v, value[1]), value[1])} label="min" />
        <div className="flex-1" />
        <button onClick={onAuto} className="rounded-md bg-white/[0.06] px-2 py-1 text-[10px] font-semibold text-white/70 transition hover:bg-white/[0.12] hover:text-white" title="Auto contrast (percentile stretch)">
          Auto
        </button>
        <button onClick={onReset} className="rounded-md bg-white/[0.06] px-2 py-1 text-[10px] font-semibold text-white/60 transition hover:bg-white/[0.12] hover:text-white" title="Reset to full range">
          Reset
        </button>
        <div className="flex-1" />
        <NumberBox value={value[1]} decimals={decimals} min={value[0]} max={domain[1]} onCommit={(v) => onChange(value[0], Math.max(v, value[0]))} label="max" />
      </div>
    </div>
  );
}

function Handle({ frac, color, onPointerDown, title, testId }: { frac: number; color: string; onPointerDown: (e: React.PointerEvent) => void; title: string; testId: string }) {
  return (
    <div
      role="slider"
      aria-label={title}
      aria-valuenow={Math.round(frac * 100)}
      data-fv={testId}
      title={title}
      onPointerDown={onPointerDown}
      className="absolute top-0 z-10 h-full w-3 -translate-x-1/2 cursor-ew-resize"
      style={{ left: `${frac * 100}%` }}
    >
      <span className="absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2" style={{ background: color }} />
      <span className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-950 shadow" style={{ background: color }} />
    </div>
  );
}

function NumberBox({ value, decimals, min, max, onCommit, label }: { value: number; decimals: number; min: number; max: number; onCommit: (v: number) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-1" title={`${label} (${min.toFixed(decimals)}–${max.toFixed(decimals)})`}>
      <span className="text-[9px] uppercase tracking-wide text-white/35">{label}</span>
      <input
        type="number"
        defaultValue={round(value, decimals)}
        key={round(value, decimals)}
        step={decimals ? 10 ** -decimals : 1}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-16 rounded-md bg-white/[0.05] px-1.5 py-0.5 text-right font-mono text-[11px] text-white/80 outline-none focus:bg-white/[0.1]"
      />
    </label>
  );
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}
function round(v: number, d: number) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

import { useEffect, useRef } from "react";
import type { Tissue } from "../../lib/types";
import { CELL_TYPES, MARKERS } from "../../lib/synth";
import { PANEL_IDX } from "../../lib/analysis";
import { clusterColor, hexToRgb, ramp, rampCss } from "../../lib/palette";

export type ColorBy = { mode: "cluster" | "type" | "marker"; marker?: number };

interface EmbeddingProps {
  tissue: Tissue;
  embedding: [number, number][];
  sampleIdx: number[];
  labels: number[];
  colorBy: ColorBy;
}

export function EmbeddingScatter({ tissue, embedding, sampleIdx, labels, colorBy }: EmbeddingProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pad = 24;
    ctx.globalCompositeOperation = "lighter";
    embedding.forEach((p, i) => {
      const idx = sampleIdx[i];
      const cell = tissue.cells[idx];
      const x = pad + p[0] * (W - pad * 2);
      const y = pad + p[1] * (H - pad * 2);
      const color = colorFor(colorBy, cell.typeIndex, labels[idx], cell.markers);
      const [r, g, b] = hexToRgb(color);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, 4.5);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
  }, [tissue, embedding, sampleIdx, labels, colorBy]);

  return <canvas ref={ref} className="h-full w-full" />;
}

interface SpatialProps {
  tissue: Tissue;
  labels?: number[];
  colorBy: ColorBy;
}

export function SpatialMap({ tissue, labels, colorBy }: SpatialProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / tissue.width, H / tissue.height);
    const ox = (W - tissue.width * s) / 2;
    const oy = (H - tissue.height * s) / 2;
    for (const c of tissue.cells) {
      const x = ox + c.x * s;
      const y = oy + c.y * s;
      const color = colorFor(colorBy, c.typeIndex, labels ? labels[c.id] : c.typeIndex, c.markers);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.1, c.r * s * 0.9), 0, Math.PI * 2);
      ctx.fill();
    }
  }, [tissue, labels, colorBy]);

  return <canvas ref={ref} className="h-full w-full rounded-xl" />;
}

interface HeatmapProps {
  tissue: Tissue;
  labels: number[];
  k: number;
}

export function MarkerHeatmap({ tissue, labels, k }: HeatmapProps) {
  // rows = clusters, cols = panel markers, value = mean expression (0..1)
  const rows: number[][] = [];
  for (let c = 0; c < k; c++) {
    const members = tissue.cells.filter((cell) => labels[cell.id] === c);
    const means = PANEL_IDX.map((m) => {
      let s = 0;
      for (const cell of members) s += cell.markers[m];
      return members.length ? s / members.length : 0;
    });
    rows.push(means);
  }
  const maxV = Math.max(0.6, ...rows.flat());

  return (
    <div className="overflow-auto">
      <div className="inline-grid gap-[2px]" style={{ gridTemplateColumns: `56px repeat(${PANEL_IDX.length}, 1fr)` }}>
        <div />
        {PANEL_IDX.map((m) => (
          <div key={m} className="px-1 pb-1 text-center text-[9px] font-medium text-white/50" style={{ writingMode: "vertical-rl" as const }}>
            {MARKERS[m].name}
          </div>
        ))}
        {rows.map((row, ci) => (
          <Row key={ci} ci={ci} row={row} maxV={maxV} />
        ))}
      </div>
    </div>
  );
}

function Row({ ci, row, maxV }: { ci: number; row: number[]; maxV: number }) {
  return (
    <>
      <div className="flex items-center gap-1 pr-1 text-[11px] font-semibold text-white/70">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: clusterColor(ci) }} /> C{ci}
      </div>
      {row.map((v, j) => (
        <div
          key={j}
          className="aspect-square min-w-[16px] rounded-[3px]"
          style={{ background: rampCss(v / maxV) }}
          title={v.toFixed(2)}
        />
      ))}
    </>
  );
}

function colorFor(cb: ColorBy, typeIndex: number, label: number, markers: number[]): string {
  if (cb.mode === "cluster") return clusterColor(label);
  if (cb.mode === "type") return CELL_TYPES[typeIndex].color;
  const v = markers[cb.marker ?? 0];
  const [r, g, b] = ramp(v);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

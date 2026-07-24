import { useEffect, useRef } from "react";
import type { CellTypeDef, ChannelDef, Tissue } from "../../lib/types";
import { panelIndices } from "../../lib/analysis";
import { clusterColor, ramp, rampCss } from "../../lib/palette";

export type ColorBy = { mode: "cluster" | "type" | "marker"; marker?: number };

interface EmbeddingProps {
  tissue: Tissue;
  embedding: [number, number][];
  sampleIdx: number[];
  labels: number[];
  colorBy: ColorBy;
  cellTypes?: CellTypeDef[] | null;
}

/**
 * Crisp neighbor-embedding scatter. Renders every embedded cell as a small,
 * hard-edged dot (no radial-gradient glow, no `lighter` blend) so dense regions
 * read as sharp structure rather than a smear. Dots are batched into one Path2D
 * per color so ~33k points draw in a single pass per class.
 */
export function EmbeddingScatter({ tissue, embedding, sampleIdx, labels, colorBy, cellTypes }: EmbeddingProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pad = 18;
    const r = embedding.length > 12000 ? 1.4 : embedding.length > 5000 ? 1.9 : 2.6;

    // Group dots by color → one fill per class keeps 33k points fast + crisp.
    const paths = new Map<string, Path2D>();
    for (let i = 0; i < embedding.length; i++) {
      const idx = sampleIdx[i];
      const cell = tissue.cells[idx];
      if (!cell) continue;
      const p = embedding[i];
      const x = pad + p[0] * (W - pad * 2);
      const y = pad + p[1] * (H - pad * 2);
      const color = colorFor(colorBy, cell.typeIndex, labels[idx], cell.markers, cellTypes);
      let path = paths.get(color);
      if (!path) {
        path = new Path2D();
        paths.set(color, path);
      }
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, Math.PI * 2);
    }
    for (const [color, path] of paths) {
      ctx.fillStyle = color;
      ctx.fill(path);
    }
  }, [tissue, embedding, sampleIdx, labels, colorBy, cellTypes]);

  return <canvas ref={ref} className="h-full w-full" />;
}

interface SpatialProps {
  tissue: Tissue;
  labels?: number[];
  colorBy: ColorBy;
  cellTypes?: CellTypeDef[] | null;
}

export function SpatialMap({ tissue, labels, colorBy, cellTypes }: SpatialProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
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
    const paths = new Map<string, Path2D>();
    for (const c of tissue.cells) {
      const x = ox + c.x * s;
      const y = oy + c.y * s;
      const label = c.cluster != null ? c.cluster : c.typeIndex;
      const color = colorFor(colorBy, c.typeIndex, label, c.markers, cellTypes);
      const rr = Math.max(0.8, c.r * s * 0.9);
      let path = paths.get(color);
      if (!path) {
        path = new Path2D();
        paths.set(color, path);
      }
      path.moveTo(x + rr, y);
      path.arc(x, y, rr, 0, Math.PI * 2);
    }
    for (const [color, path] of paths) {
      ctx.fillStyle = color;
      ctx.fill(path);
    }
  }, [tissue, labels, colorBy, cellTypes]);

  return <canvas ref={ref} className="h-full w-full rounded-xl" />;
}

interface HeatmapProps {
  tissue: Tissue;
  labels: number[];
  k: number;
  channels: ChannelDef[];
  annotations?: Record<number, string>;
}

/**
 * Cluster × channel mean-intensity heatmap. Responsive: a fixed label gutter +
 * `minmax(0,1fr)` cell columns so the grid always fits its container (no
 * horizontal clipping), with a reserved header band for the rotated channel
 * labels so they never spill out of the panel.
 */
export function MarkerHeatmap({ tissue, labels, k, channels, annotations }: HeatmapProps) {
  const panel = panelIndices(channels.length);
  const rows: number[][] = [];
  for (let c = 0; c < k; c++) {
    const members = tissue.cells.filter((cell) => cell.cluster === c);
    const means = panel.map((m) => {
      let s = 0;
      for (const cell of members) s += cell.markers[m];
      return members.length ? s / members.length : 0;
    });
    rows.push(means);
  }
  const maxV = Math.max(0.4, ...rows.flat());

  return (
    <div className="w-full">
      <div className="grid w-full items-stretch gap-[3px]" style={{ gridTemplateColumns: `minmax(52px, 84px) repeat(${panel.length}, minmax(0, 1fr))` }}>
        <div className="h-20" />
        {panel.map((m) => (
          <div key={m} className="flex h-20 items-end justify-center pb-1">
            <span className="max-h-[72px] overflow-hidden text-ellipsis text-[10px] font-medium leading-tight text-white/60" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }} title={channels[m].name}>
              {channels[m].name}
            </span>
          </div>
        ))}
        {rows.map((row, ci) => (
          <Row key={ci} ci={ci} row={row} maxV={maxV} name={annotations?.[ci]} />
        ))}
      </div>
    </div>
  );
}

function Row({ ci, row, maxV, name }: { ci: number; row: number[]; maxV: number; name?: string }) {
  return (
    <>
      <div className="flex items-center gap-1 overflow-hidden pr-1 text-[11px] font-semibold text-white/70" title={name || `Cluster ${ci}`}>
        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: clusterColor(ci) }} />
        <span className="truncate">{name || `C${ci}`}</span>
      </div>
      {row.map((v, j) => (
        <div key={j} className="aspect-square w-full rounded-[3px]" style={{ background: rampCss(v / maxV) }} title={v.toFixed(2)} />
      ))}
    </>
  );
}

/** Compact swatch+name legend overlaid on the embedding / spatial map. */
export function ClusterLegend({
  colorBy,
  clusters,
  cellTypes,
  annotations,
}: {
  colorBy: ColorBy;
  clusters: number[];
  cellTypes?: CellTypeDef[] | null;
  annotations?: Record<number, string>;
}) {
  let items: { color: string; label: string }[] = [];
  if (colorBy.mode === "cluster") {
    items = clusters.map((c) => ({ color: clusterColor(c), label: annotations?.[c] || `C${c}` }));
  } else if (colorBy.mode === "type" && cellTypes) {
    items = cellTypes.map((t) => ({ color: t.color, label: t.short || t.name }));
  } else {
    return null;
  }
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-2 top-2 z-10 max-h-[40%] max-w-[45%] overflow-hidden rounded-lg bg-ink-950/70 px-2 py-1.5 backdrop-blur">
      <div className="flex flex-col gap-0.5">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="h-2 w-2 flex-shrink-0 rounded-sm" style={{ background: it.color }} />
            <span className="truncate text-[10px] font-medium text-white/70">{it.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function colorFor(
  cb: ColorBy,
  typeIndex: number,
  label: number,
  markers: number[],
  cellTypes?: CellTypeDef[] | null
): string {
  if (cb.mode === "cluster") return clusterColor(label);
  if (cb.mode === "type") return cellTypes ? cellTypes[typeIndex]?.color ?? "#22d3ee" : "#22d3ee";
  const v = markers[cb.marker ?? 0] ?? 0;
  const [r, g, b] = ramp(v);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

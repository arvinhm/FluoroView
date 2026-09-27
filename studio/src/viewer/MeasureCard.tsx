import { Circle, Copy, Lasso, type LucideIcon, Pentagon, Square, SquareDashed, Trash2 } from "lucide-react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DatasetInfo, Measurement, RegionShape } from "../api/types";
import { fmt1, fmtArea, fmtInt, fmtPercent, fmtSigned } from "../lib/format";
import { deleteRegion, measure, measureKey, renameRegion, setBackground, useProject } from "../state/project";
import { useStudio } from "../state/store";
import { type Anchor, type Bounds, placeBeside } from "./overlay";

const CARD_W = 272;
/** keep clear of the zoom controls and scale bar */
const BOTTOM_CLEAR = 52;

export const SHAPE_ICON: Record<RegionShape, LucideIcon> = {
  rectangle: Square, ellipse: Circle, polygon: Pentagon, freehand: Lasso,
};

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

async function copyValues(ds: DatasetInfo, m: Measurement, bg: (number | null)[] | null): Promise<void> {
  const head = ["channel", "mean", "sd", "median", "min", "max", "n_pixels", "n_clipped"];
  if (bg) head.push("mean_minus_background");
  const rows = m.channels.map((c, i) => {
    const cells = [c.channel, c.mean, c.sd, c.median, c.min, c.max, c.n_pixels, c.n_clipped];
    if (bg) cells.push(c.mean !== null && bg[i] !== null && bg[i] !== undefined ? c.mean - bg[i]! : null);
    return cells.map((v) => (v === null ? "" : typeof v === "number" && !Number.isInteger(v) ? v.toFixed(4) : String(v))).join("\t");
  });
  await navigator.clipboard.writeText([head.join("\t"), ...rows].join("\n"));
  useStudio.getState().setNotice(`Copied ${m.region} (${ds.channels.length} channels) as tab-separated values.`);
}

export function MeasureCard({ ds, anchor, bounds, avoid }: {
  ds: DatasetInfo;
  anchor: Anchor;
  bounds: Bounds;
  /** screen boxes of the other regions, which the card tries not to cover */
  avoid: readonly Anchor[];
}) {
  const selection = useProject((s) => s.selection);
  const region = useProject((s) => (selection?.kind === "region"
    ? s.scans[ds.id]?.regions.find((r) => r.id === selection.id) : undefined));
  const background = useProject((s) => s.scans[ds.id]?.background ?? null);
  const backgroundName = useProject((s) => s.scans[ds.id]?.regions.find((r) => r.id === background)?.name);
  const entry = useProject((s) => (region ? s.measures[measureKey(ds.id, region.id)] : undefined));
  const bgEntry = useProject((s) => (background ? s.measures[measureKey(ds.id, background)] : undefined));
  const display = useStudio((s) => s.display[ds.id]);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(200);
  const [renaming, setRenaming] = useState(false);
  const rid = region?.id;
  const modified = region?.modified;

  useEffect(() => {
    if (rid) measure(ds.id, rid);
  }, [ds.id, rid, modified]);
  useEffect(() => {
    if (background) measure(ds.id, background);
  }, [ds.id, background]);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight;
    if (h && h !== height) setHeight(h);
  });

  if (!region) return null;

  const { x: left, y: top } = placeBeside(anchor, CARD_W, height, bounds, avoid, 14, 10, BOTTOM_CLEAR);

  const Icon = SHAPE_ICON[region.shape];
  const m = entry?.data ?? null;
  const isBg = background === region.id;
  const bg = !isBg && bgEntry?.data ? bgEntry.data.channels.map((c) => c.mean) : null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div ref={ref} className="mcard viewer-ui" style={{ transform: `translate(${left}px, ${top}px)` }}
      onPointerDown={stop} onDoubleClick={stop}>
      <div className="mcard-h">
        <Icon />
        {renaming ? (
          <input className="mcard-input" autoFocus defaultValue={region.name} aria-label="Region name"
            onBlur={(e) => {
              setRenaming(false);
              if (e.currentTarget.value.trim() && e.currentTarget.value !== region.name) {
                void renameRegion(ds.id, region.id, e.currentTarget.value);
              }
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(false);
            }} />
        ) : (
          <button className="mcard-name" title="Rename" onClick={() => setRenaming(true)}>{region.name}</button>
        )}
        <span className="mcard-act">
          <button className={`ib${isBg ? " on" : ""}`} aria-pressed={isBg}
            title={isBg ? "Background region (click to clear)" : "Use as background: its mean is subtracted in the CSV"}
            onClick={() => void setBackground(ds.id, isBg ? null : region.id)}><SquareDashed /></button>
          <button className="ib" title="Copy values" disabled={!m} onClick={() => m && void copyValues(ds, m, bg)}><Copy /></button>
          <button className="ib" title="Delete region (⌫)" onClick={() => void deleteRegion(ds.id, region.id)}><Trash2 /></button>
        </span>
      </div>
      <div className="mcard-sub">
        {m ? (
          <>
            <span>{fmtArea(m.area_px, m.area_um2)}</span>
            {m.area_um2 !== null && <span className="muted">{fmtInt(m.area_px)} px</span>}
          </>
        ) : (
          <span className={entry?.error ? "err" : "muted"}>{entry?.error ?? "Measuring full-resolution pixels…"}</span>
        )}
        {isBg && <span className="badge">Background</span>}
        {m && (entry?.loading || entry?.stale) && (
          <span className="muted mcard-busy">{entry.loading ? "measuring" : "release to measure"}</span>
        )}
      </div>
      <div className={`mcard-rows${m && (entry?.loading || entry?.stale) ? " stale" : ""}`}>
        {ds.channels.map((ch, i) => {
          const c = m?.channels[i];
          const d = display?.[i];
          const color = d?.color ?? ch.color;
          const span = d ? Math.max(d.hi - d.lo, 1) : 1;
          const pos = (v: number) => `${clamp01((v - (d?.lo ?? 0)) / span) * 100}%`;
          const mean = c?.mean ?? null;
          const sd = c?.sd ?? 0;
          const delta = mean !== null && bg?.[i] != null ? mean - bg[i]! : null;
          const clipped = c && c.n_pixels ? c.n_clipped / c.n_pixels : 0;
          const detail = c && mean !== null
            ? `${ch.name}: mean ${fmt1(mean)}, SD ${fmt1(sd)}, median ${fmtInt(c.median ?? 0)}, min ${fmtInt(c.min ?? 0)}, max ${fmtInt(c.max ?? 0)}`
              + (clipped > 0 ? `, ${fmtPercent(clipped)} clipped` : "") : ch.name;
          return (
            <div key={ch.index} className={`mrow${d?.visible ? "" : " off"}${bg ? " with-delta" : ""}`} title={detail}>
              <span className="sw" style={{ background: color }} />
              <span className="mrow-name"><span className="t">{ch.name}</span>{clipped > 0 && <span className="mrow-clip" />}</span>
              <span className="num">{mean !== null ? fmt1(mean) : "—"}</span>
              <span className="num muted">{mean !== null ? `± ${fmt1(sd)}` : ""}</span>
              {bg && <span className="num mrow-delta">{delta !== null ? fmtSigned(delta) : "—"}</span>}
              <span className="mrow-bar" style={{
                "--c": color, "--m": mean !== null ? pos(mean) : "0%",
                "--lo": mean !== null ? pos(mean - sd) : "0%", "--hi": mean !== null ? pos(mean + sd) : "0%",
              } as CSSProperties} />
            </div>
          );
        })}
      </div>
      <div className="mcard-f">
        {bg ? <>Right column: mean − background ({backgroundName})</> : <>Raw pixel values · bars span the display window</>}
      </div>
    </div>
  );
}

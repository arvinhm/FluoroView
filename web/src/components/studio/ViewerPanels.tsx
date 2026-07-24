import { useState } from "react";
import { Layers, MapPin, MessageSquare, Trash2, Download, Loader2 } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import { cellsInRoi, shapeArea, shapeKindLabel } from "../../lib/roi";
import { exportRoisZip } from "../../lib/roiExport";
import { toast } from "../../lib/toast";
import { Panel, Slider, Chip } from "../ui";

/** Toolbar icon button shared by both viewer engines. */
export function ToolBtn({ children, onClick, active, title }: { children: React.ReactNode; onClick: () => void; active?: boolean; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={clsx(
        "grid h-9 w-9 place-items-center rounded-xl glass text-white/70 transition hover:text-white",
        active && "!bg-cyan-400/20 text-cyan-200 ring-1 ring-cyan-300/40"
      )}
    >
      {children}
    </button>
  );
}

export function ChannelPreset({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <Chip onClick={onClick}>{children}</Chip>;
}

export function ChannelPanel() {
  const channels = useStore((s) => s.channels);
  const activeChannels = useStore((s) => s.activeChannels);
  const toggle = useStore((s) => s.toggleChannel);
  const setGain = useStore((s) => s.setGain);
  const setGamma = useStore((s) => s.setGamma);
  const soloChannel = useStore((s) => s.soloChannel);
  const [expanded, setExpanded] = useState<number | null>(0);

  return (
    <Panel className="flex max-h-[640px] flex-col overflow-hidden" strong>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-bold">
          <Layers className="h-4 w-4 text-cyan-300" /> Channels
        </div>
        <span className="text-xs text-white/40">{channels.filter((c) => c.visible).length}/{channels.length} on</span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {channels.map((c) => {
          const mk = activeChannels[c.index];
          if (!mk) return null;
          const open = expanded === c.index;
          return (
            <div key={c.index} className={clsx("rounded-xl px-2 py-1.5 transition", c.visible ? "bg-white/[0.03]" : "opacity-55")}>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggle(c.index)}
                  className="grid h-6 w-6 place-items-center rounded-md"
                  style={{ background: c.visible ? `${mk.color}33` : "transparent", boxShadow: `inset 0 0 0 1px ${mk.color}66` }}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.visible ? mk.color : "transparent", boxShadow: c.visible ? `0 0 8px ${mk.color}` : "none" }} />
                </button>
                <button onClick={() => setExpanded(open ? null : c.index)} className="flex-1 text-left text-sm font-semibold">
                  {mk.name}
                  <span className="ml-1.5 text-[10px] font-normal text-white/35">{mk.kind}</span>
                </button>
                <button onClick={() => soloChannel(c.index)} className="rounded-md px-1.5 py-0.5 text-[10px] text-white/40 hover:bg-white/10 hover:text-white">
                  solo
                </button>
              </div>
              {open && (
                <div className="mt-2 space-y-2 px-1 pb-1">
                  <LabeledSlider label="Gain" value={c.gain} min={0.2} max={3} onChange={(v) => setGain(c.index, v)} accent={mk.color} />
                  <LabeledSlider label="Gamma" value={c.gamma} min={0.3} max={2.4} onChange={(v) => setGamma(c.index, v)} accent={mk.color} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function RoiListPanel() {
  const rois = useStore((s) => s.rois);
  const tissue = useStore((s) => s.tissue);
  const maps = useStore((s) => s.maps);
  const activeChannels = useStore((s) => s.activeChannels);
  const channelStates = useStore((s) => s.channels);
  const pixelSizeUm = useStore((s) => s.pixelSizeUm);
  const datasetLabel = useStore((s) => s.datasetLabel);
  const selectedRoiId = useStore((s) => s.selectedRoiId);
  const selectRoi = useStore((s) => s.selectRoi);
  const removeRoi = useStore((s) => s.removeRoi);
  const updateRoi = useStore((s) => s.updateRoi);
  const clearRois = useStore((s) => s.clearRois);
  const [exporting, setExporting] = useState(false);

  const exportAll = async () => {
    if (!tissue || !maps) return;
    setExporting(true);
    try {
      await exportRoisZip(rois, { maps, defs: activeChannels, channels: channelStates, cells: tissue.cells, pixelSizeUm, datasetLabel }, "fluoroview-rois.zip");
      toast.success("ROIs exported", `${rois.length} ROI folder${rois.length > 1 ? "s" : ""} in fluoroview-rois.zip`);
    } catch (e) {
      toast.error("Export failed", e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Panel className="p-4" strong>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-bold">
          <MapPin className="h-4 w-4 text-cyan-300" /> Regions of interest
          <span className="font-normal text-white/40">({rois.length})</span>
        </div>
        {rois.length > 0 && (
          <div className="flex items-center gap-3">
            <button onClick={exportAll} disabled={exporting} className="inline-flex items-center gap-1.5 text-xs text-white/60 transition hover:text-cyan-300 disabled:opacity-50">
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export all (.zip)
            </button>
            <button onClick={clearRois} className="text-xs text-white/45 transition hover:text-rose-300">
              Clear all
            </button>
          </div>
        )}
      </div>
      {rois.length === 0 ? (
        <p className="max-w-2xl text-xs leading-relaxed text-white/45">
          Pick the <span className="text-white/70">Rectangle</span>, <span className="text-white/70">Circle</span>, or{" "}
          <span className="text-white/70">Freehand polygon</span> tool in the viewer toolbar (or press R / C / P), then draw on the
          image. With the Pan tool (V) click an ROI to select it and drag to move; press Delete to remove the selected one.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rois.map((r) => {
            const n = tissue ? cellsInRoi(tissue.cells, r.shape).length : 0;
            const area = Math.round(shapeArea(r.shape));
            const sel = r.id === selectedRoiId;
            return (
              <div
                key={r.id}
                onClick={() => selectRoi(r.id)}
                className={clsx(
                  "cursor-pointer rounded-xl border p-3 transition",
                  sel ? "border-cyan-400/50 bg-cyan-400/[0.06]" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: r.color }} />
                  <input
                    value={r.label}
                    onChange={(e) => updateRoi(r.id, { label: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 rounded bg-transparent text-sm font-semibold text-white outline-none focus:bg-white/5"
                    aria-label="ROI label"
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      selectRoi(r.id);
                    }}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-white/45 transition hover:bg-white/10 hover:text-fuchsia-300"
                    title="View analysis & comments for this ROI"
                    aria-label="View comments"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {r.comments.length > 0 && <span>{r.comments.length}</span>}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRoi(r.id);
                    }}
                    className="rounded-md p-1 text-white/40 transition hover:bg-white/10 hover:text-rose-300"
                    aria-label="Delete ROI"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/50">
                  <span>{shapeKindLabel(r.shape)}</span>
                  <span className="text-white/70">{n.toLocaleString()} cells</span>
                  <span>{area.toLocaleString()} px²</span>
                  {r.comments.length > 0 && <span className="text-fuchsia-300">{r.comments.length} note{r.comments.length > 1 ? "s" : ""}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function LabeledSlider({ label, value, min, max, onChange, accent }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; accent: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 text-[11px] text-white/45">{label}</span>
      <Slider value={value} min={min} max={max} onChange={onChange} accent={accent} />
      <span className="w-8 text-right font-mono text-[11px] text-white/55">{value.toFixed(1)}</span>
    </div>
  );
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

import { useRef, useState } from "react";
import { Layers, MapPin, MessageSquare, Trash2, Download, Loader2, Wand2, Bookmark, Upload, X, RotateCcw } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import { cellsInRoi, shapeArea, shapeKindLabel } from "../../lib/roi";
import { exportRoisZip } from "../../lib/roiExport";
import { appearanceOf, presetToJson, newPresetId } from "../../lib/presets";
import { formatArea } from "../../lib/format";
import { MAX_COMPOSITED_CHANNELS } from "../../lib/channelGuards";
import { toast } from "../../lib/toast";
import { Panel, Slider, Chip } from "../ui";
import { ChannelHistogram } from "./ChannelHistogram";

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
  const channelStats = useStore((s) => s.channelStats);
  const activeChannels = useStore((s) => s.activeChannels);
  const imageSource = useStore((s) => s.imageSource);
  const toggle = useStore((s) => s.toggleChannel);
  const soloChannel = useStore((s) => s.soloChannel);
  const setContrastLimits = useStore((s) => s.setContrastLimits);
  const setChannelColor = useStore((s) => s.setChannelColor);
  const setOpacity = useStore((s) => s.setOpacity);
  const setGamma = useStore((s) => s.setGamma);
  const autoContrast = useStore((s) => s.autoContrast);
  const autoContrastAll = useStore((s) => s.autoContrastAll);
  const resetChannel = useStore((s) => s.resetChannel);
  const [expanded, setExpanded] = useState<number | null>(0);

  return (
    <Panel className="flex max-h-[720px] flex-col overflow-hidden" strong>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-bold">
          <Layers className="h-4 w-4 text-cyan-300" /> Channels
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={autoContrastAll}
            className="inline-flex items-center gap-1 rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-semibold text-white/70 transition hover:bg-white/[0.12] hover:text-white"
            title="Auto-contrast every channel"
          >
            <Wand2 className="h-3 w-3" /> Auto all
          </button>
          <PresetsMenu />
        </div>
      </div>
      {!!imageSource && channels.length > MAX_COMPOSITED_CHANNELS && (
        <p className="border-b border-white/10 bg-amber-400/[0.07] px-4 py-2 text-[10px] leading-relaxed text-amber-100/85">
          {channels.length} channels loaded — the GPU composites {MAX_COMPOSITED_CHANNELS} at a time, so the first {MAX_COMPOSITED_CHANNELS} you switch on are rendered.
          Toggle channels to choose which.
        </p>
      )}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {channels.map((c) => {
          const mk = activeChannels[c.index];
          if (!mk) return null;
          const open = expanded === c.index;
          const stat = channelStats[c.index] ?? null;
          return (
            <div key={c.index} className={clsx("rounded-xl px-2 py-1.5 transition", c.visible ? "bg-white/[0.03]" : "opacity-55")}>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggle(c.index)}
                  className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md"
                  title={c.visible ? "Hide channel" : "Show channel"}
                  style={{ background: c.visible ? `${c.color}33` : "transparent", boxShadow: `inset 0 0 0 1px ${c.color}66` }}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.visible ? c.color : "transparent", boxShadow: c.visible ? `0 0 8px ${c.color}` : "none" }} />
                </button>
                <button onClick={() => setExpanded(open ? null : c.index)} className="min-w-0 flex-1 truncate text-left text-sm font-semibold">
                  {mk.name}
                  <span className="ml-1.5 text-[10px] font-normal text-white/35">{mk.kind}</span>
                </button>
                <span className="font-mono text-[10px] text-white/40">
                  {fmtLimit(c.contrastLimits[0])}–{fmtLimit(c.contrastLimits[1])}
                </span>
                <button onClick={() => soloChannel(c.index)} className="rounded-md px-1.5 py-0.5 text-[10px] text-white/40 hover:bg-white/10 hover:text-white" title="Show only this channel">
                  solo
                </button>
              </div>
              {open && (
                <div className="mt-2 space-y-2.5 px-1 pb-1.5">
                  <ChannelHistogram
                    hist={stat}
                    domain={c.domain}
                    value={c.contrastLimits}
                    color={c.color}
                    onChange={(lo, hi) => setContrastLimits(c.index, lo, hi)}
                    onAuto={() => autoContrast(c.index)}
                    onReset={() => resetChannel(c.index)}
                  />
                  <LabeledSlider label="γ" name={`${mk.name} gamma`} value={c.gamma} min={0.2} max={4} step={0.05} onChange={(v) => setGamma(c.index, v)} accent={c.color} fixed={2} />
                  <LabeledSlider label="opacity" name={`${mk.name} opacity`} value={c.opacity} min={0} max={1} step={0.01} onChange={(v) => setOpacity(c.index, v)} accent={c.color} fixed={2} />
                  <div className="flex items-center gap-2">
                    <span className="w-12 text-[11px] text-white/45">color</span>
                    <label className="relative h-6 w-9 cursor-pointer overflow-hidden rounded-md ring-1 ring-white/15" title="Channel color" style={{ background: c.color }}>
                      <input type="color" value={toHex6(c.color)} onChange={(e) => setChannelColor(c.index, e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
                    </label>
                    <div className="flex flex-wrap gap-1">
                      {SWATCHES.map((s) => (
                        <button key={s} onClick={() => setChannelColor(c.index, s)} className="h-4 w-4 rounded-full ring-1 ring-white/20 transition hover:scale-110" style={{ background: s }} title={s} aria-label={`Set color ${s}`} />
                      ))}
                    </div>
                    <button onClick={() => resetChannel(c.index)} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-white/45 transition hover:bg-white/10 hover:text-white" title="Reset contrast, gamma & opacity">
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

const SWATCHES = ["#0050ff", "#ff00ff", "#00dc5a", "#00dcff", "#ffbf00", "#ff2d55", "#ffffff"];

function fmtLimit(v: number): string {
  return v >= 100 || v === 0 ? Math.round(v).toString() : v.toFixed(1);
}

function toHex6(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length === 3) return "#" + h.split("").map((c) => c + c).join("");
  return "#" + h.slice(0, 6).padEnd(6, "0");
}

/** Save / apply / import / export full-appearance presets (offline, localStorage). */
function PresetsMenu() {
  const presets = useStore((s) => s.presets);
  const datasetId = useStore((s) => s.datasetId);
  const channels = useStore((s) => s.channels);
  const activePresetId = useStore((s) => s.activePresetId);
  const savePreset = useStore((s) => s.savePreset);
  const applyPreset = useStore((s) => s.applyPreset);
  const deletePreset = useStore((s) => s.deletePreset);
  const importPresetJson = useStore((s) => s.importPresetJson);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const mine = presets.filter((p) => p.datasetId === datasetId);

  const exportCurrent = () => {
    const preset = { id: newPresetId(), name: name.trim() || "FluoroView preset", datasetId, channels: appearanceOf(channels), createdAt: Date.now() };
    const blob = new Blob([presetToJson(preset)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${preset.name.replace(/\s+/g, "_")}.fvpreset.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast.success("Preset exported", `${preset.name}.fvpreset.json`);
  };

  const doImport = async (file: File) => {
    const ok = importPresetJson(await file.text());
    if (ok) toast.success("Preset imported", "Channel appearance applied");
    else toast.error("Import failed", "Not a valid preset file");
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-semibold text-white/70 transition hover:bg-white/[0.12] hover:text-white"
        title="Save / load channel presets"
      >
        <Bookmark className="h-3 w-3" /> Presets
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-40 w-60 rounded-xl border border-white/10 bg-ink-900/95 p-2.5 shadow-panel backdrop-blur-xl">
            <div className="mb-2 flex items-center gap-1.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Preset name"
                className="min-w-0 flex-1 rounded-md bg-white/[0.06] px-2 py-1 text-xs text-white/85 outline-none focus:bg-white/[0.1]"
              />
              <button
                onClick={() => {
                  if (!name.trim()) return;
                  savePreset(name.trim());
                  setName("");
                  toast.success("Preset saved", name.trim());
                }}
                className="rounded-md bg-cyan-400/20 px-2 py-1 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-400/30"
              >
                Save
              </button>
            </div>
            <div className="max-h-44 space-y-0.5 overflow-y-auto">
              {mine.length === 0 && <p className="px-1 py-2 text-[11px] text-white/40">No presets yet for this dataset.</p>}
              {mine.map((p) => (
                <div key={p.id} className={clsx("group flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition hover:bg-white/[0.06]", activePresetId === p.id && "bg-white/[0.06]")}>
                  <button onClick={() => applyPreset(p.id)} className="min-w-0 flex-1 truncate text-left text-white/80" title={`Apply ${p.name}`}>
                    {p.name}
                  </button>
                  <button onClick={() => deletePreset(p.id)} className="rounded p-0.5 text-white/30 transition hover:bg-white/10 hover:text-rose-300" aria-label="Delete preset">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1.5 border-t border-white/10 pt-2">
              <button onClick={() => fileRef.current?.click()} className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-white/[0.06] px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.12] hover:text-white">
                <Upload className="h-3 w-3" /> Import
              </button>
              <button onClick={exportCurrent} className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-white/[0.06] px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.12] hover:text-white">
                <Download className="h-3 w-3" /> Export
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doImport(f);
                  e.currentTarget.value = "";
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
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
            const area = formatArea(shapeArea(r.shape), pixelSizeUm);
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
                  <span>{area}</span>
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

export function LabeledSlider({ label, value, min, max, step, onChange, accent, fixed = 1, name }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; accent: string; fixed?: number; name?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 flex-shrink-0 text-[11px] text-white/45">{label}</span>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} accent={accent} label={name ?? label} />
      <span className="w-9 flex-shrink-0 text-right font-mono text-[11px] text-white/55">{value.toFixed(fixed)}</span>
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

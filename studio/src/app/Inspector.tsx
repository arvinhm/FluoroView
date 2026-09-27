import { ChevronRight } from "lucide-react";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import type { DatasetInfo } from "../api/types";
import { AUTO_HIGH, AUTO_LOW, dtypeMax } from "../lib/contrast";
import { fmtInt, fmtPercent } from "../lib/format";
import { isIdentity } from "../lib/lut";
import { useActive, useStudio } from "../state/store";
import { Adjustments, ColorButton } from "./ChannelControls";
import { HistogramView } from "./HistogramView";
import { NumberField } from "./NumberField";
import { RegionsTab } from "./RegionsTab";
import { Segmented } from "./Segmented";

type Tab = "channels" | "regions" | "info";

function ChannelRow({ ds, c }: { ds: DatasetInfo; c: number }) {
  const d = useStudio((s) => s.display[ds.id]?.[c]);
  const h = useStudio((s) => s.histograms[ds.id]?.[c]);
  const log = useStudio((s) => s.options.histLog);
  const setChannel = useStudio((s) => s.setChannel);
  const [adjusting, setAdjusting] = useState(false);
  const ch = ds.channels[c];
  if (!d || !ch) return null;
  const top = h?.range[1] ?? dtypeMax(ds.dtype);
  const clipped = h && h.total ? h.saturated / h.total : null;
  const adjusted = !isIdentity(d.curve) || d.intensity !== 1;

  return (
    <div className={`ch${d.visible ? "" : " off"}`}>
      <div className="ch-h">
        <button className={`chip${d.visible ? " on" : ""}`} style={{ "--c": d.color } as CSSProperties} role="switch"
          aria-checked={d.visible} title={`${d.visible ? "Hide" : "Show"} ${ch.name} (${c + 1})`}
          onClick={() => setChannel(ds.id, c, { visible: !d.visible })} />
        <span className="ch-name">{ch.name}</span>
        {ch.excitation_nm && ch.emission_nm ? <span className="ch-wl">{ch.excitation_nm}/{ch.emission_nm} nm</span> : null}
        {clipped !== null && (
          <span className={`ch-flag${clipped > 0 ? " warn" : ""}`}
            title={ds.saturation ? `Pixels at the camera saturation level (${fmtInt(ds.saturation)})` : "Pixels at the maximum value"}>
            {clipped > 0 ? `${fmtPercent(clipped)} clipped` : "no clipping"}
          </span>
        )}
        <ColorButton ds={ds} c={c} d={d} />
      </div>
      <HistogramView histogram={h} lo={d.lo} hi={d.hi} gamma={d.gamma} look={d} log={log}
        onWindow={(lo, hi) => setChannel(ds.id, c, { lo, hi })} onGamma={(gamma) => setChannel(ds.id, c, { gamma })} />
      <div className="fields">
        <NumberField label="Min" value={d.lo} min={0} max={d.hi - 1} step={Math.max(1, Math.round(top / 1000))}
          onCommit={(v) => setChannel(ds.id, c, { lo: v })} />
        <NumberField label="Max" value={d.hi} min={d.lo + 1} max={top} step={Math.max(1, Math.round(top / 1000))}
          onCommit={(v) => setChannel(ds.id, c, { hi: v })} />
        <NumberField label="γ" value={d.gamma} digits={2} step={0.05} min={0.1} max={5}
          onCommit={(v) => setChannel(ds.id, c, { gamma: v })} title="Display gamma: above 1 brightens mid-tones" />
      </div>
      <button className={`adjust-toggle${adjusting ? " on" : ""}`} aria-expanded={adjusting}
        onClick={() => setAdjusting(!adjusting)} title="Brightness, contrast, intensity and curves">
        <ChevronRight /> Adjust
        {adjusted && <span className="adjust-dot" title="This channel has a curve or reduced intensity" />}
      </button>
      {adjusting && <Adjustments ds={ds} c={c} d={d} top={top} />}
    </div>
  );
}

function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-tab="${value}"]`);
    if (el) setBar({ x: el.offsetLeft + 8, w: el.offsetWidth - 16 });
  }, [value]);
  return (
    <div className="tabs" ref={ref} role="tablist">
      {options.map(([v, label]) => (
        <button key={v} data-tab={v} role="tab" aria-selected={v === value} className={`tab${v === value ? " on" : ""}`}
          onClick={() => onChange(v)}>{label}</button>
      ))}
      {bar && <span className="tab-indicator" style={{ width: bar.w, transform: `translateX(${bar.x}px)` }} />}
    </div>
  );
}

function ChannelsTab({ ds }: { ds: DatasetInfo }) {
  const options = useStudio((s) => s.options);
  const setOption = useStudio((s) => s.setOption);
  const autoContrast = useStudio((s) => s.autoContrast);
  return (
    <div className="scroll">
      <div className="toolrow">
        <button className="btn" onClick={() => autoContrast(ds.id)} title="Auto contrast all channels (A)">Auto contrast</button>
        <span className="muted" style={{ fontSize: "var(--fv-fs-sm)" }}>
          {AUTO_LOW}–{AUTO_HIGH} %, clipped excluded
        </span>
        <span className="toolrow-end" title="How channels combine: Add sums them, Max keeps the brightest">
          <Segmented value={options.blend} options={[["add", "Add"], ["max", "Max"]]} onChange={(v) => setOption("blend", v)} />
        </span>
      </div>
      {ds.channels.map((_, c) => <ChannelRow key={c} ds={ds} c={c} />)}
      <div className="kv">
        <span>Magnification</span>
        <Segmented value={options.smooth ? "smooth" : "nearest"} options={[["nearest", "Exact pixels"], ["smooth", "Smooth"]]}
          onChange={(v) => setOption("smooth", v === "smooth")} />
        <span>Pixel grid</span>
        <Segmented value={options.grid ? "on" : "off"} options={[["off", "Off"], ["on", "From 800%"]]}
          onChange={(v) => setOption("grid", v === "on")} />
        <span>Clipped pixels</span>
        <Segmented value={options.clip ? "on" : "off"} options={[["off", "Off"], ["on", "Highlight"]]}
          onChange={(v) => setOption("clip", v === "on")} />
        <span>Minimap</span>
        <Segmented value={options.minimap ? "on" : "off"} options={[["off", "Off"], ["on", "On"]]}
          onChange={(v) => setOption("minimap", v === "on")} />
        <span>Histogram scale</span>
        <Segmented value={options.histLog ? "log" : "linear"} options={[["linear", "Linear"], ["log", "Log"]]}
          onChange={(v) => setOption("histLog", v === "log")} />
      </div>
    </div>
  );
}

function InfoTab({ ds }: { ds: DatasetInfo }) {
  const acq = ds.acquisition;
  const formats: Record<string, string> = {
    "biotek-gen5": "BioTek Gen5 TIFF", "ome-tiff": "OME-TIFF", imagej: "ImageJ TIFF", tiff: "TIFF",
    "multi-file": "Single-channel files combined",
  };
  const rows: [string, string | number | undefined | null][] = [
    ...(ds.files.length
      ? ds.files.map((f, i): [string, string] => [i === 0 ? "Files" : "", f.split("/").pop() ?? f])
      : [["File", ds.path] as [string, string]]),
    ["Format", formats[ds.vendor] ?? ds.vendor],
    ["Size", `${fmtInt(ds.width)} × ${fmtInt(ds.height)} px`],
    ["Channels", `${ds.channels.length} × ${ds.dtype.endsWith("u1") ? "8" : "16"}-bit`],
    ["Pixel size", ds.pixel_size_um
      ? `${ds.pixel_size_um.toFixed(4)} µm${ds.pixel_size_source === "user" ? " (Set Scale)" : ""}`
      : "unknown · Image › Set scale"],
    ["Physical size", ds.pixel_size_um
      ? `${((ds.width * ds.pixel_size_um) / 1000).toFixed(2)} × ${((ds.height * ds.pixel_size_um) / 1000).toFixed(2)} mm` : null],
    ["Objective", acq.objective as string | undefined],
    ["NA", acq.numerical_aperture],
    ["Camera", acq.camera as string | undefined],
    ["Saturation", ds.saturation ? fmtInt(ds.saturation) : null],
    ["Exposure", acq.exposure_ms !== undefined ? `${acq.exposure_ms} ms` : null],
    ["Gain", acq.camera_gain],
    ["LED intensity", acq.led_intensity],
    ["Acquired", [acq.date, acq.time].filter(Boolean).join(" ") || null],
    ["Plate / well", [acq.plate, acq.well].filter(Boolean).join(" · ") || null],
    ["Software", acq.software as string | undefined],
    ["Storage", ds.layout === "contiguous" ? "Uncompressed, read in place" : "Chunked, decoded on read"],
    ["Pyramid", `${ds.levels.length} levels${ds.build.seconds ? ` · built in ${ds.build.seconds.toFixed(1)} s` : ""}`],
  ];
  return (
    <div className="scroll">
      <dl className="info">
        {rows.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd className={typeof v === "number" ? "num" : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
      <table className="stats">
        <thead><tr><th>Channel</th><th>Type</th><th>Ex nm</th><th>Em nm</th></tr></thead>
        <tbody>
          {ds.channels.map((ch) => (
            <tr key={ch.index}>
              <td><span className="sw" style={{ display: "inline-block", background: ch.color, marginRight: 6 }} />{ch.name}</td>
              <td style={{ fontFamily: "var(--fv-font-ui)", color: "var(--fv-text-2)" }}>
                {ch.kind === "transmitted" ? "Transmitted" : "Fluor."}
              </td>
              <td>{ch.excitation_nm ?? "—"}</td>
              <td>{ch.emission_nm ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TabBody({ ds, tab }: { ds: DatasetInfo; tab: Tab }) {
  switch (tab) {
    case "channels":
      return <ChannelsTab ds={ds} />;
    case "regions":
      return <RegionsTab ds={ds} />;
    case "info":
      return <InfoTab ds={ds} />;
    default: {
      const unreachable: never = tab;
      throw new Error(`unknown tab ${unreachable}`);
    }
  }
}

export function Inspector() {
  const ds = useActive();
  const [tab, setTab] = useState<Tab>("channels");
  return (
    <aside className="panel right">
      <Tabs value={tab} options={[["channels", "Channels"], ["regions", "Regions"], ["info", "Info"]]} onChange={setTab} />
      {!ds ? <div className="empty-note">No image open.</div> : <TabBody ds={ds} tab={tab} />}
    </aside>
  );
}

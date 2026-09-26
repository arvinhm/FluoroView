import { useState } from "react";
import type { DatasetInfo } from "../api/types";
import { AUTO_HIGH, AUTO_LOW, dtypeMax } from "../lib/contrast";
import { fmtInt, fmtPercent } from "../lib/format";
import { useActive, useStudio } from "../state/store";
import { HistogramView } from "./HistogramView";
import { NumberField } from "./NumberField";

type Tab = "channels" | "info";

function ChannelRow({ ds, c }: { ds: DatasetInfo; c: number }) {
  const d = useStudio((s) => s.display[ds.id]?.[c]);
  const h = useStudio((s) => s.histograms[ds.id]?.[c]);
  const setChannel = useStudio((s) => s.setChannel);
  const ch = ds.channels[c];
  if (!d || !ch) return null;
  const top = h?.range[1] ?? dtypeMax(ds.dtype);
  const clipped = h && h.total ? h.saturated / h.total : null;

  return (
    <div className={`ch${d.visible ? "" : " off"}`}>
      <div className="ch-h">
        <button className={`checkbox${d.visible ? " on" : ""}`} role="checkbox" aria-checked={d.visible}
          title={`${d.visible ? "Hide" : "Show"} ${ch.name} (${c + 1})`}
          onClick={() => setChannel(ds.id, c, { visible: !d.visible })}>
          {d.visible && (
            <svg viewBox="0 0 10 10"><path d="M2 5.2 4.1 7.3 8 3" fill="none" stroke="#0b0c0e" strokeWidth="1.6" /></svg>
          )}
        </button>
        <span className="sw" style={{ background: d.color }} />
        <span className="ch-name">{ch.name}</span>
        {ch.excitation_nm && ch.emission_nm ? <span className="ch-wl">{ch.excitation_nm}/{ch.emission_nm} nm</span> : null}
        {clipped !== null && (
          <span className={`ch-flag${clipped > 0 ? " warn" : ""}`}
            title={ds.saturation ? `Pixels at the camera saturation level (${fmtInt(ds.saturation)})` : "Pixels at the maximum value"}>
            {clipped > 0 ? `${fmtPercent(clipped)} clipped` : "no clipping"}
          </span>
        )}
      </div>
      <HistogramView histogram={h} lo={d.lo} hi={d.hi} color={d.color}
        onWindow={(lo, hi) => setChannel(ds.id, c, { lo, hi })} />
      <div className="fields">
        <NumberField label="Min" value={d.lo} min={0} max={d.hi - 1} step={Math.max(1, Math.round(top / 1000))}
          onCommit={(v) => setChannel(ds.id, c, { lo: v })} />
        <NumberField label="Max" value={d.hi} min={d.lo + 1} max={top} step={Math.max(1, Math.round(top / 1000))}
          onCommit={(v) => setChannel(ds.id, c, { hi: v })} />
        <NumberField label="γ" value={d.gamma} digits={2} step={0.05} min={0.1} max={5}
          onCommit={(v) => setChannel(ds.id, c, { gamma: v })} title="Display gamma: above 1 brightens mid-tones" />
      </div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <span className="seg">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>
      ))}
    </span>
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
      </div>
    </div>
  );
}

function InfoTab({ ds }: { ds: DatasetInfo }) {
  const acq = ds.acquisition;
  const rows: [string, string | number | undefined | null][] = [
    ["File", ds.path],
    ["Format", { "biotek-gen5": "BioTek Gen5 TIFF", "ome-tiff": "OME-TIFF", imagej: "ImageJ TIFF", tiff: "TIFF" }[ds.vendor] ?? ds.vendor],
    ["Size", `${fmtInt(ds.width)} × ${fmtInt(ds.height)} px`],
    ["Channels", `${ds.channels.length} × ${ds.dtype.endsWith("u1") ? "8" : "16"}-bit`],
    ["Pixel size", ds.pixel_size_um ? `${ds.pixel_size_um.toFixed(4)} µm` : "unknown"],
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

export function Inspector() {
  const ds = useActive();
  const [tab, setTab] = useState<Tab>("channels");
  return (
    <aside className="panel right">
      <div className="tabs">
        <button className={`tab${tab === "channels" ? " on" : ""}`} onClick={() => setTab("channels")}>Channels</button>
        <button className={`tab${tab === "info" ? " on" : ""}`} onClick={() => setTab("info")}>Info</button>
      </div>
      {!ds ? <div className="empty-note">No image open.</div> : tab === "channels" ? <ChannelsTab ds={ds} /> : <InfoTab ds={ds} />}
    </aside>
  );
}

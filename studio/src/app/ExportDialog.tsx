import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { project } from "../api/client";
import type { Box, DatasetInfo, ExportPlan, FigureRequest } from "../api/types";
import { saveBlob } from "../lib/dom";
import { fmtInt } from "../lib/format";
import { useProject } from "../state/project";
import { toSaved, useActive, useStudio } from "../state/store";
import { regionBox } from "../viewer/geometry";
import { EXPORT_SETTINGS_KEY } from "./actions";
import { Checkbox } from "./Checkbox";
import { NumberField } from "./NumberField";
import { Segmented } from "./Segmented";

interface Settings {
  scaleBar: boolean;
  labels: boolean;
  regions: boolean;
  notes: boolean;
  png: boolean;
  tiff: boolean;
  raw: boolean;
  dpi: number;
}

const DEFAULTS: Settings = { scaleBar: true, labels: true, regions: true, notes: true, png: true, tiff: true, raw: true, dpi: 300 };

function stored(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(EXPORT_SETTINGS_KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
}

function describe(p: ExportPlan): string {
  const res = p.level === 0 ? "full resolution" : `level ${p.level} · ${p.downsample}×${p.downsample} px means`;
  return `${fmtInt(p.width)} × ${fmtInt(p.height)} px · ${res}`;
}

function ExportBody({ ds }: { ds: DatasetInfo }) {
  const setDialog = useStudio((s) => s.setDialog);
  const setNotice = useStudio((s) => s.setNotice);
  const display = useStudio((s) => s.display[ds.id]);
  const blend = useStudio((s) => s.options.blend);
  const viewBox = useStudio((s) => s.view?.box);
  const selection = useProject((s) => s.selection);
  const region = useProject((s) => (selection?.kind === "region"
    ? s.scans[ds.id]?.regions.find((r) => r.id === selection.id) : undefined));
  const [area, setArea] = useState<"region" | "view">(region ? "region" : "view");
  const [settings, setSettings] = useState<Settings>(stored);
  const [figurePlan, setFigurePlan] = useState<ExportPlan | null>(null);
  const [rawPlan, setRawPlan] = useState<ExportPlan | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [frozenView] = useState(viewBox);
  const box: Box | null = area === "region" && region ? regionBox(region) : frozenView ?? null;
  const visibleCount = display?.filter((d) => d.visible).length ?? 0;
  const body = useMemo((): FigureRequest | null => (box && display ? {
    box,
    display: display.map(toSaved),
    blend,
    format: "png", scale_bar: settings.scaleBar, labels: settings.labels, regions: settings.regions,
    notes: settings.notes, dpi: settings.dpi,
  } : null), [box?.join(), display, blend, settings]);

  useEffect(() => localStorage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify(settings)), [settings]);

  useEffect(() => {
    if (!body) return;
    let live = true;
    setError(null);
    if (visibleCount > 0) {
      project.figurePlan(ds.id, body).then((p) => live && setFigurePlan(p)).catch((e: Error) => live && setError(e.message));
    }
    project.rawPlan(ds.id, { box: body.box }).then((p) => live && setRawPlan(p)).catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [ds.id, body?.box.join(), visibleCount]);

  const set = <K extends keyof Settings>(key: K) => (v: Settings[K]) => setSettings((s) => ({ ...s, [key]: v }));
  const figures = visibleCount > 0 ? (settings.png ? 1 : 0) + (settings.tiff ? 1 : 0) : 0;
  const files = figures + (settings.raw ? 1 : 0);

  const run = async () => {
    if (!body) return;
    setBusy(true);
    setError(null);
    let done = 0;
    try {
      const jobs: [string, () => Promise<{ blob: Blob; name: string }>][] = [];
      if (visibleCount > 0 && settings.png) jobs.push(["PNG figure", () => project.figure(ds.id, { ...body, format: "png" })]);
      if (visibleCount > 0 && settings.tiff) jobs.push(["TIFF figure", () => project.figure(ds.id, { ...body, format: "tiff" })]);
      if (settings.raw) jobs.push(["raw OME-TIFF", () => project.raw(ds.id, { box: body.box })]);
      for (const [label, job] of jobs) {
        setStatus(`Rendering the ${label} (${done + 1} of ${jobs.length})…`);
        const { blob, name } = await job();
        saveBlob(blob, name);
        done++;
      }
      setDialog(null);
      setNotice(`Saved ${done} ${done === 1 ? "file" : "files"} to your browser's download folder.`);
    } catch (e) {
      setError(`${(e as Error).message}${done ? ` (${done} saved before the error)` : ""}`);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  return (
    <>
      <div className="export-body">
        <span className="caps">Area</span>
        <div className="export-cell">
          {region ? (
            <Segmented value={area} options={[["region", `Region: ${region.name}`], ["view", "Current view"]]} onChange={setArea} />
          ) : (
            <span>Current view <span className="muted">· select a region to export just its box</span></span>
          )}
          {figurePlan && <span className="muted num">{fmtInt(figurePlan.box[2] - figurePlan.box[0])} × {fmtInt(figurePlan.box[3] - figurePlan.box[1])} px of the scan</span>}
        </div>

        <span className="caps">Figure</span>
        <div className="export-cell">
          {visibleCount === 0 ? <span className="err">No channel is visible.</span> : (
            <span className="num">
              Composite + {visibleCount} {visibleCount === 1 ? "channel" : "channels"} · {figurePlan ? describe(figurePlan) : "…"}
            </span>
          )}
          <div className="check-grid">
            <Checkbox checked={settings.scaleBar && !!ds.pixel_size_um} onChange={set("scaleBar")} disabled={!ds.pixel_size_um}
              title={ds.pixel_size_um ? undefined : "The pixel size of this scan is unknown"}>Scale bar</Checkbox>
            <Checkbox checked={settings.labels} onChange={set("labels")}>Channel names</Checkbox>
            <Checkbox checked={settings.regions} onChange={set("regions")}>Region outlines</Checkbox>
            <Checkbox checked={settings.notes} onChange={set("notes")}>Note pins</Checkbox>
          </div>
        </div>

        <span className="caps">Files</span>
        <div className="export-cell">
          <Checkbox checked={settings.png} onChange={set("png")} disabled={visibleCount === 0}>
            PNG <span className="muted">8-bit RGB</span>
          </Checkbox>
          <div className="export-inline">
            <Checkbox checked={settings.tiff} onChange={set("tiff")} disabled={visibleCount === 0}>
              TIFF <span className="muted">8-bit RGB</span>
            </Checkbox>
            <div style={{ width: 96 }}>
              <NumberField label="DPI" value={settings.dpi} min={72} max={2400} step={50} onCommit={set("dpi")} />
            </div>
          </div>
          <Checkbox checked={settings.raw} onChange={set("raw")}>
            Raw OME-TIFF <span className="muted">16-bit · all {ds.channels.length} channels · real values
              {rawPlan ? ` · ${describe(rawPlan)}` : ""}</span>
          </Checkbox>
        </div>
      </div>
      <div className="dialog-f">
        <span className={error ? "err" : undefined}>
          {error ?? status ?? "Rendered by the engine from the pyramid with the current display settings."}
        </span>
        <button className="btn primary" disabled={busy || files === 0 || !body} onClick={() => void run()}>
          {busy ? "Exporting…" : `Export ${files} ${files === 1 ? "file" : "files"}`}
        </button>
      </div>
    </>
  );
}

export function ExportDialog() {
  const ds = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
      <div className="dialog export" role="dialog" aria-label="Export figure">
        <div className="dialog-h">
          Export figure
          <button className="ib" title="Close (Esc)" onClick={() => setDialog(null)}><X /></button>
        </div>
        {ds ? <ExportBody ds={ds} /> : <div className="empty-note">No image open.</div>}
      </div>
    </div>
  );
}

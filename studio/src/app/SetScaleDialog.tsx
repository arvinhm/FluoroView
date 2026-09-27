import { X } from "lucide-react";
import { useState } from "react";
import { api, project } from "../api/client";
import type { DatasetInfo } from "../api/types";
import { clearMeasurements, useProject } from "../state/project";
import { useActive, useStudio } from "../state/store";
import { NumberField } from "./NumberField";
import { Segmented } from "./Segmented";

type Unit = "nm" | "µm" | "mm";
const TO_UM: Record<Unit, number> = { nm: 0.001, "µm": 1, mm: 1000 };

function ScaleBody({ ds }: { ds: DatasetInfo }) {
  const setDialog = useStudio((s) => s.setDialog);
  const setNotice = useStudio((s) => s.setNotice);
  const upsert = useStudio((s) => s.upsertDataset);
  const line = useProject((s) => (s.line?.dsId === ds.id ? s.line : null));
  const lineLength = line ? Math.hypot(line.x1 - line.x0, line.y1 - line.y0) : null;
  const [pixels, setPixels] = useState(() => (lineLength ? Math.round(lineLength * 100) / 100 : 100));
  const [known, setKnown] = useState(() => (ds.pixel_size_um ? Math.round(pixels * ds.pixel_size_um * 100) / 100 : 100));
  const [unit, setUnit] = useState<Unit>("µm");
  const [busy, setBusy] = useState(false);
  const um = (known * TO_UM[unit]) / pixels;
  const valid = Number.isFinite(um) && um > 0;

  const apply = async (value: number | null) => {
    setBusy(true);
    try {
      await project.setCalibration(ds.id, value);
      upsert(await api.dataset(ds.id));
      clearMeasurements(ds.id);
      setDialog(null);
      setNotice(value === null ? "Scale removed: the file's pixel size is used again."
        : `Scale set: ${value.toPrecision(5)} µm per pixel, used for every measurement, scale bar and export.`);
    } catch (e) {
      setNotice(`Could not set the scale: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="export-body">
        <span className="caps">Distance</span>
        <div className="export-cell">
          <div className="scale-row">
            <div style={{ width: 150 }}>
              <NumberField label="px" value={pixels} min={0.01} max={1e7} step={1} digits={2} onCommit={setPixels} />
            </div>
            <span className="muted">=</span>
            <div style={{ width: 130 }}>
              <NumberField label="" value={known} min={0.0001} max={1e9} step={1} digits={3} onCommit={setKnown} />
            </div>
            <Segmented value={unit} options={[["nm", "nm"], ["µm", "µm"], ["mm", "mm"]]} onChange={setUnit} />
          </div>
          <span className="muted">
            {lineLength ? `The pixel distance is the length of your line (${lineLength.toFixed(2)} px).`
              : "Tip: draw a line (L) along a scale bar first and its length fills in here."}
          </span>
        </div>
        <span className="caps">Result</span>
        <div className="export-cell">
          <span className="num">{valid ? `${um.toPrecision(5)} µm per pixel` : "—"}</span>
          <span className="muted">
            {ds.file_pixel_size_um ? `The file says ${ds.file_pixel_size_um.toPrecision(5)} µm per pixel.`
              : "The file does not record a pixel size."}
            {ds.pixel_size_source === "user" ? " A scale you set is in use." : ""}
          </span>
        </div>
      </div>
      <div className="dialog-f">
        {ds.pixel_size_source === "user" && (
          <button className="btn" disabled={busy} onClick={() => void apply(null)}>Remove scale</button>
        )}
        <button className="btn primary" disabled={busy || !valid} onClick={() => void apply(um)}>Set scale</button>
      </div>
    </>
  );
}

export function SetScaleDialog() {
  const ds = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
      <div className="dialog export" role="dialog" aria-label="Set scale">
        <div className="dialog-h">
          Set scale
          <button className="ib" title="Close (Esc)" onClick={() => setDialog(null)}><X /></button>
        </div>
        {ds ? <ScaleBody ds={ds} /> : <div className="empty-note">No image open.</div>}
      </div>
    </div>
  );
}

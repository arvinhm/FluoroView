import { X } from "lucide-react";
import { useState } from "react";
import type { DatasetInfo } from "../api/types";
import { regionOp, selectedRegions, useProject, useScan } from "../state/project";
import { useActive, useStudio } from "../state/store";
import { NumberField } from "./NumberField";
import { Segmented } from "./Segmented";

type Unit = "um" | "px";
type Direction = "enlarge" | "shrink";

function listNames(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
}

function EnlargeBody({ ds }: { ds: DatasetInfo }) {
  const setDialog = useStudio((s) => s.setDialog);
  const selection = useProject((s) => s.selection);
  const scan = useScan(ds.id);
  const picked = selectedRegions(selection).filter((id) => scan.regions.some((r) => r.id === id));
  const names = picked.map((id) => scan.regions.find((r) => r.id === id)!.name);
  const [amount, setAmount] = useState(5);
  const [unit, setUnit] = useState<Unit>(ds.pixel_size_um ? "um" : "px");
  const [direction, setDirection] = useState<Direction>("enlarge");
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    const done = await regionOp(ds.id, {
      op: "enlarge", ids: picked, distance: direction === "enlarge" ? amount : -amount, unit,
    });
    setBusy(false);
    if (done) setDialog(null);
  };

  return (
    <>
      <div className="export-body">
        <span className="caps">{picked.length === 1 ? "Region" : "Regions"}</span>
        <div className="export-cell">
          <span>{picked.length ? listNames(names) : "Select a region first."}</span>
        </div>
        <span className="caps">Distance</span>
        <div className="export-cell">
          <div className="scale-row">
            <Segmented value={direction} options={[["enlarge", "Enlarge"], ["shrink", "Shrink"]]} onChange={setDirection} />
            <div style={{ width: 120 }}>
              <NumberField label="" value={amount} min={0.01} max={1e6} step={1} digits={2} onCommit={setAmount} />
            </div>
            {ds.pixel_size_um
              ? <Segmented value={unit} options={[["um", "µm"], ["px", "px"]]} onChange={setUnit} />
              : <span className="muted">px</span>}
          </div>
          <span className="muted">
            Rectangles and ellipses keep their shape; other shapes grow or shrink with rounded corners. Each result is
            a new region, and the original is kept.
          </span>
        </div>
      </div>
      <div className="dialog-f">
        <button className="btn primary" disabled={busy || !picked.length} onClick={() => void apply()}>
          {direction === "enlarge" ? "Enlarge" : "Shrink"}
        </button>
      </div>
    </>
  );
}

export function EnlargeDialog() {
  const ds = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
      <div className="dialog export" role="dialog" aria-label="Enlarge or shrink">
        <div className="dialog-h">
          Enlarge or shrink
          <button className="ib" title="Close (Esc)" onClick={() => setDialog(null)}><X /></button>
        </div>
        {ds ? <EnlargeBody ds={ds} /> : <div className="empty-note">No image open.</div>}
      </div>
    </div>
  );
}

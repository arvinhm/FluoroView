import { X } from "lucide-react";
import { useState } from "react";
import type { DatasetInfo, Point, Region } from "../api/types";
import { commitRegion, createRegion, useProject, useScan } from "../state/project";
import { useActive, useStudio } from "../state/store";
import { regionBox } from "../viewer/geometry";
import { NumberField } from "./NumberField";
import { Segmented } from "./Segmented";

type Unit = "px" | "um";
type BoxShape = "rectangle" | "ellipse";
/** x, y (top-left corner), width, height in full-resolution pixels */
type Rect = [number, number, number, number];

const NEW_SIDE_PX = 100;

function startRect(region: Region | undefined): Rect {
  if (region) {
    const [x0, y0, x1, y1] = regionBox(region);
    return [x0, y0, x1 - x0, y1 - y0];
  }
  const view = useStudio.getState().view;
  const half = NEW_SIDE_PX / 2;
  return view ? [Math.round(view.cx - half), Math.round(view.cy - half), NEW_SIDE_PX, NEW_SIDE_PX]
    : [0, 0, NEW_SIDE_PX, NEW_SIDE_PX];
}

function SpecifyBody({ ds }: { ds: DatasetInfo }) {
  const setDialog = useStudio((s) => s.setDialog);
  const selection = useProject((s) => s.selection);
  const scan = useScan(ds.id);
  const editing = selection?.kind === "region"
    ? scan.regions.find((r) => r.id === selection.id && (r.shape === "rectangle" || r.shape === "ellipse"))
    : undefined;
  const [shape, setShape] = useState<BoxShape>(editing?.shape === "ellipse" ? "ellipse" : "rectangle");
  const [unit, setUnit] = useState<Unit>("px");
  const [rect, setRect] = useState<Rect>(() => startRect(editing));
  const per = unit === "um" && ds.pixel_size_um ? ds.pixel_size_um : 1;
  const corners = (): [Point, Point] => {
    const [x, y, w, h] = rect;
    return [[Math.round(x), Math.round(y)], [Math.round(x + w), Math.round(y + h)]];
  };
  const [[ax, ay], [bx, by]] = corners();
  const valid = bx - ax >= 1 && by - ay >= 1;

  const field = (i: number, label: string, min: number) => (
    <NumberField label={label} value={rect[i]! * per} min={min} max={1e9} step={unit === "um" ? 1 : 10}
      digits={unit === "um" ? 2 : 0}
      onCommit={(v) => setRect((r) => r.map((q, k) => (k === i ? v / per : q)) as Rect)} />
  );

  const done = (region: Promise<unknown>) => void region.then(() => setDialog(null));

  return (
    <>
      <div className="export-body">
        <span className="caps">Shape</span>
        <div className="export-cell">
          {editing
            ? <span>{editing.name} · {editing.shape === "ellipse" ? "ellipse" : "rectangle"}</span>
            : <Segmented value={shape} options={[["rectangle", "Rectangle"], ["ellipse", "Ellipse"]]} onChange={setShape} />}
        </div>
        <span className="caps">Position</span>
        <div className="export-cell">
          <div className="spec-grid">
            {field(0, "x", -1e9)}
            {field(1, "y", -1e9)}
            {field(2, "w", 0)}
            {field(3, "h", 0)}
          </div>
          <div className="scale-row">
            {ds.pixel_size_um
              ? <Segmented value={unit} options={[["px", "px"], ["um", "µm"]]} onChange={setUnit} />
              : <span className="muted">Pixels (the image has no pixel size).</span>}
            <span className="muted num">
              {valid ? `${ax}, ${ay} → ${bx}, ${by} px` : "Width and height must be at least one pixel."}
            </span>
          </div>
          <span className="muted">x and y are the top-left corner. Regions sit on whole pixels.</span>
        </div>
      </div>
      <div className="dialog-f">
        {editing && (
          <button className="btn" disabled={!valid} onClick={() => done(createRegion(ds.id, editing.shape, corners(),
            { color: editing.color }))}>Add as new region</button>
        )}
        <button className="btn primary" disabled={!valid}
          onClick={() => done(editing ? commitRegion(ds.id, editing.id, corners()) : createRegion(ds.id, shape, corners()))}>
          {editing ? `Update ${editing.name}` : "Add region"}
        </button>
      </div>
    </>
  );
}

export function SpecifyDialog() {
  const ds = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
      <div className="dialog export" role="dialog" aria-label="Specify region">
        <div className="dialog-h">
          Specify region
          <button className="ib" title="Close (Esc)" onClick={() => setDialog(null)}><X /></button>
        </div>
        {ds ? <SpecifyBody ds={ds} /> : <div className="empty-note">No image open.</div>}
      </div>
    </div>
  );
}

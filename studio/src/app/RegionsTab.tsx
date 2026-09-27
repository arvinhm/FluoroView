import { Download } from "lucide-react";
import { useEffect } from "react";
import type { DatasetInfo, RegionCombine } from "../api/types";
import { fmtArea, fmtInt } from "../lib/format";
import {
  measureAll, measureKey, regionOp, select, selectedRegions, toggleRegion, useProject, useScan,
} from "../state/project";
import { useStudio } from "../state/store";
import { focusViewer } from "../viewer/commands";
import { regionBox } from "../viewer/geometry";
import { SHAPE_ICON } from "../viewer/MeasureCard";
import { exportRegionsCsv } from "./actions";
import { COMBINE } from "./commands";
import { CountsSection } from "./CountsSection";

const NOTE_FOCUS_PX = 240;
const SHORT: Record<RegionCombine, string> = { union: "Union", intersect: "Intersect", xor: "XOR", subtract: "Subtract" };

export function RegionsTab({ ds }: { ds: DatasetInfo }) {
  const scan = useScan(ds.id);
  const selection = useProject((s) => s.selection);
  const measures = useProject((s) => s.measures);
  const display = useStudio((s) => s.display[ds.id]);

  useEffect(() => measureAll(ds.id), [ds.id, scan.regions]);

  const picked = selectedRegions(selection);
  const firstName = scan.regions.find((r) => r.id === picked[0])?.name ?? "The first region";
  const visible = ds.channels.flatMap((_, i) => (display?.[i]?.visible ? [i] : []));
  const bg = scan.background ? measures[measureKey(ds.id, scan.background)]?.data ?? null : null;

  return (
    <div className="scroll">
      <div className="toolrow">
        <button className="btn" disabled={!scan.regions.length} onClick={() => void exportRegionsCsv(ds.id)}
          title="One row per region × channel, measured on raw full-resolution pixels">
          <Download /> Export CSV
        </button>
        <span className="muted" style={{ fontSize: "var(--fv-fs-sm)" }}>
          {scan.regions.length} {scan.regions.length === 1 ? "region" : "regions"}
        </span>
      </div>

      {scan.regions.length === 0 ? (
        <div className="empty-note">
          Draw a region with <span className="kbd-inline">R</span> <span className="kbd-inline">E</span>{" "}
          <span className="kbd-inline">P</span> or <span className="kbd-inline">F</span>. Measurements use the raw
          full-resolution pixels.
        </div>
      ) : (
        <>
          <div className="rlist">
            {scan.regions.map((r) => {
              const Icon = SHAPE_ICON[r.shape];
              const m = measures[measureKey(ds.id, r.id)];
              return (
                <button key={r.id} className={`row${picked.includes(r.id) ? " sel" : ""}`}
                  title="⇧ or ⌘-click to select several regions"
                  onClick={(e) => {
                    if (e.shiftKey || e.metaKey || e.ctrlKey) {
                      toggleRegion(r.id);
                      return;
                    }
                    select({ kind: "region", id: r.id });
                    focusViewer(regionBox(r));
                  }}>
                  <Icon />
                  <span className="name">{r.name}</span>
                  {scan.background === r.id && <span className="badge">BG</span>}
                  <span className="aux">{m?.data ? fmtArea(m.data.area_px, m.data.area_um2) : m?.loading ? "…" : ""}</span>
                </button>
              );
            })}
          </div>
          {picked.length >= 2 && (
            <div className="ops-bar">
              <span className="muted">{picked.length} selected</span>
              {COMBINE.map(([op, , hint]) => (
                <button key={op} className="btn" title={op === "subtract" ? `${firstName} minus the others` : hint}
                  onClick={() => void regionOp(ds.id, { op, ids: picked })}>
                  {SHORT[op]}
                </button>
              ))}
            </div>
          )}
          <div className="sec-h"><span className="caps">{bg ? "Mean − background" : "Mean intensity"}</span></div>
          {visible.length === 0 ? (
            <div className="empty-note">No channels are visible.</div>
          ) : (
            <div className="tscroll">
              <table className="stats">
                <thead>
                  <tr>
                    <th>Region</th>
                    {visible.map((c) => (
                      <th key={c}><span className="sw" style={{ background: display![c]!.color, marginRight: 5 }} />{ds.channels[c]!.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scan.regions.map((r) => {
                    const m = measures[measureKey(ds.id, r.id)]?.data;
                    return (
                      <tr key={r.id} className={picked.includes(r.id) ? "sel" : undefined}>
                        <td>{r.name}</td>
                        {visible.map((c) => {
                          const mean = m?.channels[c]?.mean ?? null;
                          const base = bg ? bg.channels[c]?.mean ?? null : null;
                          const v = mean === null ? null : base === null ? mean : mean - base;
                          return <td key={c}>{v === null ? "…" : fmtInt(v)}</td>;
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <CountsSection ds={ds} />

      <div className="sec-h"><span className="caps">Notes</span></div>
      {scan.notes.length === 0 ? (
        <div className="empty-note">Press <span className="kbd-inline">N</span> and click the image to pin a note.</div>
      ) : (
        scan.notes.map((n, i) => (
          <button key={n.id} className={`row note-row${selection?.id === n.id ? " sel" : ""}`}
            onClick={() => {
              select({ kind: "note", id: n.id });
              focusViewer([n.x - NOTE_FOCUS_PX, n.y - NOTE_FOCUS_PX, n.x + NOTE_FOCUS_PX, n.y + NOTE_FOCUS_PX]);
            }}>
            <span className="note-num">{i + 1}</span>
            <span className="name">{n.text}</span>
            {n.replies.length > 0 && <span className="aux">{n.replies.length} {n.replies.length === 1 ? "reply" : "replies"}</span>}
          </button>
        ))
      )}
    </div>
  );
}

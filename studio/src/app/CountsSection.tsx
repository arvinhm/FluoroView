import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Counter, DatasetInfo } from "../api/types";
import { fmtInt } from "../lib/format";
import { addCounter, deleteCounter, editCounter, setActiveCounter, useProject, useScan } from "../state/project";
import { useStudio } from "../state/store";
import { exportCountsCsv, exportPointsCsv } from "./actions";

function CounterRow({ ds, counter, count, active }: { ds: DatasetInfo; counter: Counter; count: number; active: boolean }) {
  const setTool = useStudio((s) => s.setTool);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirming]);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const remove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (count > 0 && !confirming) setConfirming(true);
    else void deleteCounter(ds.id, counter.id);
  };
  return (
    <div className={`row counter-row${active ? " sel" : ""}`} role="button" tabIndex={0}
      title="Count in this category (K)"
      onClick={() => {
        setActiveCounter(counter.id);
        setTool("count");
      }}>
      <input type="color" className="counter-color" value={counter.color} aria-label={`Colour of ${counter.name}`}
        onClick={stop} onChange={(e) => void editCounter(ds.id, counter.id, { color: e.target.value })} />
      {renaming ? (
        <input className="mcard-input" autoFocus defaultValue={counter.name} aria-label="Category name" onClick={stop}
          onBlur={(e) => {
            setRenaming(false);
            const name = e.currentTarget.value.trim();
            if (name && name !== counter.name) void editCounter(ds.id, counter.id, { name });
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setRenaming(false);
          }} />
      ) : (
        <span className="name" onDoubleClick={(e) => {
          e.stopPropagation();
          setRenaming(true);
        }}>{counter.name}</span>
      )}
      <span className="aux num">{fmtInt(count)}</span>
      <button className={`ib${confirming ? " danger" : ""}`} onClick={remove}
        title={confirming ? `Click again to delete ${counter.name} and its ${count} points` : "Delete this category"}>
        <Trash2 />
      </button>
    </div>
  );
}

export function CountsSection({ ds }: { ds: DatasetInfo }) {
  const { counters, points } = useScan(ds.id);
  const active = useProject((s) => s.activeCounter);
  const counts = new Map<string, number>();
  for (const p of points) counts.set(p.counter, (counts.get(p.counter) ?? 0) + 1);
  const current = counters.some((c) => c.id === active) ? active : counters[0]?.id;
  return (
    <>
      <div className="sec-h">
        <span className="caps">Counts</span>
        {points.length > 0 && <span className="meta num">{fmtInt(points.length)}</span>}
        <span className="act">
          <button className="ib" title="Add a category" onClick={() => void addCounter(ds.id)}><Plus /></button>
        </span>
      </div>
      {counters.length === 0 ? (
        <div className="empty-note">
          Press <span className="kbd-inline">K</span> and click cells to count them; categories appear here.
        </div>
      ) : (
        counters.map((c) => <CounterRow key={c.id} ds={ds} counter={c} count={counts.get(c.id) ?? 0} active={c.id === current} />)
      )}
      {points.length > 0 && (
        <div className="toolrow">
          <button className="btn" onClick={() => void exportPointsCsv(ds.id)} title="One row per counted point">Points CSV</button>
          <button className="btn" onClick={() => void exportCountsCsv(ds.id)}
            title="Counts and densities per category and region">Counts CSV</button>
        </div>
      )}
    </>
  );
}

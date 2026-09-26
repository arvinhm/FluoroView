import { type CSSProperties, useEffect, useState } from "react";
import { api } from "../api/client";
import type { DatasetInfo, FsEntry, FsListing } from "../api/types";
import { fmtBytes, fmtInt } from "../lib/format";
import { useActive, useStudio } from "../state/store";
import { openImage } from "./actions";
import { dotClass } from "./ProjectPanel";

function ScanCard({ entry, index, open, active }: { entry: FsEntry; index: number; open?: DatasetInfo; active: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const ready = entry.cached || open?.build.state === "ready";

  useEffect(() => {
    if (!ready) {
      setMissing(true);
      return;
    }
    const ctl = new AbortController();
    let url: string | null = null;
    api.thumbnail(entry.path, 480, ctl.signal)
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setSrc(url);
        setMissing(false);
      })
      .catch(() => !ctl.signal.aborted && setMissing(true));
    return () => {
      ctl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [entry.path, ready]);

  return (
    <button className={`card${active ? " sel" : ""}`} style={{ "--i": index } as CSSProperties}
      onClick={() => void openImage(entry.path)} title={entry.path}>
      <div className="card-thumb">
        {src ? <img src={src} alt="" /> : <span className="placeholder">{missing ? "Not read yet" : ""}</span>}
      </div>
      <div className="card-meta">
        <span className="card-name">{entry.name.replace(/\.(ome\.)?tiff?$/i, "")}</span>
        <span className="card-sub">
          <span className={`dot ${dotClass(entry, open)}`} />
          {entry.size !== null ? fmtBytes(entry.size) : ""}
          {open ? ` · ${fmtInt(open.width)} × ${fmtInt(open.height)} · ${open.channels.length} ch` : ""}
        </span>
      </div>
    </button>
  );
}

export function ScanGallery() {
  const ds = useActive();
  const datasets = useStudio((s) => s.datasets);
  const setPage = useStudio((s) => s.setPage);
  const [listing, setListing] = useState<FsListing | null>(null);
  const folder = ds?.folder;

  useEffect(() => {
    if (!folder) return;
    let live = true;
    api.list(folder).then((l) => live && setListing(l)).catch(() => live && setListing(null));
    return () => {
      live = false;
    };
  }, [folder]);

  const byPath = new Map(Object.values(datasets).filter((d) => d.files.length === 0).map((d) => [d.path, d]));
  const files = listing?.entries.filter((e) => !e.dir) ?? [];

  return (
    <div className="scans">
      <div className="scans-h">
        <h2>{listing?.path.split("/").pop() ?? "Scans"}</h2>
        <span className="caps">{files.length} scans</span>
        <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setPage("viewer")}>Back to image</button>
      </div>
      <div className="scans-grid">
        {files.map((f, i) => (
          <ScanCard key={f.path} entry={f} index={i} open={byPath.get(f.path)} active={byPath.get(f.path)?.id === ds?.id} />
        ))}
      </div>
    </div>
  );
}

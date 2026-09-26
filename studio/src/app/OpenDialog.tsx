import { ArrowUp, Folder, HardDrive, House, Image, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { FsListing } from "../api/types";
import { fmtBytes } from "../lib/format";
import { useActive, useStudio } from "../state/store";
import { openChannels, openImage } from "./actions";

export function OpenDialog() {
  const active = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);

  const go = useCallback((p?: string) => {
    setError(null);
    setSelected([]);
    setAnchor(null);
    api.list(p).then((l) => {
      setListing(l);
      setPath(l.path);
    }).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => go(active?.folder), [go, active?.folder]);

  const files = listing?.entries.filter((e) => !e.dir) ?? [];

  const select = (index: number, e: React.MouseEvent) => {
    const p = files[index]!.path;
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(files.slice(a, b + 1).map((f) => f.path));
    } else if (e.metaKey || e.ctrlKey) {
      setSelected((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
      setAnchor(index);
    } else {
      setSelected([p]);
      setAnchor(index);
    }
  };

  const open = async (paths: string[]) => {
    const ordered = files.map((f) => f.path).filter((p) => paths.includes(p));
    const ok = ordered.length > 1 ? await openChannels(ordered) : ordered[0] ? await openImage(ordered[0]) : false;
    if (ok) setDialog(null);
  };

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
      <div className="dialog" role="dialog" aria-label="Open image">
        <div className="dialog-h">
          Open image
          <button className="ib" onClick={() => setDialog(null)} title="Close (Esc)"><X /></button>
        </div>
        <div className="pathbar">
          <button className="ib" title="Home" onClick={() => go()}><House /></button>
          <button className="ib" title="Volumes" onClick={() => go("/Volumes")}><HardDrive /></button>
          <button className="ib" title="Up" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)}><ArrowUp /></button>
          <input className="input" value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go(path)} aria-label="Folder path" />
        </div>
        <div className="scroll">
          {error && <div className="empty-note err">{error}</div>}
          {listing?.entries.length === 0 && <div className="empty-note">No folders or TIFF images here.</div>}
          {listing?.entries.filter((e) => e.dir).map((e) => (
            <button key={e.path} className="row" title={e.path} onClick={() => go(e.path)}>
              <Folder />
              <span className="name">{e.name}</span>
            </button>
          ))}
          {files.map((e, i) => (
            <button key={e.path} className={`row${selected.includes(e.path) ? " sel" : ""}`} title={e.path}
              onClick={(ev) => select(i, ev)} onDoubleClick={() => void open([e.path])}>
              <Image />
              <span className="name" style={{ color: "var(--fv-text-1)" }}>{e.name}</span>
              {e.cached && <span className="aux" title="Zoom pyramid already cached">cached</span>}
              {e.size !== null && <span className="aux">{fmtBytes(e.size)}</span>}
            </button>
          ))}
        </div>
        <div className="dialog-f">
          <span>⌘-click or ⇧-click several single-channel files to combine them as channels.</span>
          <button className="btn primary" disabled={selected.length === 0} onClick={() => void open(selected)}>
            {selected.length > 1 ? `Open ${selected.length} files as channels` : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}

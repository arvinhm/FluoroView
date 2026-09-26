import { ArrowUp, Folder, HardDrive, House, Image, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { FsListing } from "../api/types";
import { fmtBytes } from "../lib/format";
import { useActive, useStudio } from "../state/store";
import { dirname, openImage } from "./actions";

export function OpenDialog() {
  const active = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const go = useCallback((p?: string) => {
    setError(null);
    setSelected(null);
    api.list(p).then((l) => {
      setListing(l);
      setPath(l.path);
    }).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => go(active ? dirname(active.path) : undefined), [go, active]);

  const open = async (p: string) => {
    if (await openImage(p)) setDialog(null);
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
          {listing?.entries.map((e) => (
            <button key={e.path} className={`row${selected === e.path ? " sel" : ""}`} title={e.path}
              onClick={() => (e.dir ? go(e.path) : setSelected(e.path))}
              onDoubleClick={() => !e.dir && void open(e.path)}>
              {e.dir ? <Folder /> : <Image />}
              <span className="name" style={{ color: e.dir ? undefined : "var(--fv-text-1)" }}>{e.name}</span>
              {!e.dir && e.cached && <span className="aux" title="Zoom pyramid already cached">cached</span>}
              {e.size !== null && <span className="aux">{fmtBytes(e.size)}</span>}
            </button>
          ))}
        </div>
        <div className="dialog-f">
          <span>TIFF, OME-TIFF, BioTek Gen5, ImageJ. The file is read where it is.</span>
          <button className="btn primary" disabled={!selected} onClick={() => selected && void open(selected)}>Open</button>
        </div>
      </div>
    </div>
  );
}

import { ArrowUp, Bookmark, Folder, HardDrive, House, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { DatasetInfo, FsListing } from "../api/types";
import { fmtBytes } from "../lib/format";
import { useActive, useStudio } from "../state/store";
import { saveSession, sessionName } from "./actions";

const SUFFIX = ".fv";

function withSuffix(name: string): string {
  return name.toLowerCase().endsWith(SUFFIX) ? name : `${name}${SUFFIX}`;
}

function SaveBody({ ds }: { ds: DatasetInfo }) {
  const setDialog = useStudio((s) => s.setDialog);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState(() => sessionName(ds));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = useCallback((p?: string) => {
    setError(null);
    api.list(p).then((l) => {
      setListing(l);
      setFolder(l.path);
    }).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => go(ds.folder), [go, ds.folder]);

  const file = withSuffix(name.trim());
  const existing = listing?.entries.find((e) => !e.dir && e.name === file);
  const sessions = listing?.entries.filter((e) => e.session) ?? [];

  const save = async () => {
    if (!listing || !name.trim()) return;
    setBusy(true);
    const saved = await saveSession(ds.id, `${listing.path}/${file}`, Boolean(existing));
    setBusy(false);
    if (saved) setDialog(null);
  };

  return (
    <>
      <div className="pathbar">
        <button className="ib" title="Home" onClick={() => go()}><House /></button>
        <button className="ib" title="Volumes" onClick={() => go("/Volumes")}><HardDrive /></button>
        <button className="ib" title="Up" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)}><ArrowUp /></button>
        <input className="input" value={folder} spellCheck={false} onChange={(e) => setFolder(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(folder)} aria-label="Folder" />
      </div>
      <div className="scroll">
        {error && <div className="empty-note err">{error}</div>}
        {listing && !listing.entries.some((e) => e.dir || e.session) && (
          <div className="empty-note">No sessions saved in this folder yet.</div>
        )}
        {listing?.entries.filter((e) => e.dir).map((e) => (
          <button key={e.path} className="row" title={e.path} onClick={() => go(e.path)}>
            <Folder />
            <span className="name">{e.name}</span>
          </button>
        ))}
        {sessions.map((e) => (
          <button key={e.path} className={`row${e.name === file ? " sel" : ""}`} title={e.path} onClick={() => setName(e.name)}>
            <Bookmark />
            <span className="name" style={{ color: "var(--fv-text-1)" }}>{e.name}</span>
            {e.size !== null && <span className="aux">{fmtBytes(e.size)}</span>}
          </button>
        ))}
      </div>
      <div className="dialog-f save-f">
        <input className="input" value={name} spellCheck={false} aria-label="Session file name" autoFocus
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        <span className={existing ? "err" : undefined}>
          {existing ? `${file} exists and will be replaced.` : "Regions, notes, display, view and export settings."}
        </span>
        <button className="btn primary" disabled={busy || !name.trim() || !listing} onClick={() => void save()}>
          {busy ? "Saving…" : existing ? "Replace" : "Save"}
        </button>
      </div>
    </>
  );
}

export function SaveSessionDialog() {
  const ds = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
      <div className="dialog" role="dialog" aria-label="Save session">
        <div className="dialog-h">
          Save session
          <button className="ib" title="Close (Esc)" onClick={() => setDialog(null)}><X /></button>
        </div>
        {ds ? <SaveBody ds={ds} /> : <div className="empty-note">No image open.</div>}
      </div>
    </div>
  );
}

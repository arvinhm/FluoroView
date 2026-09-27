import { ArrowUp, Folder, HardDrive, House, Image, Layers, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { FsListing } from "../api/types";
import { fmtBytes } from "../lib/format";
import { useActive, useStudio } from "../state/store";
import { openChannels, openImage, openSession, restoreInto } from "./actions";

export function OpenDialog() {
  const active = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  const pending = useStudio((s) => s.pendingSession);
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
  useEffect(() => () => useStudio.getState().setPendingSession(null), []);

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

  const isSession = (p: string) => files.some((f) => f.path === p && f.session);

  const open = async (paths: string[]) => {
    const session = paths.find(isSession);
    if (session) {
      if (await openSession(session)) setDialog(null);
      return;
    }
    const ordered = files.map((f) => f.path).filter((p) => paths.includes(p));
    const ok = ordered.length > 1 ? await openChannels(ordered) : ordered[0] ? await openImage(ordered[0]) : false;
    if (!ok) return;
    setDialog(null);
    const id = useStudio.getState().activeId;
    if (pending && id) await restoreInto(id, pending.path);
  };

  const close = () => setDialog(null);

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-label="Open image">
        <div className="dialog-h">
          {pending ? "Choose the image for this session" : "Open image or session"}
          <button className="ib" onClick={close} title="Close (Esc)"><X /></button>
        </div>
        {pending && (
          <div className="banner">
            <Layers />
            <span>
              <b>{pending.path.split("/").pop()}</b> belongs to <b>{pending.names.join(", ")}</b>, which was not found at
              its saved location or next to the session. Open it here and the session is restored onto it.
            </span>
          </div>
        )}
        <div className="pathbar">
          <button className="ib" title="Home" onClick={() => go()}><House /></button>
          <button className="ib" title="Volumes" onClick={() => go("/Volumes")}><HardDrive /></button>
          <button className="ib" title="Up" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)}><ArrowUp /></button>
          <input className="input" value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go(path)} aria-label="Folder path" />
        </div>
        <div className="scroll">
          {error && <div className="empty-note err">{error}</div>}
          {listing?.entries.length === 0 && <div className="empty-note">No folders, images or sessions here.</div>}
          {listing?.entries.filter((e) => e.dir).map((e) => (
            <button key={e.path} className="row" title={e.path} onClick={() => go(e.path)}>
              <Folder />
              <span className="name">{e.name}</span>
            </button>
          ))}
          {files.map((e, i) => (
            <button key={e.path} className={`row${selected.includes(e.path) ? " sel" : ""}`} title={e.path}
              onClick={(ev) => select(i, ev)} onDoubleClick={() => void open([e.path])}>
              {e.session ? <Layers /> : <Image />}
              <span className="name" style={{ color: "var(--fv-text-1)" }}>{e.name}</span>
              {e.session && <span className="aux">session</span>}
              {e.cached && <span className="aux" title="Zoom pyramid already cached">cached</span>}
              {e.size !== null && <span className="aux">{fmtBytes(e.size)}</span>}
            </button>
          ))}
        </div>
        <div className="dialog-f">
          <span>⌘-click or ⇧-click several single-channel files to combine them as channels. A .fv reopens a session.</span>
          <button className="btn primary" disabled={selected.length === 0} onClick={() => void open(selected)}>
            {selected.some(isSession) ? "Open session" : selected.length > 1 ? `Open ${selected.length} files as channels` : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}

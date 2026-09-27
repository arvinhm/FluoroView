import { Bookmark, Eye, EyeOff, FolderOpen, Image, LayoutGrid, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { DatasetInfo, FsEntry, FsListing } from "../api/types";
import { fmtBytes } from "../lib/format";
import { useActive, useStudio } from "../state/store";
import { openImage, openSession } from "./actions";

export function dotClass(entry: FsEntry | null, open: DatasetInfo | undefined): string {
  if (open) {
    switch (open.build.state) {
      case "ready":
        return "ready";
      case "building":
      case "queued":
        return "busy";
      case "failed":
      case "cancelled":
        return "failed";
      default: {
        const unreachable: never = open.build.state;
        return unreachable;
      }
    }
  }
  return entry?.cached ? "ready" : "idle";
}

export function ProjectPanel() {
  const ds = useActive();
  const datasets = useStudio((s) => s.datasets);
  const display = useStudio((s) => (ds ? s.display[ds.id] : undefined));
  const setChannel = useStudio((s) => s.setChannel);
  const setDialog = useStudio((s) => s.setDialog);
  const setActive = useStudio((s) => s.setActive);
  const page = useStudio((s) => s.page);
  const setPage = useStudio((s) => s.setPage);
  const [listing, setListing] = useState<FsListing | null>(null);
  const folder = ds?.folder ?? null;
  const buildState = ds?.build.state;

  useEffect(() => {
    if (!folder) return;
    let live = true;
    api.list(folder).then((l) => live && setListing(l)).catch(() => live && setListing(null));
    return () => {
      live = false;
    };
  }, [folder, buildState]);

  const byPath = new Map(Object.values(datasets).filter((d) => d.files.length === 0).map((d) => [d.path, d]));
  const combined = Object.values(datasets).filter((d) => d.files.length > 1 && d.folder === listing?.path);
  const files = listing?.entries.filter((e) => !e.dir && !e.session) ?? [];
  const sessions = listing?.entries.filter((e) => e.session) ?? [];
  const allVisible = display?.every((d) => d.visible) ?? false;

  return (
    <aside className="panel left">
      <div className="sec grow">
        <div className="sec-h">
          <span className="caps">Project</span>
          {listing && <span className="meta">{listing.path.split("/").pop()} · {files.length}</span>}
          <span className="act">
            <button className={`ib${page === "scans" ? " on" : ""}`} title="Scan gallery" disabled={!ds}
              onClick={() => setPage(page === "scans" ? "viewer" : "scans")}><LayoutGrid /></button>
            <button className="ib" title="Open image… (⌘O)" onClick={() => setDialog("open")}><FolderOpen /></button>
          </span>
        </div>
        {listing && <div className="hint" title={listing.path}>{listing.path}</div>}
        <div className="scroll">
          {!ds && <div className="empty-note">Open an image to list the scans in its folder.</div>}
          {combined.map((d) => (
            <button key={d.id} className={`row${d.id === ds?.id ? " sel" : ""}`} title={d.files.join("\n")}
              onClick={() => setActive(d.id)}>
              <Layers />
              <span className="name">{d.channels.map((c) => c.name).join(" · ")}</span>
              <span className="aux">{d.files.length} files</span>
            </button>
          ))}
          {files.map((f) => {
            const open = byPath.get(f.path);
            return (
              <button key={f.path} className={`row${open && open.id === ds?.id ? " sel" : ""}`} title={f.path}
                onClick={() => void openImage(f.path)}>
                <span className={`dot ${dotClass(f, open)}`} />
                <span className="name">{f.name.replace(/\.(ome\.)?tiff?$/i, "")}</span>
                <span className="aux">{f.size !== null ? fmtBytes(f.size) : ""}</span>
              </button>
            );
          })}
          {sessions.length > 0 && <div className="sub-h caps">Sessions</div>}
          {sessions.map((f) => (
            <button key={f.path} className="row" title={f.path} onClick={() => void openSession(f.path)}>
              <Bookmark />
              <span className="name">{f.name.replace(/\.fv$/i, "")}</span>
              <span className="aux">{f.size !== null ? fmtBytes(f.size) : ""}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="sec">
        <div className="sec-h"><span className="caps">Layers</span></div>
        {ds && display ? (
          <div className="row">
            <Image />
            <span className="name" style={{ color: "var(--fv-text-1)" }}>Image</span>
            <span className="aux">{ds.channels.length} ch · {ds.dtype.endsWith("u1") ? "8" : "16"}-bit</span>
            <button className="ib" title={allVisible ? "Hide all channels" : "Show all channels"}
              onClick={() => display.forEach((_, c) => setChannel(ds.id, c, { visible: !allVisible }))}>
              {allVisible ? <Eye /> : <EyeOff />}
            </button>
          </div>
        ) : (
          <div className="empty-note">No layers.</div>
        )}
        <div style={{ height: 6 }} />
      </div>
    </aside>
  );
}

import { Eye, EyeOff, FolderOpen, Image } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { DatasetInfo, FsEntry, FsListing } from "../api/types";
import { fmtBytes } from "../lib/format";
import { useActive, useStudio } from "../state/store";
import { dirname, openImage } from "./actions";

function dotClass(entry: FsEntry, open: DatasetInfo | undefined): string {
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
  return entry.cached ? "ready" : "idle";
}

export function ProjectPanel() {
  const ds = useActive();
  const datasets = useStudio((s) => s.datasets);
  const display = useStudio((s) => (ds ? s.display[ds.id] : undefined));
  const setChannel = useStudio((s) => s.setChannel);
  const setDialog = useStudio((s) => s.setDialog);
  const [listing, setListing] = useState<FsListing | null>(null);
  const folder = ds ? dirname(ds.path) : null;
  const buildState = ds?.build.state;

  useEffect(() => {
    if (!folder) return;
    let live = true;
    api.list(folder).then((l) => live && setListing(l)).catch(() => live && setListing(null));
    return () => {
      live = false;
    };
  }, [folder, buildState]);

  const byPath = new Map(Object.values(datasets).map((d) => [d.path, d]));
  const files = listing?.entries.filter((e) => !e.dir) ?? [];
  const allVisible = display?.every((d) => d.visible) ?? false;

  return (
    <aside className="panel left">
      <div className="sec grow">
        <div className="sec-h">
          Project
          {listing && <span className="meta">{listing.path.split("/").pop()} · {files.length} scans</span>}
          <span className="act">
            <button className="ib" title="Open image… (⌘O)" onClick={() => setDialog("open")}><FolderOpen /></button>
          </span>
        </div>
        {listing && <div className="hint" title={listing.path}>{listing.path}</div>}
        <div className="scroll">
          {!ds && <div className="empty-note">Open an image to list the scans in its folder.</div>}
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
        </div>
      </div>
      <div className="sec">
        <div className="sec-h">Layers</div>
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

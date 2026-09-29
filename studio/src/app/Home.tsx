import { ArrowRight, Bookmark, Image as ImageIcon, Layers } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { api } from "../api/client";
import { fmtAgo, fmtInt } from "../lib/format";
import { type RecentItem, useActive, useStudio } from "../state/store";
import { openChannels, openImage, openSession } from "./actions";

function Preview({ item }: { item: RecentItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const key = item.paths.join("\n");
  useEffect(() => {
    const ctl = new AbortController();
    let made: string | null = null;
    const fetchPreview = item.kind === "session" ? api.sessionThumbnail(item.paths[0]!, ctl.signal)
      : api.thumbnail(item.kind === "channels" ? item.paths : item.paths[0]!, 480, ctl.signal);
    fetchPreview.then((blob) => setUrl((made = URL.createObjectURL(blob)))).catch(() => undefined);
    return () => {
      ctl.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [item.kind, key]);
  if (url) return <img src={url} alt="" />;
  return (
    <span className="placeholder">
      {item.kind === "channels" ? `${item.channels ?? item.paths.length} channels` : "Not cached yet"}
    </span>
  );
}

function RecentCard({ item, index }: { item: RecentItem; index: number }) {
  const open = () => {
    if (item.kind === "session") void openSession(item.paths[0]!);
    else if (item.kind === "channels") void openChannels(item.paths);
    else void openImage(item.paths[0]!);
  };
  const Icon = item.kind === "session" ? Bookmark : item.kind === "channels" ? Layers : ImageIcon;
  return (
    <button className="card" style={{ "--i": index } as CSSProperties} onClick={open} title={item.paths.join("\n")}>
      <div className="card-thumb"><Preview item={item} /></div>
      <div className="card-meta">
        <div className="card-name">
          <Icon />
          <span>{item.kind === "session" ? item.name : item.name.split("/").pop()}</span>
          {item.kind === "session" && <span className="badge">Session</span>}
        </div>
        <div className="card-sub">
          {item.width && item.height ? <span>{fmtInt(item.width)} × {fmtInt(item.height)}</span> : null}
          {item.channels ? <span>{item.channels} ch</span> : null}
          <span className="card-when">{fmtAgo(item.openedAt)}</span>
        </div>
      </div>
    </button>
  );
}

function Recent() {
  const recent = useStudio((s) => s.recent);
  return (
    <section>
      <div className="home-sec">
        <span className="caps">Recent</span>
        {recent.length > 0 && <span className="muted num">{recent.length}</span>}
      </div>
      {recent.length === 0 ? (
        <p className="home-empty">Scans and sessions you open appear here, with a preview once their pyramid is cached.</p>
      ) : (
        <div className="home-grid">
          {recent.map((item, i) => <RecentCard key={`${item.kind}:${item.paths.join("|")}`} item={item} index={i} />)}
        </div>
      )}
    </section>
  );
}

function InThisBrowser() {
  return (
    <section>
      <div className="home-sec"><span className="caps">In this browser</span></div>
      <p className="home-empty">
        Scans are read from this computer and never uploaded. Their zoom levels are kept in this browser, so a scan you
        have opened before opens at once.
      </p>
    </section>
  );
}

export function Home() {
  const ds = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  const setPage = useStudio((s) => s.setPage);
  return (
    <div className="home">
      <div className="home-inner">
        <header>
          <h1 className="home-mark">FluoroView<sup>4</sup></h1>
          <div className="home-rule" />
          <p className="caps home-tag">Full-resolution multiplex imaging</p>
        </header>
        <div className="home-actions">
          <button className="btn primary lg" onClick={() => setDialog("open")}>
            {api.inBrowser ? "Open image" : "Open image or session"} <span className="kbd">⌘O</span>
          </button>
          {ds && (
            <button className="btn lg" onClick={() => setPage("viewer")}>
              Return to {ds.name} <ArrowRight />
            </button>
          )}
        </div>
        {api.inBrowser ? <InThisBrowser /> : <Recent />}
        <footer className="home-f">
          <span><span className="kbd">⌘O</span> Open</span>
          {!api.inBrowser && <span><span className="kbd">⌘S</span> Save session</span>}
          <span><span className="kbd">⌘K</span> Commands</span>
          <span><span className="kbd">?</span> Shortcuts</span>
        </footer>
      </div>
    </div>
  );
}

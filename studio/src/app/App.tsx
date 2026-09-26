import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { api, openEvents } from "../api/client";
import type { EngineEvent } from "../api/types";
import { useActive, useStudio } from "../state/store";
import { Viewer } from "../viewer/Viewer";
import { loadHistograms } from "./actions";
import { CommandPalette, ShortcutsDialog } from "./CommandPalette";
import { handleShortcut } from "./commands";
import { Inspector } from "./Inspector";
import { OpenDialog } from "./OpenDialog";
import { ProjectPanel } from "./ProjectPanel";
import { ScanGallery } from "./ScanGallery";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";

function Welcome() {
  const setDialog = useStudio((s) => s.setDialog);
  return (
    <div className="welcome">
      <div className="welcome-box">
        <h2>Open a scan</h2>
        <p>
          FluoroView reads the file where it is. Uncompressed scans show full resolution at once; the zoom levels and
          exact histograms are built in one pass in the background.
        </p>
        <button className="btn primary" onClick={() => setDialog("open")}>Open image…</button>
        <span className="kbd" style={{ marginLeft: 8 }}>⌘O</span>
      </div>
    </div>
  );
}

export function App() {
  const ds = useActive();
  const dialog = useStudio((s) => s.dialog);
  const notice = useStudio((s) => s.notice);
  const page = useStudio((s) => s.page);
  const accent = useStudio((s) => s.accent);
  const setNotice = useStudio((s) => s.setNotice);
  const histogramAt = useRef<Record<string, number>>({});

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  useEffect(() => {
    const s = useStudio.getState();
    if (!api.hasToken()) {
      s.setNotice("This page has no access token. Open FluoroView from the link printed by the fluoroview command.");
      return;
    }
    api.datasets()
      .then((list) => {
        list.forEach((d) => s.upsertDataset(d));
        const last = list.at(-1);
        if (last) {
          s.setActive(last.id);
          list.forEach((d) => void loadHistograms(d.id));
        } else {
          s.setDialog("open");
        }
      })
      .catch((e: Error) => s.setNotice(e.message));

    const onEvent = (e: EngineEvent) => {
      switch (e.type) {
        case "hello":
          return;
        case "build": {
          s.updateBuild(e.id, e.build);
          const now = performance.now();
          if (e.build.state === "ready" || now - (histogramAt.current[e.id] ?? 0) > 750) {
            histogramAt.current[e.id] = now;
            void loadHistograms(e.id);
          }
          return;
        }
        default: {
          const unreachable: never = e;
          return unreachable;
        }
      }
    };
    return openEvents(onEvent, (connected) => useStudio.getState().setConnected(connected));
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  return (
    <div className="app">
      <TopBar />
      <ProjectPanel />
      <main className="canvas-area">
        {ds ? <Viewer key={ds.id} dataset={ds} /> : <Welcome />}
        {ds && page === "scans" && <ScanGallery />}
      </main>
      <Inspector />
      <StatusBar />
      {dialog === "open" && <OpenDialog />}
      {dialog === "palette" && <CommandPalette />}
      {dialog === "shortcuts" && <ShortcutsDialog />}
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button className="ib" onClick={() => setNotice(null)} title="Dismiss"><X /></button>
        </div>
      )}
    </div>
  );
}

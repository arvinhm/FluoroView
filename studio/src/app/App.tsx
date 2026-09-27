import { X } from "lucide-react";
import { type CSSProperties, useEffect, useRef } from "react";
import { api, openEvents } from "../api/client";
import type { EngineEvent } from "../api/types";
import { persistDisplays } from "../state/persist";
import { select, setLine, useProject } from "../state/project";
import { useActive, useStudio } from "../state/store";
import { PROFILE_DRAWER_CSS } from "../viewer/overlay";
import { Viewer } from "../viewer/Viewer";
import { loadHistograms } from "./actions";
import { CommandPalette, ShortcutsDialog } from "./CommandPalette";
import { handleShortcut } from "./commands";
import { EnlargeDialog } from "./EnlargeDialog";
import { ExportDialog } from "./ExportDialog";
import { Home } from "./Home";
import { Inspector } from "./Inspector";
import { OpenDialog } from "./OpenDialog";
import { ProfilePanel } from "./ProfilePanel";
import { ProjectPanel } from "./ProjectPanel";
import { SaveSessionDialog } from "./SaveSessionDialog";
import { ScanGallery } from "./ScanGallery";
import { SessionPrompt } from "./SessionPrompt";
import { SetScaleDialog } from "./SetScaleDialog";
import { SpecifyDialog } from "./SpecifyDialog";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";

export function App() {
  const ds = useActive();
  const dialog = useStudio((s) => s.dialog);
  const notice = useStudio((s) => s.notice);
  const page = useStudio((s) => s.page);
  const accent = useStudio((s) => s.accent);
  const setNotice = useStudio((s) => s.setNotice);
  const lineOnScan = useProject((s) => s.line !== null && s.line.dsId === ds?.id);
  const histogramAt = useRef<Record<string, number>>({});

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  useEffect(() => persistDisplays(), []);

  useEffect(() => {
    select(null);
    const line = useProject.getState().line;
    if (line && line.dsId !== ds?.id) setLine(line.dsId, null);
  }, [ds?.id]);

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
      <main className={`canvas-area${ds && lineOnScan ? " has-drawer" : ""}`}
        style={{ "--fv-drawer": `${PROFILE_DRAWER_CSS}px` } as CSSProperties}>
        {ds && <Viewer key={ds.id} dataset={ds} />}
        {ds && lineOnScan && <ProfilePanel ds={ds} />}
        {ds && page === "scans" && <ScanGallery />}
      </main>
      <Inspector />
      <StatusBar />
      {(page === "home" || !ds) && <Home />}
      {dialog === "open" && <OpenDialog />}
      {dialog === "palette" && <CommandPalette />}
      {dialog === "shortcuts" && <ShortcutsDialog />}
      {dialog === "export" && <ExportDialog />}
      {dialog === "save-session" && <SaveSessionDialog />}
      {dialog === "set-scale" && <SetScaleDialog />}
      {dialog === "enlarge" && <EnlargeDialog />}
      {dialog === "specify" && <SpecifyDialog />}
      <SessionPrompt />
      {notice && (
        <div className="toast" role="status">
          <span>{notice.text}</span>
          {notice.action && (
            <button className="btn" onClick={notice.action.run}>{notice.action.label}</button>
          )}
          <button className="ib" onClick={() => setNotice(null)} title="Dismiss"><X /></button>
        </div>
      )}
    </div>
  );
}

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Eye, Network, Sparkles, Circle, Database, Cpu, Download, Upload, FolderUp, Info, X, Radar } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";
import type { ViewKey } from "../../lib/types";
import { DATASETS, datasetById } from "../../lib/datasets";
import { readDataTransfer, type RawFile } from "../../lib/upload/detect";
import ErrorBoundary from "../ErrorBoundary";

const Viewer = lazy(() => import("./Viewer"));
const Analysis = lazy(() => import("./Analysis"));
const Spatial = lazy(() => import("./Spatial"));
const AIStudio = lazy(() => import("./AIStudio"));
const UploadDialog = lazy(() => import("./UploadDialog"));

const TABS: { key: ViewKey; label: string; icon: typeof Eye }[] = [
  { key: "viewer", label: "Viewer", icon: Eye },
  { key: "analysis", label: "Analysis", icon: Network },
  { key: "spatial", label: "Spatial", icon: Radar },
  { key: "ai", label: "AI Studio", icon: Sparkles },
];

export default function Studio() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const ensureData = useStore((s) => s.ensureData);
  const tissue = useStore((s) => s.tissue);
  const loading = useStore((s) => s.loading);
  const datasetId = useStore((s) => s.datasetId);
  const loadDataset = useStore((s) => s.loadDataset);
  const uploads = useStore((s) => s.uploads);
  const backend = useStore((s) => s.backendOnline);
  const exportSession = useStore((s) => s.exportSession);
  const importSession = useStore((s) => s.importSession);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pending, setPending] = useState<RawFile[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    ensureData();
  }, [ensureData]);

  const ready = !!tissue;

  // Dropping image files anywhere in the Studio opens the upload review dialog,
  // so users don't have to find a specific drop target first.
  const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes("Files");

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    dragDepth.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const raws = await readDataTransfer(e.dataTransfer);
    if (!raws.length) return;
    setPending(raws);
    setUploadOpen(true);
  }, []);

  const openUpload = () => {
    setPending(null);
    setUploadOpen(true);
  };

  const allDatasets = [...DATASETS, ...uploads];
  const resolveDataset = (id: string) => allDatasets.find((d) => d.id === id) ?? datasetById(id);

  const saveSession = () => {
    const blob = new Blob([JSON.stringify(exportSession(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "session.fluoroview.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast.success("Session saved", "session.fluoroview.json downloaded");
  };

  const loadSession = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      await importSession(data);
      toast.success("Session loaded", `${data.rois?.length ?? 0} ROI(s) restored`);
    } catch (e) {
      toast.error("Couldn't load session", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="relative mx-auto min-h-screen max-w-[1600px] px-3 pb-10 pt-24 sm:px-5"
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (hasFiles(e.dataTransfer)) e.preventDefault();
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="inline-flex items-center gap-1 rounded-2xl glass p-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              className={clsx(
                "relative inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition",
                view === t.key ? "text-white" : "text-white/55 hover:text-white"
              )}
            >
              {view === t.key && (
                <motion.span layoutId="studio-pill" className="absolute inset-0 rounded-xl bg-white/10 ring-1 ring-white/15" transition={{ type: "spring", stiffness: 400, damping: 32 }} />
              )}
              <t.icon className="relative h-4 w-4" />
              <span className="relative">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={openUpload}
            title="Upload your own images or a label mask"
            className="inline-flex items-center gap-1.5 rounded-full bg-cyan-400/20 px-3.5 py-1.5 font-bold text-cyan-50 ring-1 ring-cyan-300/45 transition hover:bg-cyan-400/30"
          >
            <FolderUp className="h-3.5 w-3.5" /> Upload data
          </button>
          <label className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1.5 text-white/60" title="Active dataset">
            <Database className="h-3.5 w-3.5 text-cyan-300" />
            <select
              value={datasetId}
              onChange={(e) => void loadDataset(resolveDataset(e.target.value))}
              className="max-w-[190px] cursor-pointer bg-transparent font-medium text-white/80 outline-none"
              aria-label="Select dataset"
            >
              <optgroup label="Bundled" className="bg-ink-800">
                {DATASETS.map((d) => (
                  <option key={d.id} value={d.id} className="bg-ink-800">
                    {d.short}
                  </option>
                ))}
              </optgroup>
              {uploads.length > 0 && (
                <optgroup label="Your uploads (this session)" className="bg-ink-800">
                  {uploads.map((d) => (
                    <option key={d.id} value={d.id} className="bg-ink-800">
                      {d.short}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <span className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1.5 text-white/60">
            <Circle className={clsx("h-2 w-2", tissue ? "fill-emerald-400 text-emerald-400" : "fill-amber-400 text-amber-400")} />
            {tissue ? `${tissue.cells.length.toLocaleString()} cells` : loading ? "loading…" : "—"}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1.5 text-white/60">
            <Cpu className="h-3.5 w-3.5 text-violet-300" />
            {backend === null ? "checking backend" : backend ? "backend online" : "on-device"}
          </span>
          <div className="inline-flex items-center gap-1 rounded-full glass p-1">
            <button onClick={saveSession} title="Save session (.fluoroview.json)" aria-label="Save session" className="grid h-7 w-7 place-items-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white">
              <Download className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => fileRef.current?.click()} title="Load session" aria-label="Load session" className="grid h-7 w-7 place-items-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white">
              <Upload className="h-3.5 w-3.5" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void loadSession(f);
                e.currentTarget.value = "";
              }}
            />
          </div>
        </div>
      </div>

      <DatasetNotes />

      {!ready ? (
        <Loader label={loading ? "Loading dataset…" : "Preparing…"} />
      ) : (
        <ErrorBoundary scope="Studio" key={`eb-${view}`}>
          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            >
              <Suspense fallback={<Loader label="Loading view…" />}>
                {view === "viewer" && <Viewer />}
                {view === "analysis" && <Analysis />}
                {view === "spatial" && <Spatial />}
                {view === "ai" && <AIStudio />}
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </ErrorBoundary>
      )}

      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-ink-950/70 backdrop-blur-sm"
          >
            <div className="rounded-3xl border-2 border-dashed border-cyan-300/60 bg-cyan-400/[0.06] px-10 py-8 text-center">
              <FolderUp className="mx-auto h-9 w-9 text-cyan-200" />
              <p className="mt-3 text-base font-bold text-white">Drop to open in FluoroView</p>
              <p className="mt-1 text-xs text-white/55">OME-TIFF · TIFF · PNG · JPEG · OME-Zarr folder · label mask</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {uploadOpen && (
        <Suspense fallback={null}>
          <UploadDialog open={uploadOpen} pending={pending} onClose={() => setUploadOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

/** Honest, dismissible summary of how the active dataset was loaded. */
function DatasetNotes() {
  const notes = useStore((s) => s.datasetNotes);
  const datasetId = useStore((s) => s.datasetId);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => setDismissed(null), [datasetId]);
  if (!notes.length || dismissed === datasetId) return null;
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-amber-300/25 bg-amber-400/[0.07] px-4 py-3">
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold text-amber-100">How this dataset was loaded</p>
        <ul className="mt-1 space-y-0.5">
          {notes.map((n, i) => (
            <li key={i} className="text-[11px] leading-relaxed text-amber-50/80">
              • {n}
            </li>
          ))}
        </ul>
      </div>
      <button onClick={() => setDismissed(datasetId)} className="rounded-lg p-1 text-amber-100/60 transition hover:bg-white/10 hover:text-white" aria-label="Dismiss notes">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Loader({ label }: { label: string }) {
  return (
    <div className="grid h-[60vh] place-items-center">
      <div className="text-center">
        <div className="relative mx-auto h-16 w-16">
          <span className="absolute inset-0 animate-spinslow rounded-full border-2 border-transparent border-t-cyan-400 border-r-violet-500" />
          <span className="absolute inset-2 animate-pulseglow rounded-full bg-gradient-to-br from-cyan-400/40 to-pink-500/40 blur-sm" />
        </div>
        <p className="mt-5 text-sm text-white/55">{label}</p>
      </div>
    </div>
  );
}

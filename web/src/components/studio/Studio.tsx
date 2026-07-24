import { lazy, Suspense, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Eye, Network, Sparkles, Circle, Database, Cpu } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import type { ViewKey } from "../../lib/types";
import ErrorBoundary from "../ErrorBoundary";

const Viewer = lazy(() => import("./Viewer"));
const Analysis = lazy(() => import("./Analysis"));
const AIStudio = lazy(() => import("./AIStudio"));

const TABS: { key: ViewKey; label: string; icon: typeof Eye }[] = [
  { key: "viewer", label: "Viewer", icon: Eye },
  { key: "analysis", label: "Analysis", icon: Network },
  { key: "ai", label: "AI Studio", icon: Sparkles },
];

export default function Studio() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const ensureData = useStore((s) => s.ensureData);
  const tissue = useStore((s) => s.tissue);
  const backend = useStore((s) => s.backendOnline);
  const [ready, setReady] = useState(!!tissue);

  useEffect(() => {
    if (tissue) {
      setReady(true);
      return;
    }
    const id = setTimeout(() => {
      ensureData();
      setReady(true);
    }, 40);
    return () => clearTimeout(id);
  }, [tissue, ensureData]);

  return (
    <div className="mx-auto min-h-screen max-w-[1600px] px-3 pb-10 pt-24 sm:px-5">
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

        <div className="flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1.5 text-white/60">
            <Database className="h-3.5 w-3.5 text-cyan-300" />
            Demo · tumor-immune margin
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1.5 text-white/60">
            <Circle className={clsx("h-2 w-2", tissue ? "fill-emerald-400 text-emerald-400" : "fill-amber-400 text-amber-400")} />
            {tissue ? `${tissue.cells.length.toLocaleString()} cells` : "loading…"}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1.5 text-white/60">
            <Cpu className="h-3.5 w-3.5 text-violet-300" />
            {backend === null ? "checking backend" : backend ? "backend online" : "on-device"}
          </span>
        </div>
      </div>

      {!ready ? (
        <Loader />
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
              <Suspense fallback={<Loader />}>
                {view === "viewer" && <Viewer />}
                {view === "analysis" && <Analysis />}
                {view === "ai" && <AIStudio />}
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </ErrorBoundary>
      )}
    </div>
  );
}

function Loader() {
  return (
    <div className="grid h-[60vh] place-items-center">
      <div className="text-center">
        <div className="relative mx-auto h-16 w-16">
          <span className="absolute inset-0 animate-spinslow rounded-full border-2 border-transparent border-t-cyan-400 border-r-violet-500" />
          <span className="absolute inset-2 animate-pulseglow rounded-full bg-gradient-to-br from-cyan-400/40 to-pink-500/40 blur-sm" />
        </div>
        <p className="mt-5 text-sm text-white/55">Preparing demo tissue &amp; channel maps…</p>
      </div>
    </div>
  );
}

import { lazy, Suspense, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Background from "./components/Background";
import Nav from "./components/Nav";
import Landing from "./components/Landing";
import ErrorBoundary from "./components/ErrorBoundary";
import Toaster from "./components/Toaster";
import AssistantChat from "./components/AssistantChat";
import { useStore } from "./lib/store";
import { useTheme } from "./lib/theme";
import { pingBackend } from "./lib/api";

// Code-split the Studio (WebGL viewer, analysis, AI) from the landing bundle.
const Studio = lazy(() => import("./components/studio/Studio"));

function StudioFallback() {
  return (
    <div className="grid min-h-screen place-items-center" role="status" aria-label="Loading studio">
      <span className="h-10 w-10 animate-spinslow rounded-full border-2 border-transparent border-t-cyan-400 border-r-violet-500" />
    </div>
  );
}

export default function App() {
  const view = useStore((s) => s.view);
  const setBackend = useStore((s) => s.setBackend);
  useTheme(); // apply persisted theme + accent to <html>

  useEffect(() => {
    pingBackend().then((ok) => setBackend(ok));
  }, [setBackend]);

  const isHome = view === "home";

  return (
    <>
      <a
        href="#main-content"
        className="sr-only left-4 top-4 z-[120] rounded-xl bg-cyan-400 px-4 py-2 text-sm font-bold text-ink-950 focus:not-sr-only focus:fixed"
      >
        Skip to content
      </a>
      <Background />
      <Nav />
      <ErrorBoundary>
        <AnimatePresence mode="wait">
          {isHome ? (
            <motion.main
              key="home"
              id="main-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
            >
              <Landing />
            </motion.main>
          ) : (
            <motion.main
              key="studio"
              id="main-content"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <Suspense fallback={<StudioFallback />}>
                <Studio />
              </Suspense>
            </motion.main>
          )}
        </AnimatePresence>
      </ErrorBoundary>
      <AssistantChat />
      <Toaster />
    </>
  );
}

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Background from "./components/Background";
import Nav from "./components/Nav";
import Landing from "./components/Landing";
import Studio from "./components/studio/Studio";
import { useStore } from "./lib/store";
import { pingBackend } from "./lib/api";

export default function App() {
  const view = useStore((s) => s.view);
  const setBackend = useStore((s) => s.setBackend);

  useEffect(() => {
    pingBackend().then((ok) => setBackend(ok));
  }, [setBackend]);

  const isHome = view === "home";

  return (
    <>
      <Background />
      <Nav />
      <AnimatePresence mode="wait">
        {isHome ? (
          <motion.main
            key="home"
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
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <Studio />
          </motion.main>
        )}
      </AnimatePresence>
    </>
  );
}

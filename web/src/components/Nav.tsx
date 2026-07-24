import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Microscope, Github, ArrowUpRight, Bot } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../lib/store";
import { useAssistant } from "./AssistantChat";
import ThemeMenu from "./ThemeMenu";
import type { ViewKey } from "../lib/types";

const LINKS: { key: ViewKey; label: string }[] = [
  { key: "home", label: "Overview" },
  { key: "viewer", label: "Viewer" },
  { key: "analysis", label: "Analysis" },
  { key: "ai", label: "AI Studio" },
];

export default function Nav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const toggleAssistant = useAssistant((s) => s.toggle);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.header
      initial={{ y: -70, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className={clsx(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled ? "py-2.5" : "py-4"
      )}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6">
        <button
          onClick={() => setView("home")}
          className={clsx(
            "flex items-center gap-2.5 rounded-2xl px-3 py-2 transition",
            scrolled && "glass"
          )}
        >
          <span className="relative grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 via-violet-500 to-pink-500 shadow-glow">
            <Microscope className="h-4 w-4 text-ink-950" strokeWidth={2.5} />
          </span>
          <span className="text-[15px] font-extrabold tracking-tight">
            Fluoro<span className="brand-text">View</span>
          </span>
          <span className="ml-1 rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-white/70">v3</span>
        </button>

        <nav className="hidden items-center gap-1 rounded-2xl glass px-1.5 py-1.5 md:flex">
          {LINKS.map((l) => (
            <button
              key={l.key}
              onClick={() => setView(l.key)}
              className={clsx(
                "relative rounded-xl px-3.5 py-1.5 text-sm font-medium transition",
                view === l.key ? "text-white" : "text-white/55 hover:text-white"
              )}
            >
              {view === l.key && (
                <motion.span
                  layoutId="nav-pill"
                  className="absolute inset-0 rounded-xl bg-white/10 ring-1 ring-white/15"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
              )}
              <span className="relative">{l.label}</span>
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <ThemeMenu />
          <button
            onClick={toggleAssistant}
            className="grid h-9 w-9 place-items-center rounded-xl glass text-white/70 transition hover:text-white"
            aria-label="Open AI assistant"
            title="AI assistant (bring your own key)"
          >
            <Bot className="h-4 w-4" />
          </button>
          <a
            href="https://github.com/arvinhm/FluoroView"
            target="_blank"
            rel="noreferrer"
            className="hidden h-9 w-9 place-items-center rounded-xl glass text-white/70 transition hover:text-white sm:grid"
            aria-label="GitHub repository"
          >
            <Github className="h-4 w-4" />
          </a>
          <button
            onClick={() => setView("viewer")}
            className="btn-primary group flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm"
          >
            Launch Studio
            <ArrowUpRight className="h-4 w-4 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </button>
        </div>
      </div>
    </motion.header>
  );
}

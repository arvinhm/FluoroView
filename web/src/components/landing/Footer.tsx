import { ArrowRight, Github, BookOpen, Microscope } from "lucide-react";
import { Reveal } from "../ui";
import { useStore } from "../../lib/store";

export default function Footer() {
  const setView = useStore((s) => s.setView);
  return (
    <footer className="relative mx-auto max-w-7xl px-4 pb-12 pt-10 sm:px-6">
      <Reveal>
        <div className="relative overflow-hidden rounded-[32px] glass-strong p-10 text-center sm:p-16">
          <div
            className="absolute inset-0 -z-10 opacity-30"
            style={{ background: "radial-gradient(circle at 50% 0%, #8b5cf6, transparent 60%)" }}
          />
          <h2 className="mx-auto max-w-2xl text-4xl font-black tracking-tight sm:text-5xl">
            Ready to explore your tissue in a{" "}
            <span className="brand-text">whole new dimension?</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-white/60">
            Launch the Studio right now with a built-in demo tissue — no upload, no signup, no setup.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <button
              onClick={() => setView("viewer")}
              className="btn-primary group inline-flex items-center gap-2 rounded-2xl px-7 py-3.5 text-[15px]"
            >
              Launch the Studio
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
            </button>
            <a
              href="https://github.com/arvinhm/FluoroView"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-2xl glass px-7 py-3.5 text-[15px] font-semibold text-white/85 hover:text-white"
            >
              <Github className="h-4 w-4" /> GitHub
            </a>
          </div>
        </div>
      </Reveal>

      <div className="mt-10 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 text-sm text-white/45 sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 via-violet-500 to-pink-500">
            <Microscope className="h-3.5 w-3.5 text-ink-950" strokeWidth={2.5} />
          </span>
          <span className="font-semibold text-white/70">FluoroView v3</span>
          <span>· BSD-3 · Haj-Mirzaian &amp; Heidari</span>
        </div>
        <div className="flex items-center gap-5">
          <a href="https://github.com/arvinhm/FluoroView" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-white">
            <Github className="h-4 w-4" /> Repository
          </a>
          <a href="https://github.com/arvinhm/FluoroView#readme" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-white">
            <BookOpen className="h-4 w-4" /> Docs
          </a>
        </div>
      </div>
    </footer>
  );
}

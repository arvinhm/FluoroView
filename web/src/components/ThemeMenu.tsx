import { useEffect, useRef, useState } from "react";
import { Palette, Sun, Moon, Check } from "lucide-react";
import { clsx } from "clsx";
import { useThemeStore, ACCENTS, type Accent } from "../lib/theme";

export default function ThemeMenu() {
  const mode = useThemeStore((s) => s.mode);
  const accent = useThemeStore((s) => s.accent);
  const setMode = useThemeStore((s) => s.setMode);
  const setAccent = useThemeStore((s) => s.setAccent);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="grid h-9 w-9 place-items-center rounded-xl glass text-white/70 transition hover:text-white"
        aria-label="Theme settings"
        title="Theme & accent"
      >
        <Palette className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-56 rounded-2xl glass-strong p-3 shadow-panel">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/50">Appearance</div>
          <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl glass p-1">
            <button
              onClick={() => setMode("dark")}
              className={clsx("inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold transition", mode === "dark" ? "bg-white/12 text-white" : "text-white/55 hover:text-white")}
            >
              <Moon className="h-3.5 w-3.5" /> Dark
            </button>
            <button
              onClick={() => setMode("light")}
              className={clsx("inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold transition", mode === "light" ? "bg-white/12 text-white" : "text-white/55 hover:text-white")}
            >
              <Sun className="h-3.5 w-3.5" /> Light
            </button>
          </div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/50">Accent</div>
          <div className="flex items-center gap-2">
            {(Object.keys(ACCENTS) as Accent[]).map((a) => (
              <button
                key={a}
                onClick={() => setAccent(a)}
                className="grid h-7 w-7 place-items-center rounded-full transition hover:scale-110"
                style={{ background: ACCENTS[a].hex, outline: accent === a ? "2px solid #fff" : "none", outlineOffset: "2px" }}
                aria-label={ACCENTS[a].label}
                title={ACCENTS[a].label}
              >
                {accent === a && <Check className="h-3.5 w-3.5 text-ink-950" strokeWidth={3} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

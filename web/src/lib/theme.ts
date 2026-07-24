import { useEffect } from "react";
import { create } from "zustand";

export type ThemeMode = "dark" | "light";
export type Accent = "cyan" | "violet" | "emerald" | "amber" | "rose";

export const ACCENTS: Record<Accent, { label: string; hex: string; hex2: string }> = {
  cyan: { label: "Cyan", hex: "#22d3ee", hex2: "#67e8f9" },
  violet: { label: "Violet", hex: "#8b5cf6", hex2: "#a78bfa" },
  emerald: { label: "Emerald", hex: "#34d399", hex2: "#6ee7b7" },
  amber: { label: "Amber", hex: "#fbbf24", hex2: "#fcd34d" },
  rose: { label: "Rose", hex: "#f43f5e", hex2: "#fb7185" },
};

const KEY = "fv.theme.v1";

interface Persisted {
  mode: ThemeMode;
  accent: Accent;
}

function load(): Persisted {
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<Persisted>;
        return {
          mode: p.mode === "light" ? "light" : "dark",
          accent: p.accent && p.accent in ACCENTS ? p.accent : "cyan",
        };
      }
    } catch {
      /* ignore */
    }
  }
  return { mode: "dark", accent: "cyan" };
}

function persist(p: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

interface ThemeState extends Persisted {
  setMode: (m: ThemeMode) => void;
  toggleMode: () => void;
  setAccent: (a: Accent) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const init = load();
  return {
    mode: init.mode,
    accent: init.accent,
    setMode: (mode) => {
      set({ mode });
      persist({ mode, accent: get().accent });
    },
    toggleMode: () => {
      const mode: ThemeMode = get().mode === "dark" ? "light" : "dark";
      set({ mode });
      persist({ mode, accent: get().accent });
    },
    setAccent: (accent) => {
      set({ accent });
      persist({ mode: get().mode, accent });
    },
  };
});

export function applyTheme(mode: ThemeMode, accent: Accent) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);
  root.classList.toggle("dark", mode === "dark");
  const a = ACCENTS[accent];
  root.style.setProperty("--accent", a.hex);
  root.style.setProperty("--accent-2", a.hex2);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", mode === "dark" ? "#05070d" : "#eef2f9");
}

/** Applies the persisted theme to <html> and keeps it in sync. */
export function useTheme() {
  const mode = useThemeStore((s) => s.mode);
  const accent = useThemeStore((s) => s.accent);
  useEffect(() => {
    applyTheme(mode, accent);
  }, [mode, accent]);
  return { mode, accent };
}

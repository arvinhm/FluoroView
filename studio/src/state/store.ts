import { create } from "zustand";
import type { BuildInfo, DatasetInfo, Histogram, SavedDisplay } from "../api/types";
import { autoWindow, dtypeMax } from "../lib/contrast";

export interface ChannelDisplay {
  visible: boolean;
  color: string;
  lo: number;
  hi: number;
  gamma: number;
  /** false until the user edits the window; auto-contrast may still be refined while false */
  touched: boolean;
}

export interface ViewReadout {
  scale: number;
  level: number;
  cssPxPerImagePx: number;
  /** visible image area x0, y0, x1, y1 in full-resolution pixels (may extend past the image) */
  box: [number, number, number, number];
}

export interface CursorReadout {
  x: number;
  y: number;
  values: (number | null)[];
  /** pointer position in CSS pixels, relative to the viewer */
  left: number;
  top: number;
}

export interface Options {
  smooth: boolean;
  grid: boolean;
  clip: boolean;
  minimap: boolean;
  /** composite plus one panel per visible channel, all showing the same view */
  gallery: boolean;
  histLog: boolean;
  /** magnified raw pixels and values around the cursor */
  loupe: boolean;
}

export type Dialog = "open" | "palette" | "shortcuts" | "export" | null;
export type Accent = "champagne" | "ice" | "white";
export type Page = "viewer" | "scans";
export type Tool = "move" | "rectangle" | "ellipse" | "polygon" | "freehand" | "line" | "note";

export interface Notice {
  text: string;
  action?: { label: string; run: () => void };
}

const ACCENT_KEY = "fluoroview.accent";

function storedAccent(): Accent {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(ACCENT_KEY) : null;
  return v === "ice" || v === "white" || v === "champagne" ? v : "champagne";
}

interface StudioState {
  datasets: Record<string, DatasetInfo>;
  order: string[];
  activeId: string | null;
  display: Record<string, ChannelDisplay[]>;
  /** true once the user has changed a dataset's display; only then is it saved to the project */
  displayEdited: Record<string, boolean>;
  histograms: Record<string, (Histogram | undefined)[]>;
  view: ViewReadout | null;
  cursor: CursorReadout | null;
  options: Options;
  tool: Tool;
  dialog: Dialog;
  accent: Accent;
  page: Page;
  connected: boolean;
  notice: Notice | null;

  upsertDataset: (ds: DatasetInfo) => void;
  setActive: (id: string) => void;
  updateBuild: (id: string, build: BuildInfo) => void;
  setChannel: (id: string, c: number, patch: Partial<ChannelDisplay>) => void;
  soloChannel: (id: string, c: number) => void;
  setHistogram: (id: string, c: number, h: Histogram) => void;
  autoContrast: (id: string, channels?: number[]) => void;
  applySavedDisplay: (id: string, saved: SavedDisplay[]) => void;
  setView: (v: ViewReadout) => void;
  setCursor: (c: CursorReadout | null) => void;
  setOption: <K extends keyof Options>(key: K, value: Options[K]) => void;
  setTool: (t: Tool) => void;
  setDialog: (d: Dialog) => void;
  setAccent: (a: Accent) => void;
  setPage: (p: Page) => void;
  setConnected: (v: boolean) => void;
  setNotice: (n: string | Notice | null) => void;
}

/** Transmitted-light channels start hidden when there is fluorescence: summed with it they wash the image out. */
function initialDisplay(ds: DatasetInfo): ChannelDisplay[] {
  const top = ds.saturation ?? dtypeMax(ds.dtype);
  const hasFluorescence = ds.channels.some((ch) => ch.kind === "fluorescence");
  return ds.channels.map((ch) => ({
    visible: !(hasFluorescence && ch.kind === "transmitted"),
    color: ch.color, lo: 0, hi: top, gamma: 1, touched: false,
  }));
}

export const useStudio = create<StudioState>((set, get) => ({
  datasets: {},
  order: [],
  activeId: null,
  display: {},
  displayEdited: {},
  histograms: {},
  view: null,
  cursor: null,
  options: { smooth: false, grid: true, clip: false, minimap: true, gallery: false, histLog: true, loupe: false },
  tool: "move",
  dialog: null,
  accent: storedAccent(),
  page: "viewer",
  connected: false,
  notice: null,

  upsertDataset: (ds) =>
    set((s) => ({
      datasets: { ...s.datasets, [ds.id]: ds },
      order: s.order.includes(ds.id) ? s.order : [...s.order, ds.id],
      display: s.display[ds.id] ? s.display : { ...s.display, [ds.id]: initialDisplay(ds) },
      histograms: s.histograms[ds.id] ? s.histograms : { ...s.histograms, [ds.id]: [] },
    })),

  setActive: (id) => set({ activeId: id, cursor: null, page: "viewer" }),

  updateBuild: (id, build) =>
    set((s) => {
      const ds = s.datasets[id];
      return ds ? { datasets: { ...s.datasets, [id]: { ...ds, build } } } : {};
    }),

  setChannel: (id, c, patch) =>
    set((s) => {
      const list = s.display[id];
      if (!list?.[c]) return {};
      const next = list.slice();
      const touched = "lo" in patch || "hi" in patch || "gamma" in patch;
      next[c] = { ...list[c], ...patch, touched: list[c].touched || touched };
      return { display: { ...s.display, [id]: next }, displayEdited: { ...s.displayEdited, [id]: true } };
    }),

  soloChannel: (id, c) =>
    set((s) => {
      const list = s.display[id];
      if (!list) return {};
      const alreadySolo = list.every((d, i) => d.visible === (i === c));
      return {
        display: { ...s.display, [id]: list.map((d, i) => ({ ...d, visible: alreadySolo || i === c })) },
        displayEdited: { ...s.displayEdited, [id]: true },
      };
    }),

  setHistogram: (id, c, h) => {
    set((s) => {
      const list = (s.histograms[id] ?? []).slice();
      list[c] = h;
      return { histograms: { ...s.histograms, [id]: list } };
    });
    const d = get().display[id]?.[c];
    if (d && !d.touched && h.total > 0) {
      const [lo, hi] = autoWindow(h);
      set((s) => {
        const list = s.display[id]!.slice();
        list[c] = { ...list[c]!, lo, hi };
        return { display: { ...s.display, [id]: list } };
      });
    }
  },

  autoContrast: (id, channels) =>
    set((s) => {
      const list = s.display[id];
      const hs = s.histograms[id] ?? [];
      if (!list) return {};
      return {
        display: {
          ...s.display,
          [id]: list.map((d, i) => {
            const h = hs[i];
            if (!h || (channels && !channels.includes(i))) return d;
            const [lo, hi] = autoWindow(h);
            return { ...d, lo, hi, gamma: 1, touched: false };
          }),
        },
        displayEdited: { ...s.displayEdited, [id]: true },
      };
    }),

  /** Saved windows replace the automatic ones; channels saved untouched keep following auto-contrast. */
  applySavedDisplay: (id, saved) =>
    set((s) => {
      const list = s.display[id];
      if (!list || saved.length !== list.length) return {};
      const hs = s.histograms[id] ?? [];
      return {
        display: {
          ...s.display,
          [id]: list.map((d, i) => {
            const v = saved[i]!;
            if (v.touched) return { visible: v.visible, color: v.color, lo: v.lo, hi: v.hi, gamma: v.gamma, touched: true };
            const h = hs[i];
            const [lo, hi] = h && h.total > 0 ? autoWindow(h) : [d.lo, d.hi];
            return { ...d, visible: v.visible, color: v.color, lo, hi };
          }),
        },
      };
    }),

  setView: (view) => set({ view }),
  setCursor: (cursor) => set({ cursor }),
  setOption: (key, value) => set((s) => ({ options: { ...s.options, [key]: value } })),
  setTool: (tool) => set({ tool }),
  setDialog: (dialog) => set({ dialog }),
  setAccent: (accent) => {
    localStorage.setItem(ACCENT_KEY, accent);
    set({ accent });
  },
  setPage: (page) => set({ page }),
  setConnected: (connected) => set({ connected }),
  setNotice: (notice) => set({ notice: typeof notice === "string" ? { text: notice } : notice }),
}));

export function useActive(): DatasetInfo | null {
  return useStudio((s) => (s.activeId ? s.datasets[s.activeId] ?? null : null));
}

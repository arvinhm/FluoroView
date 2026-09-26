import { create } from "zustand";
import type { BuildInfo, DatasetInfo, Histogram } from "../api/types";
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
}

export interface CursorReadout {
  x: number;
  y: number;
  values: (number | null)[];
}

export interface Options {
  smooth: boolean;
  grid: boolean;
  clip: boolean;
  minimap: boolean;
}

export type Dialog = "open" | "palette" | "shortcuts" | null;

interface StudioState {
  datasets: Record<string, DatasetInfo>;
  order: string[];
  activeId: string | null;
  display: Record<string, ChannelDisplay[]>;
  histograms: Record<string, (Histogram | undefined)[]>;
  view: ViewReadout | null;
  cursor: CursorReadout | null;
  options: Options;
  dialog: Dialog;
  connected: boolean;
  notice: string | null;

  upsertDataset: (ds: DatasetInfo) => void;
  setActive: (id: string) => void;
  updateBuild: (id: string, build: BuildInfo) => void;
  setChannel: (id: string, c: number, patch: Partial<ChannelDisplay>) => void;
  soloChannel: (id: string, c: number) => void;
  setHistogram: (id: string, c: number, h: Histogram) => void;
  autoContrast: (id: string, channels?: number[]) => void;
  setView: (v: ViewReadout) => void;
  setCursor: (c: CursorReadout | null) => void;
  setOption: <K extends keyof Options>(key: K, value: Options[K]) => void;
  setDialog: (d: Dialog) => void;
  setConnected: (v: boolean) => void;
  setNotice: (n: string | null) => void;
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
  histograms: {},
  view: null,
  cursor: null,
  options: { smooth: false, grid: true, clip: false, minimap: true },
  dialog: null,
  connected: false,
  notice: null,

  upsertDataset: (ds) =>
    set((s) => ({
      datasets: { ...s.datasets, [ds.id]: ds },
      order: s.order.includes(ds.id) ? s.order : [...s.order, ds.id],
      display: s.display[ds.id] ? s.display : { ...s.display, [ds.id]: initialDisplay(ds) },
      histograms: s.histograms[ds.id] ? s.histograms : { ...s.histograms, [ds.id]: [] },
    })),

  setActive: (id) => set({ activeId: id, cursor: null }),

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
      return { display: { ...s.display, [id]: next } };
    }),

  soloChannel: (id, c) =>
    set((s) => {
      const list = s.display[id];
      if (!list) return {};
      const alreadySolo = list.every((d, i) => d.visible === (i === c));
      return { display: { ...s.display, [id]: list.map((d, i) => ({ ...d, visible: alreadySolo || i === c })) } };
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
      };
    }),

  setView: (view) => set({ view }),
  setCursor: (cursor) => set({ cursor }),
  setOption: (key, value) => set((s) => ({ options: { ...s.options, [key]: value } })),
  setDialog: (dialog) => set({ dialog }),
  setConnected: (connected) => set({ connected }),
  setNotice: (notice) => set({ notice }),
}));

export function useActive(): DatasetInfo | null {
  return useStudio((s) => (s.activeId ? s.datasets[s.activeId] ?? null : null));
}

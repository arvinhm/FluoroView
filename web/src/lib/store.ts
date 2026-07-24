import { create } from "zustand";
import type { Cell, ChannelState, Roi, Tissue, ViewKey } from "./types";
import { buildChannelMaps, generateTissue, MARKERS, M, type ChannelMaps } from "./synth";
import { kmeans, markerMatrix, pca, standardize, summarizeClusters, umapEmbed, type ClusterSummary } from "./analysis";

interface Analysis {
  labels: number[]; // per-cell (all cells)
  k: number;
  summaries: ClusterSummary[];
  embedding: [number, number][]; // aligned to sampleIdx
  sampleIdx: number[];
}

interface AppState {
  view: ViewKey;
  tissue: Tissue | null;
  maps: ChannelMaps | null;
  channels: ChannelState[];
  rois: Roi[];
  analysis: Analysis | null;
  segmented: boolean;
  segMethod: string;
  backendOnline: boolean | null;
  hovered: number | null;

  setView: (v: ViewKey) => void;
  ensureData: () => void;
  toggleChannel: (i: number) => void;
  setGain: (i: number, g: number) => void;
  setGamma: (i: number, g: number) => void;
  soloChannel: (i: number) => void;
  presetChannels: (names: string[]) => void;
  addRoi: (r: Roi) => void;
  clearRois: () => void;
  runClustering: (k: number) => void;
  setSegmented: (v: boolean, method?: string) => void;
  setBackend: (v: boolean) => void;
  setHovered: (i: number | null) => void;
}

function defaultChannels(): ChannelState[] {
  return MARKERS.map((mk, i) => ({
    index: i,
    visible: mk.defaultOn,
    gain: 1.15,
    gamma: 0.9,
  }));
}

export const useStore = create<AppState>((set, get) => ({
  view: "home",
  tissue: null,
  maps: null,
  channels: defaultChannels(),
  rois: [],
  analysis: null,
  segmented: false,
  segMethod: "",
  backendOnline: null,
  hovered: null,

  setView: (v) => {
    set({ view: v });
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  },

  ensureData: () => {
    if (get().tissue) return;
    const tissue = generateTissue(4200, 7);
    const maps = buildChannelMaps(tissue, 1200);
    set({ tissue, maps });
  },

  toggleChannel: (i) =>
    set((s) => ({
      channels: s.channels.map((c) => (c.index === i ? { ...c, visible: !c.visible } : c)),
    })),

  setGain: (i, g) =>
    set((s) => ({ channels: s.channels.map((c) => (c.index === i ? { ...c, gain: g } : c)) })),

  setGamma: (i, g) =>
    set((s) => ({ channels: s.channels.map((c) => (c.index === i ? { ...c, gamma: g } : c)) })),

  soloChannel: (i) =>
    set((s) => ({ channels: s.channels.map((c) => ({ ...c, visible: c.index === i })) })),

  presetChannels: (names) => {
    const on = new Set(names);
    set((s) => ({
      channels: s.channels.map((c) => ({ ...c, visible: on.has(MARKERS[c.index].name) })),
    }));
  },

  addRoi: (r) => set((s) => ({ rois: [...s.rois, r] })),
  clearRois: () => set({ rois: [] }),

  runClustering: (k) => {
    const t = get().tissue;
    if (!t) return;
    // cluster ALL cells (fast) on PCA scores
    const X = standardize(markerMatrix(t.cells));
    const scores = pca(X, 6);
    const labels = kmeans(scores, k);
    t.cells.forEach((c, i) => (c.cluster = labels[i]));
    const summaries = summarizeClusters(t.cells, labels, k);

    // neighbor embedding on a representative subsample (kNN is O(n^2))
    const cap = 1200;
    const step = Math.max(1, Math.floor(t.cells.length / cap));
    const sampleIdx: number[] = [];
    for (let i = 0; i < t.cells.length; i += step) sampleIdx.push(i);
    const subScores = sampleIdx.map((i) => scores[i]);
    const embedding = umapEmbed(subScores, { neighbors: 14, iters: 180 });

    set({ analysis: { labels, k, summaries, embedding, sampleIdx } });
  },

  setSegmented: (v, method) => set({ segmented: v, segMethod: method ?? get().segMethod }),
  setBackend: (v) => set({ backendOnline: v }),
  setHovered: (i) => set({ hovered: i }),
}));

export { MARKERS, M };

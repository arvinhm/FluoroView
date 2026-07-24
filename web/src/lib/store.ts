import { create } from "zustand";
import type { CellTypeDef, ChannelDef, ChannelState, Roi, Tissue, ViewKey } from "./types";
import { buildChannelMaps, generateTissue, CELL_TYPES, MARKERS, M, type ChannelMaps } from "./synth";
import { kmeans, markerMatrix, pca, standardize, summarizeClusters, umapEmbed, type ClusterSummary } from "./analysis";
import { DEFAULT_DATASET, SYNTHETIC_DEMO, type DatasetDef } from "./datasets";
import { loadRealDataset } from "./loadReal";
import { toast } from "./toast";

interface Analysis {
  labels: number[]; // per-cell (all cells)
  k: number;
  summaries: ClusterSummary[];
  embedding: [number, number][]; // aligned to sampleIdx
  sampleIdx: number[];
}

interface AppState {
  view: ViewKey;
  datasetId: string;
  datasetLabel: string;
  activeChannels: ChannelDef[];
  cellTypes: CellTypeDef[] | null; // present for synthetic data only
  pixelSizeUm: number | null;
  tissue: Tissue | null;
  maps: ChannelMaps | null;
  channels: ChannelState[];
  rois: Roi[];
  analysis: Analysis | null;
  segmented: boolean;
  segMethod: string;
  backendOnline: boolean | null;
  hovered: number | null;
  loading: boolean;
  loadError: string | null;

  setView: (v: ViewKey) => void;
  loadDataset: (ds: DatasetDef) => Promise<void>;
  ensureData: () => void;
  toggleChannel: (i: number) => void;
  setGain: (i: number, g: number) => void;
  setGamma: (i: number, g: number) => void;
  soloChannel: (i: number) => void;
  showAllChannels: () => void;
  presetChannels: (names: string[]) => void;
  addRoi: (r: Roi) => void;
  updateRoi: (id: number, patch: Partial<Roi>) => void;
  removeRoi: (id: number) => void;
  clearRois: () => void;
  runClustering: (k: number) => void;
  setSegmented: (v: boolean, method?: string) => void;
  setBackend: (v: boolean) => void;
  setHovered: (i: number | null) => void;
  setPixelSizeUm: (um: number | null) => void;
}

function defaultChannels(chs: ChannelDef[]): ChannelState[] {
  return chs.map((c, i) => ({ index: i, visible: c.defaultOn, gain: 1.15, gamma: 0.9 }));
}

export const useStore = create<AppState>((set, get) => ({
  view: "home",
  datasetId: DEFAULT_DATASET.id,
  datasetLabel: DEFAULT_DATASET.label,
  activeChannels: DEFAULT_DATASET.channels,
  cellTypes: null,
  pixelSizeUm: DEFAULT_DATASET.pixelSizeUm,
  tissue: null,
  maps: null,
  channels: defaultChannels(DEFAULT_DATASET.channels),
  rois: [],
  analysis: null,
  segmented: false,
  segMethod: "",
  backendOnline: null,
  hovered: null,
  loading: false,
  loadError: null,

  setView: (v) => {
    set({ view: v });
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  },

  loadDataset: async (ds) => {
    set({ loading: true, loadError: null });
    try {
      if (ds.kind === "synthetic") {
        const tissue = generateTissue(4200, 7);
        const maps = buildChannelMaps(tissue, 1200);
        set({
          datasetId: ds.id,
          datasetLabel: ds.label,
          activeChannels: ds.channels,
          cellTypes: CELL_TYPES,
          pixelSizeUm: ds.pixelSizeUm,
          tissue,
          maps,
          channels: defaultChannels(ds.channels),
          rois: [],
          analysis: null,
          segmented: false,
          segMethod: "",
          loading: false,
        });
        return;
      }
      const { tissue, maps, channels } = await loadRealDataset(ds);
      set({
        datasetId: ds.id,
        datasetLabel: ds.label,
        activeChannels: channels,
        cellTypes: null,
        pixelSizeUm: ds.pixelSizeUm,
        tissue,
        maps,
        channels: defaultChannels(channels),
        rois: [],
        analysis: null,
        // cells.json IS a real segmentation mask, so the overlay is valid immediately.
        segmented: true,
        segMethod: "Imported mask (real)",
        loading: false,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("loadDataset failed:", e);
      set({ loading: false, loadError: msg });
      // Fall back to the fully offline synthetic demo so the app never dead-ends.
      if (ds.kind !== "synthetic") {
        toast.error("Couldn't load the real dataset", "Falling back to the synthetic demo.");
        await get().loadDataset(SYNTHETIC_DEMO);
      } else {
        toast.error("Failed to prepare demo data", msg);
      }
    }
  },

  ensureData: () => {
    if (get().tissue || get().loading) return;
    void get().loadDataset(DEFAULT_DATASET);
  },

  toggleChannel: (i) =>
    set((s) => ({
      channels: s.channels.map((c) => (c.index === i ? { ...c, visible: !c.visible } : c)),
    })),

  setGain: (i, g) => set((s) => ({ channels: s.channels.map((c) => (c.index === i ? { ...c, gain: g } : c)) })),

  setGamma: (i, g) => set((s) => ({ channels: s.channels.map((c) => (c.index === i ? { ...c, gamma: g } : c)) })),

  soloChannel: (i) => set((s) => ({ channels: s.channels.map((c) => ({ ...c, visible: c.index === i })) })),

  showAllChannels: () => set((s) => ({ channels: s.channels.map((c) => ({ ...c, visible: true })) })),

  presetChannels: (names) => {
    const on = new Set(names);
    set((s) => ({
      channels: s.channels.map((c) => ({ ...c, visible: on.has(s.activeChannels[c.index]?.name) })),
    }));
  },

  addRoi: (r) => set((s) => ({ rois: [...s.rois, r] })),
  updateRoi: (id, patch) => set((s) => ({ rois: s.rois.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  removeRoi: (id) => set((s) => ({ rois: s.rois.filter((r) => r.id !== id) })),
  clearRois: () => set({ rois: [] }),

  runClustering: (k) => {
    const t = get().tissue;
    if (!t) return;
    const names = get().activeChannels.map((c) => c.name);
    const X = standardize(markerMatrix(t.cells));
    const scores = pca(X, Math.min(6, Math.max(2, names.length - 1)));
    const labels = kmeans(scores, k);
    t.cells.forEach((c, i) => (c.cluster = labels[i]));
    const summaries = summarizeClusters(t.cells, labels, k, names);

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
  setPixelSizeUm: (um) => set({ pixelSizeUm: um }),
}));

export { MARKERS, M };

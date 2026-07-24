import { create } from "zustand";
import type { Cell, CellTypeDef, ChannelDef, ChannelState, Roi, Tissue, ViewKey } from "./types";
import { buildChannelMaps, generateTissue, CELL_TYPES, MARKERS, M, type ChannelMaps } from "./synth";
import { kmeans, markerMatrix, pca, standardize, summarizeClusters, umapEmbed, type ClusterSummary } from "./analysis";
import { DEFAULT_DATASET, SYNTHETIC_DEMO, datasetById, type DatasetDef } from "./datasets";
import { loadRealDataset } from "./loadReal";
import { toast } from "./toast";

interface Analysis {
  labels: number[]; // per-cell (all cells)
  k: number;
  summaries: ClusterSummary[];
  embedding: [number, number][]; // aligned to sampleIdx
  sampleIdx: number[];
}

export interface SessionData {
  version: string;
  datasetId: string;
  datasetLabel?: string;
  channels: ChannelState[];
  rois: Roi[];
  view: ViewKey;
  pixelSizeUm: number | null;
  segmented: boolean;
  segMethod: string;
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
  /** True cell-boundary overlay image for the active dataset (real data), else null. */
  boundaries: HTMLImageElement | null;
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
  selectedRoiId: number | null;
  addRoi: (r: Roi) => void;
  updateRoi: (id: number, patch: Partial<Roi>) => void;
  removeRoi: (id: number) => void;
  clearRois: () => void;
  selectRoi: (id: number | null) => void;
  addComment: (roiId: number, author: string, text: string) => void;
  addReply: (roiId: number, parentId: number, author: string, text: string) => void;
  removeComment: (roiId: number, commentId: number) => void;
  runClustering: (k: number) => void;
  setSegmented: (v: boolean, method?: string) => void;
  setCells: (cells: Cell[], method: string) => void;
  setBackend: (v: boolean) => void;
  setHovered: (i: number | null) => void;
  setPixelSizeUm: (um: number | null) => void;
  exportSession: () => SessionData;
  importSession: (data: SessionData) => Promise<void>;
}

function defaultChannels(chs: ChannelDef[]): ChannelState[] {
  return chs.map((c, i) => ({ index: i, visible: c.defaultOn, gain: 1.15, gamma: 0.9 }));
}

let idSeq = 0;
function genId(): number {
  idSeq += 1;
  return Date.now() * 1000 + (idSeq % 1000);
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
  boundaries: null,
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
          boundaries: null, // synthetic tissue is procedural — no label mask
          channels: defaultChannels(ds.channels),
          rois: [],
          selectedRoiId: null,
          analysis: null,
          segmented: false,
          segMethod: "",
          loading: false,
        });
        return;
      }
      const { tissue, maps, channels, boundaries } = await loadRealDataset(ds);
      set({
        datasetId: ds.id,
        datasetLabel: ds.label,
        activeChannels: channels,
        cellTypes: null,
        pixelSizeUm: ds.pixelSizeUm,
        tissue,
        maps,
        boundaries,
        channels: defaultChannels(channels),
        rois: [],
        selectedRoiId: null,
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

  selectedRoiId: null,
  addRoi: (r) => set((s) => ({ rois: [...s.rois, r], selectedRoiId: r.id })),
  updateRoi: (id, patch) => set((s) => ({ rois: s.rois.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  removeRoi: (id) => set((s) => ({ rois: s.rois.filter((r) => r.id !== id), selectedRoiId: s.selectedRoiId === id ? null : s.selectedRoiId })),
  clearRois: () => set({ rois: [], selectedRoiId: null }),
  selectRoi: (id) => set({ selectedRoiId: id }),

  addComment: (roiId, author, text) =>
    set((s) => ({
      rois: s.rois.map((r) =>
        r.id === roiId
          ? { ...r, comments: [...r.comments, { id: genId(), author, text, createdAt: Date.now(), replies: [] }] }
          : r
      ),
    })),
  addReply: (roiId, parentId, author, text) =>
    set((s) => ({
      rois: s.rois.map((r) =>
        r.id === roiId
          ? {
              ...r,
              comments: r.comments.map((c) =>
                c.id === parentId
                  ? { ...c, replies: [...c.replies, { id: genId(), author, text, createdAt: Date.now(), replies: [] }] }
                  : c
              ),
            }
          : r
      ),
    })),
  removeComment: (roiId, commentId) =>
    set((s) => ({
      rois: s.rois.map((r) =>
        r.id === roiId
          ? {
              ...r,
              comments: r.comments
                .filter((c) => c.id !== commentId)
                .map((c) => ({ ...c, replies: c.replies.filter((rp) => rp.id !== commentId) })),
            }
          : r
      ),
    })),

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
  setCells: (cells, method) =>
    set((s) => ({
      tissue: s.tissue ? { ...s.tissue, cells } : s.tissue,
      segmented: true,
      segMethod: method,
      analysis: null,
    })),
  setBackend: (v) => set({ backendOnline: v }),
  setHovered: (i) => set({ hovered: i }),
  setPixelSizeUm: (um) => set({ pixelSizeUm: um }),

  exportSession: () => {
    const s = get();
    return {
      version: "3.1",
      datasetId: s.datasetId,
      datasetLabel: s.datasetLabel,
      channels: s.channels,
      rois: s.rois,
      view: s.view,
      pixelSizeUm: s.pixelSizeUm,
      segmented: s.segmented,
      segMethod: s.segMethod,
    };
  },
  importSession: async (data) => {
    if (data.datasetId !== get().datasetId || !get().tissue) {
      await get().loadDataset(datasetById(data.datasetId));
    }
    set({
      channels: Array.isArray(data.channels) && data.channels.length ? data.channels : get().channels,
      rois: Array.isArray(data.rois) ? data.rois : [],
      selectedRoiId: null,
      pixelSizeUm: data.pixelSizeUm ?? get().pixelSizeUm,
      view: data.view ?? "viewer",
      segmented: data.segmented ?? get().segmented,
      segMethod: data.segMethod ?? get().segMethod,
    });
  },
}));

export { MARKERS, M };

import { create } from "zustand";
import type { BoundaryCell, Cell, CellTypeDef, ChannelDef, ChannelHistogram, ChannelPreset, ChannelState, Roi, ScanMeta, Tissue, ViewKey } from "./types";
import type { VivLoader } from "./vivSource";
import { buildChannelMaps, generateTissue, CELL_TYPES, MARKERS, M, type ChannelMaps } from "./synth";
import { kmeans, markerMatrix, pca, standardize, summarizeClusters, embedAllCells, type ClusterSummary } from "./analysis";
import { DEFAULT_DATASET, SYNTHETIC_DEMO, datasetById, type DatasetDef } from "./datasets";
import { loadRealDataset, type LoadedDataset } from "./loadReal";
import { binHistogram } from "./histogram";
import type { UploadedDataset } from "./upload/buildDataset";
import { getUploadDef, getUploadedDataset, registerUpload, releaseUpload, updateUploadedDataset } from "./upload/registry";
import { appearanceOf, applyAppearance, loadPresets, newPresetId, presetFromJson, savePresets } from "./presets";
import { computeContentExtent, fullExtent, type ContentExtent } from "./viewport";
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
  /** cluster index → user cell-type name (v3.3+) */
  clusterAnnotations?: Record<number, string>;
}

interface AppState {
  view: ViewKey;
  datasetId: string;
  datasetLabel: string;
  /** In-memory datasets the user uploaded this session (newest last). */
  uploads: DatasetDef[];
  /** Honest per-dataset load notes (downsampling, missing µm, mask caveats…). */
  datasetNotes: string[];
  activeChannels: ChannelDef[];
  cellTypes: CellTypeDef[] | null; // present for synthetic data only
  pixelSizeUm: number | null;
  tissue: Tissue | null;
  maps: ChannelMaps | null;
  /**
   * Where this dataset actually has signal (normalized to the image). Drives the
   * initial framing, the pan clamp and the "recenter on tissue" affordance, so a
   * thin strip of tissue in a big empty canvas can't be lost off screen.
   */
  contentExtent: ContentExtent;
  /** True cell-boundary overlay image for the active dataset (real data), else null. */
  boundaries: HTMLImageElement | null;
  /** Vector cell outlines (full-res mask) for the pyramid viewer, else null. */
  boundaryPolys: BoundaryCell[] | null;
  /** Viv multiscale pixel sources for the full-res pyramid image, else null. */
  imageSource: VivLoader | null;
  /** Sidecar metadata for the pyramid scan, else null. */
  scanMeta: ScanMeta | null;
  channels: ChannelState[];
  /** Per-channel histogram + auto-contrast suggestion (null until computed). */
  channelStats: (ChannelHistogram | null)[];
  /** User-saved appearance presets (persisted in localStorage). */
  presets: ChannelPreset[];
  activePresetId: string | null;
  /** cluster index → user cell-type name. */
  clusterAnnotations: Record<number, string>;
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
  /** Register an uploaded dataset, make it active and jump to the viewer. */
  addUpload: (up: UploadedDataset) => Promise<void>;
  removeUpload: (id: string) => Promise<void>;
  /** Attach cells + vector outlines derived from an uploaded label mask. */
  applyMask: (cells: Cell[], polys: BoundaryCell[], method: string, notes?: string[]) => void;
  ensureData: () => void;
  toggleChannel: (i: number) => void;
  setGain: (i: number, g: number) => void;
  setGamma: (i: number, g: number) => void;
  soloChannel: (i: number) => void;
  showAllChannels: () => void;
  presetChannels: (names: string[]) => void;
  /** Per-channel color-control actions (drive live Viv props). */
  setContrastLimits: (i: number, lo: number, hi: number) => void;
  setChannelColor: (i: number, hex: string) => void;
  setOpacity: (i: number, v: number) => void;
  autoContrast: (i: number) => void;
  autoContrastAll: () => void;
  resetChannel: (i: number) => void;
  setChannelStat: (i: number, hist: ChannelHistogram, applyAuto?: boolean) => void;
  savePreset: (name: string) => void;
  applyPreset: (id: string) => void;
  deletePreset: (id: string) => void;
  importPresetJson: (text: string) => boolean;
  renameCluster: (cluster: number, name: string) => void;
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

function defaultChannels(chs: ChannelDef[], scanMeta?: ScanMeta | null): ChannelState[] {
  return chs.map((c, i) => {
    const meta = scanMeta?.channels[i];
    const domain: [number, number] = meta?.domain ? [meta.domain[0], meta.domain[1]] : [0, 255];
    const cl: [number, number] = meta?.contrastLimits ? [meta.contrastLimits[0], meta.contrastLimits[1]] : [domain[0], domain[1]];
    return {
      index: i,
      visible: c.defaultOn,
      gain: 1,
      gamma: 1,
      color: meta?.color ?? c.color,
      contrastLimits: cl,
      domain,
      opacity: 1,
    };
  });
}

/** Clamp/order a candidate [lo,hi] contrast window into the channel domain. */
function clampWindow(lo: number, hi: number, domain: [number, number]): [number, number] {
  const [dlo, dhi] = domain;
  let a = Math.max(dlo, Math.min(dhi, lo));
  let b = Math.max(dlo, Math.min(dhi, hi));
  if (b < a) [a, b] = [b, a];
  if (b - a < 1e-6) b = Math.min(dhi, a + Math.max(1, (dhi - dlo) * 0.01));
  return [a, b];
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
  uploads: [],
  datasetNotes: [],
  activeChannels: DEFAULT_DATASET.channels,
  cellTypes: null,
  pixelSizeUm: DEFAULT_DATASET.pixelSizeUm,
  tissue: null,
  maps: null,
  contentExtent: fullExtent(),
  boundaries: null,
  boundaryPolys: null,
  imageSource: null,
  scanMeta: null,
  channels: defaultChannels(DEFAULT_DATASET.channels),
  channelStats: DEFAULT_DATASET.channels.map(() => null),
  presets: loadPresets(),
  activePresetId: null,
  clusterAnnotations: {},
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
        // Histograms + auto contrast straight from the in-memory intensity maps
        // (cheap, so the panel and initial look are data-driven immediately).
        const stats = maps.maps.map((m) => binHistogram(m, 128, [0, 255]));
        let channels = defaultChannels(ds.channels);
        channels = channels.map((c, i) => (stats[i] ? { ...c, contrastLimits: [stats[i].auto[0], stats[i].auto[1]] } : c));
        set({
          datasetId: ds.id,
          datasetLabel: ds.label,
          activeChannels: ds.channels,
          cellTypes: CELL_TYPES,
          pixelSizeUm: ds.pixelSizeUm,
          tissue,
          maps,
          contentExtent: computeContentExtent(maps),
          boundaries: null, // synthetic tissue is procedural — no label mask
          boundaryPolys: null,
          imageSource: null,
          scanMeta: null,
          channels,
          channelStats: stats,
          activePresetId: null,
          clusterAnnotations: {},
          rois: [],
          selectedRoiId: null,
          analysis: null,
          segmented: false,
          segMethod: "",
          datasetNotes: [],
          loading: false,
        });
        return;
      }
      let loaded: LoadedDataset;
      if (ds.kind === "upload") {
        const cached = getUploadedDataset(ds.id);
        if (!cached) throw new Error("That upload is no longer in memory (uploads last for the session only) — drop the files again.");
        loaded = cached;
      } else {
        loaded = await loadRealDataset(ds);
      }
      const { tissue, maps, channels, boundaries, boundaryPolys, imageSource, scanMeta } = loaded;
      set({
        datasetId: ds.id,
        datasetLabel: ds.label,
        activeChannels: channels,
        cellTypes: null,
        pixelSizeUm: scanMeta?.pixelSizeUm ?? ds.pixelSizeUm,
        tissue,
        maps,
        contentExtent: computeContentExtent(maps),
        boundaries,
        boundaryPolys,
        imageSource,
        scanMeta,
        channels: defaultChannels(channels, scanMeta),
        // Uploads measure their histograms while decoding; bundled scans fill
        // them asynchronously from the pyramid raster.
        channelStats: loaded.channelStats ?? channels.map(() => null),
        activePresetId: null,
        clusterAnnotations: {},
        rois: [],
        selectedRoiId: null,
        analysis: null,
        segmented: loaded.segmented ?? true,
        segMethod: loaded.segMethod ?? "Imported mask (real)",
        datasetNotes: loaded.notes ?? [],
        loading: false,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("loadDataset failed:", e);
      set({ loading: false, loadError: msg });
      if (ds.kind === "upload") {
        toast.error("Couldn't open that upload", msg);
        return;
      }
      // Fall back to the fully offline synthetic demo so the app never dead-ends.
      if (ds.kind !== "synthetic") {
        toast.error("Couldn't load the real dataset", "Falling back to the synthetic demo.");
        await get().loadDataset(SYNTHETIC_DEMO);
      } else {
        toast.error("Failed to prepare demo data", msg);
      }
    }
  },

  addUpload: async (up) => {
    registerUpload(up.def, up.loaded);
    set((s) => ({ uploads: [...s.uploads.filter((d) => d.id !== up.def.id), up.def] }));
    await get().loadDataset(up.def);
    set({ view: "viewer" });
  },

  removeUpload: async (id) => {
    releaseUpload(id);
    set((s) => ({ uploads: s.uploads.filter((d) => d.id !== id) }));
    if (get().datasetId === id) await get().loadDataset(DEFAULT_DATASET);
  },

  applyMask: (cells, polys, method, notes = []) => {
    const s = get();
    if (s.datasetId.startsWith("upload-") && s.tissue) {
      updateUploadedDataset(s.datasetId, {
        tissue: { ...s.tissue, cells },
        boundaryPolys: polys,
        segmented: true,
        segMethod: method,
      });
    }
    set({
      tissue: s.tissue ? { ...s.tissue, cells } : s.tissue,
      boundaryPolys: polys.length ? polys : s.boundaryPolys,
      boundaries: polys.length ? null : s.boundaries,
      segmented: true,
      segMethod: method,
      analysis: null,
      datasetNotes: [...s.datasetNotes, ...notes],
    });
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

  setContrastLimits: (i, lo, hi) =>
    set((s) => ({
      channels: s.channels.map((c) => (c.index === i ? { ...c, contrastLimits: clampWindow(lo, hi, c.domain) } : c)),
      activePresetId: null,
    })),

  setChannelColor: (i, hex) =>
    set((s) => ({ channels: s.channels.map((c) => (c.index === i ? { ...c, color: hex } : c)), activePresetId: null })),

  setOpacity: (i, v) =>
    set((s) => ({
      channels: s.channels.map((c) => (c.index === i ? { ...c, opacity: Math.max(0, Math.min(1, v)) } : c)),
      activePresetId: null,
    })),

  autoContrast: (i) =>
    set((s) => {
      const stat = s.channelStats[i];
      if (!stat) return {};
      return {
        channels: s.channels.map((c) => (c.index === i ? { ...c, contrastLimits: clampWindow(stat.auto[0], stat.auto[1], c.domain) } : c)),
        activePresetId: null,
      };
    }),

  autoContrastAll: () =>
    set((s) => ({
      channels: s.channels.map((c) => {
        const stat = s.channelStats[c.index];
        return stat ? { ...c, contrastLimits: clampWindow(stat.auto[0], stat.auto[1], c.domain) } : c;
      }),
      activePresetId: null,
    })),

  resetChannel: (i) =>
    set((s) => ({
      channels: s.channels.map((c) => (c.index === i ? { ...c, contrastLimits: [c.domain[0], c.domain[1]], gamma: 1, opacity: 1 } : c)),
      activePresetId: null,
    })),

  setChannelStat: (i, hist, applyAuto = false) =>
    set((s) => {
      const stats = s.channelStats.slice();
      stats[i] = hist;
      const channels = applyAuto
        ? s.channels.map((c) => (c.index === i ? { ...c, domain: [hist.domain[0], hist.domain[1]] as [number, number], contrastLimits: clampWindow(hist.auto[0], hist.auto[1], hist.domain) } : c))
        : s.channels;
      return { channelStats: stats, channels };
    }),

  savePreset: (name) => {
    const s = get();
    const preset: ChannelPreset = { id: newPresetId(), name, datasetId: s.datasetId, channels: appearanceOf(s.channels), createdAt: Date.now() };
    const next = [...s.presets.filter((p) => !(p.datasetId === preset.datasetId && p.name === preset.name)), preset];
    savePresets(next);
    set({ presets: next, activePresetId: preset.id });
  },

  applyPreset: (id) => {
    const p = get().presets.find((x) => x.id === id);
    if (!p) return;
    set((s) => ({ channels: applyAppearance(s.channels, p.channels), activePresetId: id }));
  },

  deletePreset: (id) => {
    const next = get().presets.filter((x) => x.id !== id);
    savePresets(next);
    set((s) => ({ presets: next, activePresetId: s.activePresetId === id ? null : s.activePresetId }));
  },

  importPresetJson: (text) => {
    const p = presetFromJson(text, get().datasetId);
    if (!p) return false;
    const next = [...get().presets, p];
    savePresets(next);
    set((s) => ({ presets: next, channels: applyAppearance(s.channels, p.channels), activePresetId: p.id }));
    return true;
  },

  renameCluster: (cluster, name) =>
    set((s) => {
      const next = { ...s.clusterAnnotations };
      const trimmed = name.trim();
      if (trimmed) next[cluster] = trimmed;
      else delete next[cluster];
      return { clusterAnnotations: next };
    }),

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
    // Uploads without a label mask have no cells; clustering needs at least k.
    if (t.cells.length < Math.max(2, k)) {
      toast.error("Not enough cells to cluster", t.cells.length ? `${t.cells.length} cell(s) available for k=${k}.` : "Upload a label mask (or run segmentation) first.");
      return;
    }
    const names = get().activeChannels.map((c) => c.name);
    const X = standardize(markerMatrix(t.cells));
    const scores = pca(X, Math.min(6, Math.max(2, names.length - 1)));
    const labels = kmeans(scores, k);
    t.cells.forEach((c, i) => (c.cluster = labels[i]));
    const summaries = summarizeClusters(t.cells, labels, k, names);

    // Embed EVERY cell: a genuine neighbor embedding on a landmark subset, then
    // out-of-sample projection of all remaining cells (see analysis.embedAllCells).
    // sampleIdx is the identity map so the scatter renders all ~N cells crisply.
    const embedding = embedAllCells(scores, { landmarks: 2600, neighbors: 14, iters: 200 });
    const sampleIdx = embedding.map((_, i) => i);

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
      version: "3.3",
      datasetId: s.datasetId,
      datasetLabel: s.datasetLabel,
      channels: s.channels,
      rois: s.rois,
      view: s.view,
      pixelSizeUm: s.pixelSizeUm,
      segmented: s.segmented,
      segMethod: s.segMethod,
      clusterAnnotations: s.clusterAnnotations,
    };
  },
  importSession: async (data) => {
    if (data.datasetId !== get().datasetId || !get().tissue) {
      // An upload id only resolves while its pixels are still in memory.
      const uploaded = getUploadDef(data.datasetId);
      if (!uploaded && data.datasetId.startsWith("upload-")) {
        toast.error("Session references an upload", "Drop the same files again, then load the session to restore its ROIs.");
      }
      await get().loadDataset(uploaded ?? datasetById(data.datasetId));
    }
    // Merge saved channel appearance onto fresh defaults so pre-v3.3 sessions
    // (which lack color/contrastLimits/domain/opacity) still restore cleanly.
    const base = get().channels;
    const merged = Array.isArray(data.channels) && data.channels.length
      ? base.map((c, i) => {
          const saved = data.channels[i] as Partial<ChannelState> | undefined;
          if (!saved) return c;
          return {
            ...c,
            visible: saved.visible ?? c.visible,
            gain: typeof saved.gain === "number" ? saved.gain : c.gain,
            gamma: typeof saved.gamma === "number" ? saved.gamma : c.gamma,
            color: saved.color ?? c.color,
            opacity: typeof saved.opacity === "number" ? saved.opacity : c.opacity,
            contrastLimits: Array.isArray(saved.contrastLimits) ? [saved.contrastLimits[0], saved.contrastLimits[1]] as [number, number] : c.contrastLimits,
            domain: Array.isArray(saved.domain) ? [saved.domain[0], saved.domain[1]] as [number, number] : c.domain,
          };
        })
      : base;
    set({
      channels: merged,
      rois: Array.isArray(data.rois) ? data.rois : [],
      selectedRoiId: null,
      pixelSizeUm: data.pixelSizeUm ?? get().pixelSizeUm,
      view: data.view ?? "viewer",
      segmented: data.segmented ?? get().segmented,
      segMethod: data.segMethod ?? get().segMethod,
      clusterAnnotations: data.clusterAnnotations && typeof data.clusterAnnotations === "object" ? data.clusterAnnotations : {},
    });
  },
}));

export { MARKERS, M };

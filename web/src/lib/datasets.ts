import type { ChannelDef } from "./types";
import { MARKERS } from "./synth";

export interface DatasetDef {
  id: string;
  label: string;
  short: string;
  kind: "real" | "synthetic";
  /** For real datasets: path (relative to the site base) that holds the PNGs + json. */
  basePath?: string;
  channels: ChannelDef[];
  /** Physical pixel size in microns, when known from metadata; null = unknown. */
  pixelSizeUm: number | null;
  nCells?: number;
  description: string;
}

// DEFAULT: the repo's REAL multiplex scan (BEMS340264 Scene-002), a 5-channel
// structural panel with a real 32,784-cell segmentation mask.
export const REAL_MULTIPLEX: DatasetDef = {
  id: "bems340264-scene002",
  label: "Real multiplex · BEMS340264 (structural)",
  short: "Real multiplex scan",
  kind: "real",
  basePath: "data/multiplex",
  pixelSizeUm: null, // physical pixel size is not provided in this dataset's metadata
  nCells: 32784,
  description:
    "Real multiplex immunofluorescence tissue scan — a 5-channel structural panel with a real 32,784-cell segmentation mask.",
  channels: [
    { name: "Nuclei", color: "#0050ff", kind: "nuclear", defaultOn: true },
    { name: "Membrane", color: "#ff00ff", kind: "membrane", defaultOn: true },
    { name: "ECM", color: "#00dc5a", kind: "cyto", defaultOn: true },
    { name: "Cytoplasm", color: "#00dcff", kind: "cyto", defaultOn: false },
    { name: "Nuclear membrane", color: "#ffbf00", kind: "membrane", defaultOn: false },
  ],
};

// Secondary: the procedurally generated 12-plex tumor–immune tissue.
export const SYNTHETIC_DEMO: DatasetDef = {
  id: "synthetic-io-12plex",
  label: "Synthetic demo · 12-plex IO panel",
  short: "Synthetic demo",
  kind: "synthetic",
  pixelSizeUm: 0.5, // nominal scale for the procedurally generated tissue
  nCells: 4200,
  description: "Procedurally generated 12-plex tumor–immune tissue for a fully offline demo.",
  channels: MARKERS.map((m) => ({ name: m.name, color: m.color, kind: m.kind, defaultOn: m.defaultOn })),
};

export const DATASETS: DatasetDef[] = [REAL_MULTIPLEX, SYNTHETIC_DEMO];
export const DEFAULT_DATASET = REAL_MULTIPLEX;

export function datasetById(id: string): DatasetDef {
  return DATASETS.find((d) => d.id === id) ?? DEFAULT_DATASET;
}

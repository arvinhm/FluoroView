export type MarkerKind = "nuclear" | "membrane" | "cyto";

export interface MarkerDef {
  name: string;
  /** hex color used as the fluorophore LUT */
  color: string;
  kind: MarkerKind;
  defaultOn: boolean;
}

/** A channel definition for an active dataset (real or synthetic). */
export type ChannelDef = MarkerDef;

export interface CellTypeDef {
  name: string;
  short: string;
  color: string;
  /** mean expression per marker index (aligned to MARKERS) */
  profile: number[];
}

export interface Cell {
  id: number;
  x: number;
  y: number;
  r: number;
  typeIndex: number;
  /** per-marker intensity in [0,1], aligned to MARKERS */
  markers: number[];
  /** assigned after clustering */
  cluster?: number;
  /** assigned after phenotyping */
  phenotype?: string;
  /**
   * Tissue compartment this cell sits in (index into the active compartment
   * list). Undefined means "unknown", which makes CoSMoS fall back to a global
   * permutation null instead of a compartment-stratified one.
   */
  compartmentIndex?: number;
}

export interface Tissue {
  width: number;
  height: number;
  cells: Cell[];
  seed: number;
}

export interface ChannelState {
  index: number;
  visible: boolean;
  /** Legacy linear gain — retained for session back-compat; superseded by contrastLimits. */
  gain: number;
  /** Per-channel gamma (both engines). 1 = identity, >1 brightens, <1 darkens. */
  gamma: number;
  /** Hex LUT color (defaults to the marker color, user-overridable via the picker). */
  color: string;
  /** Dual min/max mapping window in data units → Viv `contrastLimits`. */
  contrastLimits: [number, number];
  /** Slider bounds in data units (image dtype range / measured domain). */
  domain: [number, number];
  /** Per-channel opacity / additive blend weight, 0..1 (folded into the LUT color). */
  opacity: number;
}

/** Per-channel intensity histogram + auto-contrast suggestion for the panel. */
export interface ChannelHistogram {
  /** Bin counts (length = number of bins). */
  bins: number[];
  /** Measured [min, max] intensity range (slider bounds). */
  domain: [number, number];
  /** Percentile-stretch auto contrast window. */
  auto: [number, number];
  /** Largest bin count (for vertical scaling). */
  peak: number;
}

/** A saved snapshot of one channel's appearance (for presets / session). */
export interface ChannelAppearance {
  visible: boolean;
  color: string;
  contrastLimits: [number, number];
  gamma: number;
  opacity: number;
}

/** A named, dataset-scoped preset of the full channel appearance. */
export interface ChannelPreset {
  id: string;
  name: string;
  datasetId: string;
  channels: ChannelAppearance[];
  createdAt: number;
  builtin?: boolean;
}

export type ViewKey = "home" | "viewer" | "analysis" | "spatial" | "ai";

/** ROI geometry in image/tissue pixel coordinates. */
export type RoiShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "polygon"; points: [number, number][] };

export interface RoiComment {
  id: number;
  author: string;
  text: string;
  createdAt: number;
  replies: RoiComment[];
}

export interface Roi {
  id: number;
  label: string;
  color: string;
  shape: RoiShape;
  comments: RoiComment[];
}

/** Per-channel appearance/metadata baked by the pyramid generator. */
export interface ScanChannelMeta {
  name: string;
  color: string;
  domain: [number, number];
  contrastLimits: [number, number];
}

/** Sidecar metadata for a pyramidal OME-TIFF real scan (scan.meta.json). */
export interface ScanMeta {
  width: number;
  height: number;
  levels: number;
  bits: number;
  tile: number;
  pixelSizeUm: number | null;
  previewWidth: number;
  previewHeight: number;
  previewScale: number;
  channels: ScanChannelMeta[];
  image: string;
  boundaries: string;
}

/** One cell's outline as a vector polygon in full-resolution pixel coords. */
export interface BoundaryCell {
  id: number;
  /** closed ring [x,y] in image pixels (full resolution) */
  path: [number, number][];
}

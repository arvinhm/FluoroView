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
  gain: number; // 0..3
  gamma: number; // 0.3..2.5
}

export type ViewKey = "home" | "viewer" | "analysis" | "ai";

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

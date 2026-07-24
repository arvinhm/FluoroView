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

export interface Roi {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

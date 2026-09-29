import type { Blend, CurvePoint, Lut } from "../lib/lut";

export interface ChannelInfo {
  index: number;
  name: string;
  color: string;
  excitation_nm: number | null;
  emission_nm: number | null;
  kind: "fluorescence" | "transmitted";
}

export interface LevelInfo {
  index: number;
  width: number;
  height: number;
}

export type BuildState = "queued" | "building" | "ready" | "failed" | "cancelled";

export interface BuildInfo {
  state: BuildState;
  progress: number;
  rows_ready: number[];
  seconds: number | null;
  error: string | null;
  elapsed_s?: number;
}

export interface DatasetInfo {
  id: string;
  name: string;
  path: string;
  /** folder shown in the project list */
  folder: string;
  /** member files when channels come from separate files; empty for one file */
  files: string[];
  width: number;
  height: number;
  dtype: string;
  channels: ChannelInfo[];
  /** µm per pixel in use: the user's calibration (Set Scale) if set, else the file's */
  pixel_size_um: number | null;
  file_pixel_size_um: number | null;
  pixel_size_source: "user" | "file" | null;
  saturation: number | null;
  layout: string;
  vendor: string;
  acquisition: Record<string, string | number>;
  tile_size: number;
  levels: LevelInfo[];
  build: BuildInfo;
}

export interface Histogram {
  complete: boolean;
  total: number;
  counts: number[];
  range: [number, number];
  min: number;
  max: number;
  saturated: number;
  saturation: number | null;
  percentiles: Record<string, number>;
}

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number | null;
  mtime: number;
  cached?: boolean;
  /** a FluoroView session (.fv) */
  session?: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export type RegionShape = "rectangle" | "ellipse" | "polygon" | "freehand";
export type Point = [number, number];

export interface Region {
  id: string;
  name: string;
  shape: RegionShape;
  /** full-resolution pixel coordinates; two opposite corners for rectangles and ellipses */
  points: Point[];
  /** extra closed outlines of a polygon, combined even-odd with `points`: holes and further parts */
  rings?: Point[][];
  color: string;
  created: string;
  modified: string;
  author: string | null;
}

export interface ImportedRegions {
  regions: Region[];
  /** what the file held that is not a region (lines, points, text, detections…) and how many */
  skipped: Record<string, number>;
}

export type RegionCombine = "union" | "intersect" | "xor" | "subtract";
export type RegionOp = RegionCombine | "enlarge" | "hull" | "ellipse";

export interface RegionOpRequest {
  op: RegionOp;
  /** for subtract, the first region is the one the others are cut out of */
  ids: string[];
  /** enlarge by this much; negative shrinks */
  distance?: number;
  unit?: "px" | "um";
}

export interface Reply {
  id: string;
  text: string;
  author: string | null;
  created: string;
}

export interface Annotation {
  id: string;
  x: number;
  y: number;
  text: string;
  author: string | null;
  region_id: string | null;
  created: string;
  modified: string;
  replies: Reply[];
}

export interface SavedDisplay {
  visible: boolean;
  color: string;
  /** absent in settings saved before colour maps and curves existed */
  lut?: Lut;
  invert?: boolean;
  curve?: readonly CurvePoint[];
  intensity?: number;
  lo: number;
  hi: number;
  gamma: number;
  touched: boolean;
}

/** A Cell Counter category, such as CD8+. */
export interface Counter {
  id: string;
  name: string;
  color: string;
}

export interface CountPoint {
  id: string;
  x: number;
  y: number;
  counter: string;
}

export interface Project {
  regions: Region[];
  annotations: Annotation[];
  background_region: string | null;
  display: SavedDisplay[] | null;
  counters: Counter[];
  points: CountPoint[];
}

export interface ChannelStats {
  channel: string;
  n_pixels: number;
  mean: number | null;
  sd: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  sum: number;
  n_clipped: number;
  mode: number | null;
  skewness: number | null;
  /** excess kurtosis, as ImageJ reports it */
  kurtosis: number | null;
  /** calibrated area × mean (ImageJ IntDen); `sum` is RawIntDen */
  int_den: number | null;
}

export interface Measurement {
  region_id: string;
  region: string;
  shape: RegionShape;
  area_px: number;
  area_um2: number | null;
  centroid_x_px: number | null;
  centroid_y_px: number | null;
  perimeter_px: number | null;
  perimeter_um: number | null;
  circularity: number | null;
  aspect_ratio: number | null;
  roundness: number | null;
  solidity: number | null;
  feret_px: number | null;
  feret_um: number | null;
  min_feret_px: number | null;
  ellipse_major_px: number | null;
  ellipse_minor_px: number | null;
  ellipse_angle_deg: number | null;
  channels: ChannelStats[];
}

export interface Profile {
  level: number;
  samples: number;
  length_px: number;
  /** full-resolution position of each sample */
  x_px: number[];
  y_px: number[];
  distance_px: number[];
  distance_um: number[] | null;
  channels: { name: string; values: number[] }[];
}

export interface Patch {
  x0: number;
  y0: number;
  size: number;
  /** row-major raw values, one array per channel */
  channels: number[][];
}

export type Box = [number, number, number, number];

export interface FigureRequest {
  box: Box;
  display: Omit<SavedDisplay, "touched">[];
  blend: Blend;
  format: "png" | "tiff";
  scale_bar: boolean;
  labels: boolean;
  regions: boolean;
  notes: boolean;
  dpi: number;
}

export interface RawRequest {
  box: Box;
}

export interface ExportPlan {
  level: number;
  downsample: number;
  /** full-resolution area, clipped to the image */
  box: Box;
  panels: ("composite" | number)[];
  panel_width: number;
  panel_height: number;
  width: number;
  height: number;
}

export interface SessionView {
  cx: number;
  cy: number;
  /** CSS pixels per full-resolution pixel */
  zoom: number;
  gallery: boolean;
}

export interface SessionViewer {
  grid: boolean;
  smooth: boolean;
  clip: boolean;
  minimap: boolean;
  hist_log: boolean;
  /** absent in sessions saved before blend modes existed */
  blend?: Blend;
}

export interface SessionLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SessionSaveRequest {
  path: string;
  overwrite: boolean;
  display: SavedDisplay[];
  view: SessionView;
  viewer: SessionViewer;
  profile_line: SessionLine | null;
  export: Record<string, unknown> | null;
}

export interface SessionInfo {
  manifest: {
    format: string;
    version: number;
    software: string;
    created: string;
    image: { names: string[]; paths: string[]; width: number; height: number; channels: string[]; fingerprint: string };
  };
  regions: number;
  notes: number;
  /** where the image files are, or null when they were not found */
  image_paths: string[] | null;
}

export interface SessionApplied {
  project: Project;
  view: SessionView | null;
  viewer: SessionViewer | null;
  profile_line: SessionLine | null;
  export: Record<string, unknown> | null;
  fingerprint_ok: boolean;
  channels_match: boolean;
  backup: string | null;
}

export type EngineEvent =
  | { type: "hello"; version: string }
  | { type: "build"; id: string; build: BuildInfo };

export type TileResult =
  | { kind: "data"; data: Uint16Array | Uint8Array; width: number; height: number; final: boolean }
  | { kind: "pending" };

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
  pixel_size_um: number | null;
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
  color: string;
  created: string;
  modified: string;
  author: string | null;
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
  lo: number;
  hi: number;
  gamma: number;
  touched: boolean;
}

export interface Project {
  regions: Region[];
  annotations: Annotation[];
  background_region: string | null;
  display: SavedDisplay[] | null;
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
}

export interface Measurement {
  region_id: string;
  region: string;
  shape: RegionShape;
  area_px: number;
  area_um2: number | null;
  centroid_x_px: number | null;
  centroid_y_px: number | null;
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

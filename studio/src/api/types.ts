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
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export type EngineEvent =
  | { type: "hello"; version: string }
  | { type: "build"; id: string; build: BuildInfo };

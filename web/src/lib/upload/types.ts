import type { MarkerKind } from "../types";

export type UploadFileKind = "ome-tiff" | "tiff" | "png" | "jpeg" | "zarr" | "unsupported";

export type UploadRole = "channel" | "mask";

/** One file the user dropped, plus the (editable) intent we inferred for it. */
export interface StagedFile {
  id: string;
  file: File;
  /** path relative to the dropped folder, or just the filename */
  relPath: string;
  kind: UploadFileKind;
  role: UploadRole;
  /** channel name — inferred from the filename, user-editable */
  name: string;
  /** LUT color — inferred, user-editable */
  color: string;
  markerKind: MarkerKind;
  sizeBytes: number;
}

export type DetectedKind = "ome-tiff" | "images" | "ome-zarr-dir" | "needs-ingest" | "unsupported" | "empty";

export interface Detected {
  kind: DetectedKind;
  /** Channel-bearing files in display order (single item for `ome-tiff`). */
  files: StagedFile[];
  mask: StagedFile | null;
  /** For `ome-zarr-dir`: every member file keyed by its path below the group root. */
  zarrMembers?: Map<string, File>;
  zarrRoot?: string;
  warnings: string[];
  /** Set when `kind` is `unsupported` / `needs-ingest` — shown verbatim to the user. */
  message?: string;
}

/** One resolution level of an in-memory image (index 0 = highest resolution). */
export interface LevelData {
  width: number;
  height: number;
  /** one plane per channel, all the same dtype */
  planes: ArrayBufferView[];
}

/** Viv-supported dtypes we can produce from an upload. */
export type UploadDtype = "Uint8" | "Uint16" | "Uint32" | "Int8" | "Int16" | "Int32" | "Float32" | "Float64";

export interface ChannelStat {
  name: string;
  /** measured [min,max] over the coarse level */
  domain: [number, number];
  /** percentile auto-contrast window */
  auto: [number, number];
  /** histogram bin counts over `domain` */
  bins: number[];
  peak: number;
}

/** Result of decoding + pyramiding an uploaded image (worker payload). */
export interface DecodedImage {
  width: number;
  height: number;
  dtype: UploadDtype;
  tileSize: number;
  levels: LevelData[];
  channels: ChannelStat[];
  /** 8-bit preview planes normalised into each channel's domain */
  preview: { width: number; height: number; scale: number; planes: Uint8Array[] };
  /** >1 when the source was downsampled to fit the memory budget */
  downsampleFactor: number;
  notes: string[];
}

export interface MaskCell {
  id: number;
  /** centroid in world (image) pixels */
  x: number;
  y: number;
  /** area in world pixels² */
  area: number;
  /** per-channel mean intensity in [0,1] */
  markers: number[];
}

export interface MaskResult {
  cells: MaskCell[];
  /** flat contour rings in world pixels: [x,y,x,y,…] per cell, aligned to `cells` */
  rings: Float32Array[];
  labelCount: number;
  notes: string[];
}

export type UploadProgress = { phase: string; detail?: string; ratio: number };

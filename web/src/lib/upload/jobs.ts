import { binHistogram } from "../histogram";
import { decodeAny } from "./decode";
import { analyzeLabelMask } from "./labelMask";
import {
  allocPlane,
  bytesPerSample,
  buildLevels,
  downsampleBy,
  makePreview,
  measureDomain,
  planDownsample,
  type NumArray,
} from "./pyramid";
import type { ChannelStat, DecodedImage, LevelData, MaskResult, UploadDtype, UploadProgress } from "./types";

/** 384 MB of decoded pixels is a safe ceiling for a browser tab on a modest PC. */
export const DEFAULT_BUDGET_BYTES = 384 * 1024 * 1024;
export const DEFAULT_TILE_SIZE = 512;

export interface ChannelFileSpec {
  file: File;
  relPath: string;
  /** user-confirmed base name for the channel(s) this file yields */
  name: string;
}

export interface BuildImageInput {
  channels: ChannelFileSpec[];
  budgetBytes?: number;
  tileSize?: number;
}

export interface BuildImageOutput {
  image: DecodedImage;
  /** suggested LUTs from the source (RGB split), null where the caller decides */
  suggestedColors: (string | null)[];
  pixelSizeUm: number | null;
}

export interface MaskInput {
  file: File;
  relPath: string;
  /** world (image) pixel dimensions the outlines must land in */
  worldWidth: number;
  worldHeight: number;
  intensity?: { planes: NumArray[]; width: number; height: number; domains: [number, number][] };
  simplifyEps?: number;
}

export type ProgressFn = (p: UploadProgress) => void;

const DTYPE_RANK: Record<UploadDtype, number> = {
  Int8: 1,
  Uint8: 1,
  Int16: 2,
  Uint16: 2,
  Int32: 3,
  Uint32: 3,
  Float32: 4,
  Float64: 5,
};

const SIGNED: Record<UploadDtype, boolean> = {
  Int8: true,
  Int16: true,
  Int32: true,
  Uint8: false,
  Uint16: false,
  Uint32: false,
  Float32: true,
  Float64: true,
};

/** Widest dtype that can hold both inputs without rescaling values. */
export function promoteDtype(a: UploadDtype, b: UploadDtype): UploadDtype {
  if (a === b) return a;
  if (SIGNED[a] !== SIGNED[b]) return DTYPE_RANK[a] >= 4 || DTYPE_RANK[b] >= 4 ? "Float32" : "Float32";
  return DTYPE_RANK[a] >= DTYPE_RANK[b] ? a : b;
}

function convertPlane(src: NumArray, dtype: UploadDtype): NumArray {
  const out = allocPlane(dtype, src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

/**
 * Decode every uploaded channel file, merge them into one multi-channel image,
 * fit it inside the memory budget and build an in-browser pyramid so the viewer
 * streams tiles instead of holding one enormous texture.
 */
export async function buildImage(input: BuildImageInput, onProgress?: ProgressFn): Promise<BuildImageOutput> {
  const budget = input.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const tileSize = input.tileSize ?? DEFAULT_TILE_SIZE;
  if (!input.channels.length) throw new Error("No channel files to load");

  const notes: string[] = [];
  let width = 0;
  let height = 0;
  let dtype: UploadDtype | null = null;
  let pixelSizeUm: number | null = null;
  const planes: NumArray[] = [];
  const names: string[] = [];
  const suggestedColors: (string | null)[] = [];

  for (let i = 0; i < input.channels.length; i++) {
    const spec = input.channels[i];
    onProgress?.({ phase: "Decoding", detail: `${spec.relPath} (${i + 1}/${input.channels.length})`, ratio: (i / input.channels.length) * 0.55 });
    const decoded = await decodeAny(spec.file, spec.relPath, spec.name);
    if (!width) {
      width = decoded.width;
      height = decoded.height;
    } else if (decoded.width !== width || decoded.height !== height) {
      throw new Error(
        `Channel files must share pixel dimensions. "${input.channels[0].relPath}" is ${width}x${height} but "${spec.relPath}" is ${decoded.width}x${decoded.height}.`
      );
    }
    dtype = dtype ? promoteDtype(dtype, decoded.dtype) : decoded.dtype;
    if (pixelSizeUm == null && decoded.pixelSizeUm) pixelSizeUm = decoded.pixelSizeUm;
    decoded.planes.forEach((p, k) => {
      planes.push(p);
      names.push(decoded.names[k] ?? `${spec.name} ${k + 1}`);
      suggestedColors.push(decoded.colors[k] ?? null);
    });
    notes.push(...decoded.notes);
  }
  if (!dtype) throw new Error("Nothing decoded");
  if (!planes.length) throw new Error("No image planes decoded");

  // Widen any narrower planes so the whole source shares one dtype (Viv requirement).
  const unified = planes.map((p) => {
    const own = detectDtype(p);
    return own === dtype ? p : convertPlane(p, dtype!);
  });

  let level0: LevelData = { width, height, planes: unified as unknown as ArrayBufferView[] };
  const factor = planDownsample(width, height, unified.length, dtype, budget);
  let downsampleFactor = 1;
  if (factor > 1) {
    onProgress?.({ phase: "Fitting to memory", detail: `downsampling ${factor}x`, ratio: 0.6 });
    level0 = downsampleBy(unified, width, height, dtype, factor);
    downsampleFactor = factor;
    const mb = Math.round((width * height * unified.length * bytesPerSample(dtype)) / (1024 * 1024));
    notes.push(
      `Source is ${width.toLocaleString()}x${height.toLocaleString()} x${unified.length} (${mb} MB decoded) — displayed at 1/${factor} resolution to stay inside the browser memory budget. For full resolution, convert it to a pyramidal OME-TIFF or OME-Zarr with the ingest helper and drop that instead.`
    );
  }

  onProgress?.({ phase: "Building pyramid", detail: `${level0.width}x${level0.height}`, ratio: 0.68 });
  const levels = buildLevels(level0, dtype, tileSize);

  // Statistics come from the largest level under ~4 MP: exact for ordinary
  // images, and a faithful sample for big ones.
  const statLevel = levels.find((l) => l.width * l.height <= 4_000_000) ?? levels[levels.length - 1];
  onProgress?.({ phase: "Measuring channels", detail: `${levels.length} pyramid level${levels.length > 1 ? "s" : ""}`, ratio: 0.82 });
  const channels: ChannelStat[] = (statLevel.planes as unknown as NumArray[]).map((plane, c) => {
    const domain = measureDomain(plane, dtype!);
    const hist = binHistogram(plane, 128, domain);
    return { name: names[c] ?? `Channel ${c + 1}`, domain, auto: hist.auto, bins: hist.bins, peak: hist.peak };
  });

  const preview = makePreview(levels, dtype, channels.map((c) => c.domain), 2048);
  onProgress?.({ phase: "Ready", ratio: 1 });

  return {
    image: {
      width: level0.width,
      height: level0.height,
      dtype,
      tileSize,
      levels,
      channels,
      preview: { width: preview.width, height: preview.height, scale: preview.scale, planes: preview.planes },
      downsampleFactor,
      notes,
    },
    suggestedColors,
    pixelSizeUm,
  };
}

export interface BuildDatasetInput extends BuildImageInput {
  mask?: { file: File; relPath: string } | null;
}

export interface BuildDatasetOutput extends BuildImageOutput {
  mask: MaskResult | null;
}

/**
 * One heavy job: decode + pyramid the channels and, when a label mask came with
 * them, derive cells/outlines from it while the full-resolution planes are still
 * local (so per-cell means are exact rather than sampled from a preview).
 */
export async function buildDataset(input: BuildDatasetInput, onProgress?: ProgressFn): Promise<BuildDatasetOutput> {
  const built = await buildImage(input, onProgress ? (p) => onProgress({ ...p, ratio: p.ratio * (input.mask ? 0.6 : 1) }) : undefined);
  if (!input.mask) return { ...built, mask: null };
  const level0 = built.image.levels[0];
  const mask = await buildMask(
    {
      file: input.mask.file,
      relPath: input.mask.relPath,
      worldWidth: built.image.width,
      worldHeight: built.image.height,
      intensity: {
        planes: level0.planes as unknown as NumArray[],
        width: level0.width,
        height: level0.height,
        domains: built.image.channels.map((c) => c.domain),
      },
    },
    onProgress ? (p) => onProgress({ ...p, ratio: 0.6 + p.ratio * 0.4 }) : undefined
  );
  return { ...built, mask };
}

function detectDtype(arr: NumArray): UploadDtype {
  const v = arr as unknown as ArrayBufferView;
  if (v instanceof Uint8Array || v instanceof Uint8ClampedArray) return "Uint8";
  if (v instanceof Uint16Array) return "Uint16";
  if (v instanceof Uint32Array) return "Uint32";
  if (v instanceof Int8Array) return "Int8";
  if (v instanceof Int16Array) return "Int16";
  if (v instanceof Int32Array) return "Int32";
  if (v instanceof Float64Array) return "Float64";
  return "Float32";
}

/**
 * Decode a label mask and derive per-cell records + vector outlines in the
 * dataset's world pixel space.
 */
export async function buildMask(input: MaskInput, onProgress?: ProgressFn): Promise<MaskResult> {
  onProgress?.({ phase: "Decoding mask", detail: input.relPath, ratio: 0.05 });
  const decoded = await decodeAny(input.file, input.relPath, "Mask");
  const labels = decoded.planes[0];
  if (!labels) throw new Error("Mask file has no readable plane");
  if (decoded.dtype === "Float32" || decoded.dtype === "Float64") {
    onProgress?.({ phase: "Decoding mask", detail: "float labels rounded to integers", ratio: 0.08 });
  }
  const result = analyzeLabelMask(labels, decoded.width, decoded.height, {
    scaleX: input.worldWidth / decoded.width,
    scaleY: input.worldHeight / decoded.height,
    simplifyEps: input.simplifyEps ?? 0.75,
    intensity: input.intensity,
    onProgress: (ratio, detail) => onProgress?.({ phase: "Segmentation", detail, ratio: 0.1 + ratio * 0.9 }),
  });
  if (decoded.width !== input.worldWidth || decoded.height !== input.worldHeight) {
    result.notes.push(`Mask is ${decoded.width}x${decoded.height}; scaled to the image's ${input.worldWidth}x${input.worldHeight} pixel space.`);
  }
  if (decoded.dtype === "Uint8") {
    result.notes.push("8-bit mask: at most 255 distinct labels are representable. Use a 16/32-bit TIFF mask for more cells.");
  }
  return result;
}

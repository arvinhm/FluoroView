import { fromBlob } from "geotiff";
import type { UploadDtype } from "./types";
import type { NumArray } from "./pyramid";
import { RGB_CHANNEL_COLORS, RGB_CHANNEL_NAMES, cleanChannelName } from "./names";

export interface DecodedPlanes {
  width: number;
  height: number;
  dtype: UploadDtype;
  planes: NumArray[];
  /** one name per plane */
  names: string[];
  /** suggested LUT per plane, when the source implies one (RGB split) */
  colors: (string | null)[];
  /** µm per pixel when the file states it explicitly, else null */
  pixelSizeUm: number | null;
  notes: string[];
}

const MAX_PLANES_PER_FILE = 32;

function dtypeOf(arr: ArrayBufferView): UploadDtype {
  if (arr instanceof Uint8Array || arr instanceof Uint8ClampedArray) return "Uint8";
  if (arr instanceof Uint16Array) return "Uint16";
  if (arr instanceof Uint32Array) return "Uint32";
  if (arr instanceof Int8Array) return "Int8";
  if (arr instanceof Int16Array) return "Int16";
  if (arr instanceof Int32Array) return "Int32";
  if (arr instanceof Float32Array) return "Float32";
  if (arr instanceof Float64Array) return "Float64";
  throw new Error("Unsupported pixel type in file");
}

interface TiffDirectory {
  ImageDescription?: string;
  XResolution?: number[] | number;
  ResolutionUnit?: number;
  BitsPerSample?: number[];
}

/** µm/px from an OME-XML or ImageJ TIFF description — never guessed. */
export function pixelSizeFromDescription(desc: string | undefined, xResolution?: number, resolutionUnit?: number): number | null {
  if (desc) {
    const ome = /PhysicalSizeX\s*=\s*"([\d.eE+-]+)"/.exec(desc);
    if (ome) {
      const unit = /PhysicalSizeXUnit\s*=\s*"([^"]+)"/.exec(desc)?.[1] ?? "µm";
      const um = physicalToUm(Number(ome[1]), unit);
      if (um) return um;
    }
    // ImageJ writes `unit=micron` plus a spacing or relies on XResolution.
    const ij = /^\s*ImageJ=/m.test(desc) || /\bunit\s*=\s*(micron|um|µm)/i.test(desc);
    if (ij && /\bunit\s*=\s*(micron|um|µm)/i.test(desc) && xResolution && xResolution > 0) {
      return 1 / xResolution;
    }
  }
  // ResolutionUnit 2 = inch, 3 = cm.
  if (xResolution && xResolution > 0 && (resolutionUnit === 2 || resolutionUnit === 3)) {
    const perUnit = resolutionUnit === 2 ? 25400 : 10000; // µm per inch / per cm
    const um = perUnit / xResolution;
    // Reject implausible values (office scanners / defaulted tags).
    if (um > 0.005 && um < 1000) return um;
  }
  return null;
}

export function physicalToUm(size: number, unit: string): number | null {
  if (!Number.isFinite(size) || size <= 0) return null;
  switch (unit) {
    case "µm":
    case "um":
    case "micron":
      return size;
    case "nm":
      return size * 1e-3;
    case "mm":
      return size * 1e3;
    case "cm":
      return size * 1e4;
    case "m":
      return size * 1e6;
    case "Å":
      return size * 1e-4;
    default:
      return null; // "pixel" / "reference frame" / unknown → stay honest
  }
}

function rationalToNumber(v: number[] | number | undefined): number | undefined {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) {
    if (v.length >= 2 && v[1]) return v[0] / v[1];
    if (v.length === 1) return v[0];
  }
  return undefined;
}

/**
 * Decode a TIFF into one plane per channel with geotiff.js.
 *
 * Pages of identical size are treated as channels (ImageJ / OME channel stacks);
 * smaller pages are pyramid levels and are skipped. RGB pages split into three
 * additive planes so the per-channel controls apply to them too.
 */
export async function decodeTiff(file: File, base: string): Promise<DecodedPlanes> {
  const label = base;
  const tiff = await fromBlob(file);
  const count = await tiff.getImageCount();
  const first = await tiff.getImage(0);
  const width = first.getWidth();
  const height = first.getHeight();
  const dir = first.getFileDirectory() as TiffDirectory;
  const desc = typeof dir.ImageDescription === "string" ? dir.ImageDescription : undefined;
  const pixelSizeUm = pixelSizeFromDescription(desc, rationalToNumber(dir.XResolution), dir.ResolutionUnit);
  const notes: string[] = [];

  const pages: number[] = [0];
  for (let i = 1; i < Math.min(count, MAX_PLANES_PER_FILE); i++) {
    const img = await tiff.getImage(i);
    if (img.getWidth() === width && img.getHeight() === height) pages.push(i);
  }
  if (count > pages.length && pages.length > 1) notes.push(`${label}: used ${pages.length} equally-sized pages as channels (skipped ${count - pages.length} reduced-resolution pages).`);

  const planes: NumArray[] = [];
  const names: string[] = [];
  const colors: (string | null)[] = [];
  const omeNames = desc ? omeChannelNames(desc) : [];

  for (const p of pages) {
    const img = p === 0 ? first : await tiff.getImage(p);
    const samples = img.getSamplesPerPixel();
    const rasters = (await img.readRasters({ interleave: false })) as unknown as ArrayBufferView[];
    const arrs = Array.isArray(rasters) ? rasters : [rasters as ArrayBufferView];
    const usable = Math.min(samples, arrs.length, 4);
    if (usable >= 3) {
      for (let s = 0; s < 3; s++) {
        planes.push(arrs[s] as unknown as NumArray);
        names.push(pages.length > 1 ? `${base} ${RGB_CHANNEL_NAMES[s]}` : RGB_CHANNEL_NAMES[s]);
        colors.push(RGB_CHANNEL_COLORS[s]);
      }
      if (usable === 4) notes.push(`${label}: alpha channel ignored.`);
    } else {
      for (let s = 0; s < usable; s++) {
        planes.push(arrs[s] as unknown as NumArray);
        const idx = planes.length - 1;
        names.push(omeNames[idx] ?? (pages.length > 1 || usable > 1 ? `${base} ${idx + 1}` : base));
        colors.push(null);
      }
    }
    if (planes.length >= MAX_PLANES_PER_FILE) break;
  }
  if (!planes.length) throw new Error(`${label}: no readable image data`);
  const dtype = dtypeOf(planes[0] as unknown as ArrayBufferView);
  return { width, height, dtype, planes, names, colors, pixelSizeUm, notes };
}

function omeChannelNames(desc: string): string[] {
  if (!/<OME/i.test(desc)) return [];
  const out: string[] = [];
  const re = /<Channel\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(desc))) {
    const name = /Name\s*=\s*"([^"]*)"/.exec(m[0])?.[1];
    out.push(name && name.trim() ? name.trim() : `Channel ${out.length + 1}`);
  }
  return out;
}

interface Ctx2D {
  drawImage(img: ImageBitmap, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): ImageData;
}

function makeCanvasCtx(width: number, height: number): Ctx2D {
  if (typeof OffscreenCanvas !== "undefined") {
    const cv = new OffscreenCanvas(width, height);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
    return ctx as unknown as Ctx2D;
  }
  if (typeof document === "undefined") throw new Error("No canvas available to decode this image");
  const cv = document.createElement("canvas");
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  return ctx as unknown as Ctx2D;
}

/**
 * Decode PNG / JPEG through the browser's own image pipeline. Grayscale files
 * become one channel; color files split into R/G/B planes so additive blending
 * reproduces the original while still exposing per-channel controls.
 */
export async function decodeBitmap(file: File, base: string): Promise<DecodedPlanes> {
  const label = base;
  if (typeof createImageBitmap !== "function") throw new Error("This browser cannot decode PNG/JPEG off-thread");
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch (e) {
    throw new Error(`${label}: not a readable PNG/JPEG (${e instanceof Error ? e.message : String(e)})`);
  }
  const width = bmp.width;
  const height = bmp.height;
  if (!width || !height) throw new Error(`${label}: image has no pixels`);
  const ctx = makeCanvasCtx(width, height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const n = width * height;

  let gray = true;
  const step = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    if (rgba[o] !== rgba[o + 1] || rgba[o + 1] !== rgba[o + 2]) {
      gray = false;
      break;
    }
  }
  if (gray) {
    const plane = new Uint8Array(n);
    for (let i = 0; i < n; i++) plane[i] = rgba[i * 4];
    return { width, height, dtype: "Uint8", planes: [plane], names: [base], colors: [null], pixelSizeUm: null, notes: [] };
  }
  const r = new Uint8Array(n);
  const g = new Uint8Array(n);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    r[i] = rgba[o];
    g[i] = rgba[o + 1];
    b[i] = rgba[o + 2];
  }
  return {
    width,
    height,
    dtype: "Uint8",
    planes: [r, g, b],
    names: RGB_CHANNEL_NAMES.map((c) => `${base} ${c}`),
    colors: RGB_CHANNEL_COLORS.slice(),
    pixelSizeUm: null,
    notes: ["Color image split into additive Red/Green/Blue channels (8-bit)."],
  };
}

/** Decode any supported single file into planes. `base` names the channel(s). */
export async function decodeAny(file: File, relPath: string, base = cleanChannelName(relPath)): Promise<DecodedPlanes> {
  const name = relPath.toLowerCase();
  if (/\.tiff?$/.test(name)) return decodeTiff(file, base);
  if (/\.(png|jpe?g)$/.test(name)) return decodeBitmap(file, base);
  // Unknown extension: try TIFF magic first, then the bitmap decoder.
  try {
    return await decodeTiff(file, base);
  } catch {
    return decodeBitmap(file, base);
  }
}

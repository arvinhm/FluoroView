import type { LevelData, UploadDtype } from "./types";

type Ctor = new (length: number) => ArrayBufferView & { [i: number]: number; length: number };

const CTORS: Record<UploadDtype, Ctor> = {
  Uint8: Uint8Array,
  Uint16: Uint16Array,
  Uint32: Uint32Array,
  Int8: Int8Array,
  Int16: Int16Array,
  Int32: Int32Array,
  Float32: Float32Array,
  Float64: Float64Array,
};

const BYTES: Record<UploadDtype, number> = {
  Uint8: 1,
  Uint16: 2,
  Uint32: 4,
  Int8: 1,
  Int16: 2,
  Int32: 4,
  Float32: 4,
  Float64: 8,
};

export function bytesPerSample(dtype: UploadDtype): number {
  return BYTES[dtype];
}

export function allocPlane(dtype: UploadDtype, length: number): NumArray {
  return new CTORS[dtype](length) as unknown as NumArray;
}

/** Full data range of a dtype — the honest slider bound when nothing is measured. */
export function dtypeRange(dtype: UploadDtype): [number, number] {
  switch (dtype) {
    case "Uint8":
      return [0, 255];
    case "Uint16":
      return [0, 65535];
    case "Uint32":
      return [0, 4294967295];
    case "Int8":
      return [-128, 127];
    case "Int16":
      return [-32768, 32767];
    case "Int32":
      return [-2147483648, 2147483647];
    case "Float32":
    case "Float64":
      return [0, 1];
    default: {
      const never: never = dtype;
      throw new Error(`Unhandled dtype ${String(never)}`);
    }
  }
}

export interface NumArray {
  readonly length: number;
  [index: number]: number;
}

/** Box-average an image plane down by 2 in each axis (odd sizes clamp). */
export function downsample2x(src: NumArray, w: number, h: number, dtype: UploadDtype): { data: NumArray; width: number; height: number } {
  const nw = Math.max(1, Math.floor(w / 2));
  const nh = Math.max(1, Math.floor(h / 2));
  const out = allocPlane(dtype, nw * nh);
  const integral = dtype !== "Float32" && dtype !== "Float64";
  for (let y = 0; y < nh; y++) {
    const y0 = y * 2;
    const y1 = Math.min(h - 1, y0 + 1);
    const r0 = y0 * w;
    const r1 = y1 * w;
    for (let x = 0; x < nw; x++) {
      const x0 = x * 2;
      const x1 = Math.min(w - 1, x0 + 1);
      const sum = src[r0 + x0] + src[r0 + x1] + src[r1 + x0] + src[r1 + x1];
      out[y * nw + x] = integral ? Math.round(sum / 4) : sum / 4;
    }
  }
  return { data: out, width: nw, height: nh };
}

/**
 * Power-of-two downsample factor that keeps `nChannels` full-resolution planes
 * inside `budgetBytes`. Returns 1 when the image already fits.
 */
export function planDownsample(width: number, height: number, nChannels: number, dtype: UploadDtype, budgetBytes: number): number {
  const bytes = bytesPerSample(dtype) * Math.max(1, nChannels);
  let factor = 1;
  // Pyramid levels above level 0 add ~1/3; keep that inside the budget too.
  while ((width / factor) * (height / factor) * bytes * 1.34 > budgetBytes && factor < 64) factor *= 2;
  return factor;
}

export function downsampleBy(planes: NumArray[], width: number, height: number, dtype: UploadDtype, factor: number): LevelData {
  let cur = planes;
  let w = width;
  let h = height;
  let f = factor;
  while (f > 1) {
    const next: NumArray[] = [];
    let nw = w;
    let nh = h;
    for (const p of cur) {
      const d = downsample2x(p, w, h, dtype);
      next.push(d.data);
      nw = d.width;
      nh = d.height;
    }
    cur = next;
    w = nw;
    h = nh;
    f /= 2;
  }
  return { width: w, height: h, planes: cur as unknown as ArrayBufferView[] };
}

/**
 * Build an in-browser pyramid down to `tileSize`, so a large flat image still
 * renders through Viv's tiled multiscale path instead of one giant texture.
 */
export function buildLevels(level0: LevelData, dtype: UploadDtype, tileSize = 512, maxLevels = 12): LevelData[] {
  const levels: LevelData[] = [level0];
  let cur = level0;
  while (levels.length < maxLevels && (cur.width > tileSize || cur.height > tileSize)) {
    const planes: NumArray[] = [];
    let nw = cur.width;
    let nh = cur.height;
    for (const p of cur.planes as unknown as NumArray[]) {
      const d = downsample2x(p, cur.width, cur.height, dtype);
      planes.push(d.data);
      nw = d.width;
      nh = d.height;
    }
    cur = { width: nw, height: nh, planes: planes as unknown as ArrayBufferView[] };
    levels.push(cur);
    if (nw <= 1 || nh <= 1) break;
  }
  return levels;
}

/** Measured [min,max] of a plane, guarded so a flat image never yields lo===hi. */
export function measureDomain(data: NumArray, dtype: UploadDtype): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    const r = dtypeRange(dtype);
    return [r[0], r[1]];
  }
  if (max <= min) max = min + 1;
  return [min, max];
}

/**
 * 8-bit preview planes normalised into each channel's domain. The rest of the
 * app (minimap thumbnail, ROI `.zip` crops) reads `value/255` as the channel's
 * position inside `domain`, so normalising here keeps those consistent with the
 * live GPU render for any bit depth.
 */
export function makePreview(
  levels: LevelData[],
  dtype: UploadDtype,
  domains: [number, number][],
  maxWidth = 2048
): { width: number; height: number; scale: number; planes: Uint8Array[] } {
  const full = levels[0];
  let pick = levels[0];
  for (const lv of levels) {
    pick = lv;
    if (lv.width <= maxWidth) break;
  }
  const { width, height } = pick;
  const planes = (pick.planes as unknown as NumArray[]).map((src, c) => {
    const [lo, hi] = domains[c] ?? measureDomain(src, dtype);
    const range = hi - lo || 1;
    const out = new Uint8Array(width * height);
    for (let i = 0; i < out.length; i++) {
      const t = (src[i] - lo) / range;
      out[i] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
    }
    return out;
  });
  return { width, height, scale: width / full.width, planes };
}

import type { ChannelMaps } from "./synth";
import { fitRect, type ViewTransform } from "./compositor";

/**
 * Where a dataset actually has signal, and how to keep it on screen.
 *
 * A whole-slide scan is usually a small piece of tissue inside a much larger,
 * empty canvas — the bundled multiplex scan is a thin diagonal strip that leaves
 * ~75% of its 8500x5625 frame black. Framing (and clamping) against the raw
 * image bounds therefore lets a viewport wander into pure background, which
 * looks exactly like a broken/empty image. Everything here is expressed in
 * NORMALIZED image coordinates (0..1) so the same extent serves the full-res
 * pyramid viewer (world = native pixels) and the compositor viewer (world =
 * preview-array pixels).
 */
export interface ContentExtent {
  /** Bounding box of the signal, normalized to the image. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Coarse occupancy grid over the whole image; 1 = this bin holds signal. */
  cols: number;
  rows: number;
  occupied: Uint8Array;
  /** Fraction of bins holding signal. */
  coverage: number;
  /**
   * True when signal could not be separated from background (bright-field/H&E,
   * where the background is bright, or genuinely full-frame signal). Callers
   * then behave exactly as if the whole image were content.
   */
  full: boolean;
}

export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

/** Normalized rectangle (0..1 of the image). */
export interface NormRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Extent that treats the entire image as content (the safe fallback). */
export function fullExtent(): ContentExtent {
  return { x0: 0, y0: 0, x1: 1, y1: 1, cols: 1, rows: 1, occupied: new Uint8Array([1]), coverage: 1, full: true };
}

/**
 * Derive the content extent from the bounded preview intensity maps, which every
 * dataset carries (bundled scans, uploads and the synthetic demo alike).
 *
 * A pixel counts as signal when ANY channel exceeds `threshold` (8/255 by
 * default — above sensor noise, below any real stain). A bin counts as occupied
 * when at least `binFill` of its sampled pixels are signal AND at least
 * `minHits` of them are, so a couple of hot pixels can't fake tissue while
 * genuinely sparse tissue still registers. When signal ends up nearly everywhere
 * we return `fullExtent()` rather than pretend to know better.
 */
export function computeContentExtent(
  maps: ChannelMaps | null,
  { threshold = 8, binFill = 0.004, minHits = 4, cols = 64, stride = 2, fullAbove = 0.9 } = {}
): ContentExtent {
  if (!maps || !maps.maps.length || maps.width < 2 || maps.height < 2) return fullExtent();
  const { width: w, height: h } = maps;
  const gx = clamp(cols, 8, 128);
  const gy = clamp(Math.round(gx * (h / w)), 8, 128);
  const total = new Uint32Array(gx * gy);
  const hits = new Uint32Array(gx * gy);
  const step = Math.max(1, Math.round(stride));

  for (let y = 0; y < h; y += step) {
    const by = Math.min(gy - 1, ((y / h) * gy) | 0) * gx;
    const row = y * w;
    for (let x = 0; x < w; x += step) {
      const bin = by + Math.min(gx - 1, ((x / w) * gx) | 0);
      total[bin]++;
      const i = row + x;
      for (let c = 0; c < maps.maps.length; c++) {
        if (maps.maps[c][i] > threshold) {
          hits[bin]++;
          break;
        }
      }
    }
  }

  const occupied = new Uint8Array(gx * gy);
  let nOcc = 0;
  let minX = gx;
  let minY = gy;
  let maxX = -1;
  let maxY = -1;
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const b = j * gx + i;
      if (!total[b] || hits[b] < minHits || hits[b] / total[b] < binFill) continue;
      occupied[b] = 1;
      nOcc++;
      if (i < minX) minX = i;
      if (i > maxX) maxX = i;
      if (j < minY) minY = j;
      if (j > maxY) maxY = j;
    }
  }
  const coverage = nOcc / (gx * gy);
  if (!nOcc || coverage >= fullAbove) return fullExtent();

  return {
    x0: minX / gx,
    y0: minY / gy,
    x1: (maxX + 1) / gx,
    y1: (maxY + 1) / gy,
    cols: gx,
    rows: gy,
    occupied,
    coverage,
    full: false,
  };
}

/** Scale a normalized extent into image units (world px, or preview-array px). */
export function extentRect(e: ContentExtent, w: number, h: number) {
  return { x: e.x0 * w, y: e.y0 * h, w: Math.max(1e-6, e.x1 - e.x0) * w, h: Math.max(1e-6, e.y1 - e.y0) * h };
}

/**
 * View that frames the content extent, expressed in the same (zoom, panX, panY)
 * triple `fitRect` consumes — so the image, boundaries, ROIs and overlay keep
 * sharing one exact transform.
 */
export function fitView(
  e: ContentExtent,
  imgW: number,
  imgH: number,
  cw: number,
  ch: number,
  { margin = 0.03, zoomMin = 0.5, zoomMax = 60 } = {}
): View {
  const base = Math.min(cw / imgW, ch / imgH) || 1;
  const r = extentRect(e, imgW, imgH);
  // Nothing to inset when the whole image is content: keep the plain full-image
  // fit (zoom 1, no pan) exactly as it was.
  const usable = e.full ? 1 : Math.max(0.1, 1 - 2 * margin);
  const want = Math.min((cw * usable) / r.w, (ch * usable) / r.h);
  const zoom = clamp(want / base, zoomMin, zoomMax);
  const s = base * zoom;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return {
    zoom,
    panX: cw / 2 - cx * s - (cw - imgW * s) / 2,
    panY: ch / 2 - cy * s - (ch - imgH * s) / 2,
  };
}

/**
 * Clamp pan so at least `keepFrac` of the content (or of the viewport, whichever
 * is smaller) always stays on screen. This is a bounding-box guarantee: for a
 * diagonal strip it stops the view flying off the slide entirely, but the corners
 * of that box are still empty background — which is why callers also surface a
 * "recenter" affordance via `contentInViewport`.
 */
export function clampPan(v: View, e: ContentExtent, imgW: number, imgH: number, cw: number, ch: number, keepFrac = 0.22): View {
  const base = Math.min(cw / imgW, ch / imgH) || 1;
  const s = base * v.zoom;
  const axis = (n0: number, n1: number, img: number, canvas: number, pan: number) => {
    const c0 = n0 * img * s;
    const c1 = n1 * img * s;
    const off = (canvas - img * s) / 2;
    const keep = Math.min(c1 - c0, canvas) * keepFrac;
    const lo = keep - c1 - off;
    const hi = canvas - keep - c0 - off;
    return lo <= hi ? clamp(pan, lo, hi) : (lo + hi) / 2;
  };
  return {
    zoom: v.zoom,
    panX: axis(e.x0, e.x1, imgW, cw, v.panX),
    panY: axis(e.y0, e.y1, imgH, ch, v.panY),
  };
}

/** The visible region as a normalized image rectangle. */
export function viewportNorm(imgW: number, imgH: number, vt: ViewTransform): NormRect {
  const rect = fitRect(imgW, imgH, vt);
  const s = rect.s || 1;
  return {
    x0: -rect.x / s / imgW,
    y0: -rect.y / s / imgH,
    x1: (vt.canvasW - rect.x) / s / imgW,
    y1: (vt.canvasH - rect.y) / s / imgH,
  };
}

/** True when any occupied bin overlaps the (normalized) viewport. */
export function contentInViewport(e: ContentExtent, r: NormRect): boolean {
  if (e.full) return r.x1 > 0 && r.y1 > 0 && r.x0 < 1 && r.y0 < 1;
  const i0 = Math.floor(clamp(Math.min(r.x0, r.x1), 0, 0.999999) * e.cols);
  const i1 = Math.floor(clamp(Math.max(r.x0, r.x1), 0, 0.999999) * e.cols);
  const j0 = Math.floor(clamp(Math.min(r.y0, r.y1), 0, 0.999999) * e.rows);
  const j1 = Math.floor(clamp(Math.max(r.y0, r.y1), 0, 0.999999) * e.rows);
  // A viewport entirely outside the image overlaps nothing.
  if (r.x1 <= 0 || r.y1 <= 0 || r.x0 >= 1 || r.y0 >= 1) return false;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (e.occupied[j * e.cols + i]) return true;
    }
  }
  return false;
}

/**
 * Normalized centre of the occupied bin nearest to (nx, ny) — the target for
 * "recenter on tissue", which keeps the user's magnification instead of
 * throwing them back out to the whole slide.
 */
export function nearestContent(e: ContentExtent, nx: number, ny: number): { x: number; y: number } {
  const mid = { x: (e.x0 + e.x1) / 2, y: (e.y0 + e.y1) / 2 };
  if (e.full) return mid;
  let best = Infinity;
  let out = mid;
  for (let j = 0; j < e.rows; j++) {
    for (let i = 0; i < e.cols; i++) {
      if (!e.occupied[j * e.cols + i]) continue;
      const cx = (i + 0.5) / e.cols;
      const cy = (j + 0.5) / e.rows;
      const d = (cx - nx) ** 2 + (cy - ny) ** 2;
      if (d < best) {
        best = d;
        out = { x: cx, y: cy };
      }
    }
  }
  return out;
}

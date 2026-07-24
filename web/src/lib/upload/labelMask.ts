import type { MaskCell, MaskResult } from "./types";
import type { NumArray } from "./pyramid";

/** Labels beyond this cap would need more index memory than a browser tab should take. */
export const MAX_LABEL_VALUE = 2_000_000;

export interface LabelScan {
  maxLabel: number;
  /** pixel count per label (index = label value) */
  count: Uint32Array;
  sumX: Float64Array;
  sumY: Float64Array;
  /** row-major index of each label's first (topmost-then-leftmost) pixel */
  firstIdx: Uint32Array;
  /** label values present, ascending */
  ids: number[];
}

/** One pass over the mask: area, centroid accumulator and a tracing seed per label. */
export function scanLabels(labels: ArrayLike<number>, width: number, height: number): LabelScan {
  let maxLabel = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const v = labels[i];
    if (v > maxLabel) maxLabel = v;
  }
  maxLabel = Math.floor(maxLabel);
  if (maxLabel > MAX_LABEL_VALUE) {
    throw new Error(`Label mask has values up to ${maxLabel.toLocaleString()} — FluoroView indexes up to ${MAX_LABEL_VALUE.toLocaleString()} in the browser. Relabel it consecutively first.`);
  }
  const count = new Uint32Array(maxLabel + 1);
  const sumX = new Float64Array(maxLabel + 1);
  const sumY = new Float64Array(maxLabel + 1);
  const firstIdx = new Uint32Array(maxLabel + 1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const lab = labels[row + x];
      if (!lab || lab < 0) continue;
      const l = Math.floor(lab);
      if (count[l] === 0) firstIdx[l] = row + x;
      count[l] += 1;
      sumX[l] += x;
      sumY[l] += y;
    }
  }
  const ids: number[] = [];
  for (let l = 1; l <= maxLabel; l++) if (count[l] > 0) ids.push(l);
  return { maxLabel, count, sumX, sumY, firstIdx, ids };
}

const DIRS: [number, number][] = [
  [1, 0], // 0 E
  [0, 1], // 1 S
  [-1, 0], // 2 W
  [0, -1], // 3 N
];

/**
 * Trace one label's outline by following the cracks between foreground and
 * background pixels (marching-squares style), producing a closed ring on the
 * pixel-corner lattice. Vertices are exact pixel edges, so the outline hugs the
 * true mask instead of approximating it with a circle or a blurred raster.
 *
 * Only the component containing the label's topmost-leftmost pixel is traced;
 * a label split into several blobs contributes its largest-first blob.
 */
export function traceContour(labels: ArrayLike<number>, width: number, height: number, label: number, seedIdx: number): [number, number][] {
  const fg = (px: number, py: number): boolean => {
    if (px < 0 || py < 0 || px >= width || py >= height) return false;
    return labels[py * width + px] === label;
  };
  const sx = seedIdx % width;
  const sy = (seedIdx - sx) / width;
  // Valid outgoing crack directions at corner (x,y): keep foreground to the right.
  const valid = (x: number, y: number, dir: number): boolean => {
    switch (dir) {
      case 0:
        return fg(x, y) && !fg(x, y - 1);
      case 1:
        return fg(x - 1, y) && !fg(x, y);
      case 2:
        return fg(x - 1, y - 1) && !fg(x - 1, y);
      case 3:
        return fg(x, y - 1) && !fg(x - 1, y - 1);
      default:
        return false;
    }
  };

  const startX = sx;
  const startY = sy;
  const startDir = 0;
  if (!valid(startX, startY, startDir)) return [];
  const ring: [number, number][] = [];
  let x = startX;
  let y = startY;
  let dir = startDir;
  const maxSteps = Math.min(400000, 8 * (width + height) + 512);
  for (let step = 0; step < maxSteps; step++) {
    ring.push([x, y]);
    const d = DIRS[dir];
    x += d[0];
    y += d[1];
    // Prefer the tightest turn that keeps the label on our right.
    let next = -1;
    for (const cand of [(dir + 1) % 4, dir, (dir + 3) % 4]) {
      if (valid(x, y, cand)) {
        next = cand;
        break;
      }
    }
    if (next < 0) break;
    dir = next;
    if (x === startX && y === startY && dir === startDir) break;
  }
  return ring;
}

function perpDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

/** Ramer–Douglas–Peucker on an open polyline (iterative — no recursion limits). */
export function simplifyPolyline(points: [number, number][], eps: number): [number, number][] {
  const n = points.length;
  if (n < 3) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let far = -1;
    let best = eps;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(points[i], points[lo], points[hi]);
      if (d > best) {
        best = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** RDP for a closed ring: split at the vertex farthest from the first one. */
export function simplifyRing(ring: [number, number][], eps: number): [number, number][] {
  if (ring.length < 6) return ring.slice();
  let far = 0;
  let best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = simplifyPolyline(ring.slice(0, far + 1), eps);
  const b = simplifyPolyline(ring.slice(far), eps);
  const out = a.concat(b.slice(1));
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out.length >= 3 ? out : ring.slice();
}

export interface IntensitySource {
  planes: NumArray[];
  width: number;
  height: number;
  /** per-channel [lo,hi] used to normalise means into [0,1] */
  domains: [number, number][];
}

/**
 * Intensity source backed by the 8-bit preview planes (`ChannelMaps.maps`).
 *
 * Those planes are already stretched into each channel's own domain, so the
 * sampler has to normalise them over 0–255. Handing it the raw sensor domain
 * instead (e.g. [0, 6500] for 16-bit data) divides every mean by ~25x and
 * collapses all per-cell markers to ~0, which silently guts phenotyping and
 * clustering — so build this source through here rather than by hand.
 */
export function previewIntensity(planes: NumArray[], width: number, height: number): IntensitySource {
  return { planes, width, height, domains: planes.map(() => [0, 255] as [number, number]) };
}

export interface AnalyzeMaskOptions {
  /** mask px → world px scale (image pixel space of the active dataset) */
  scaleX?: number;
  scaleY?: number;
  simplifyEps?: number;
  /** stop tracing outlines past this many cells (records still complete) */
  maxOutlines?: number;
  intensity?: IntensitySource;
  onProgress?: (ratio: number, detail: string) => void;
}

/**
 * Turn an integer label mask into per-cell records (centroid, area, per-channel
 * mean) plus vector outlines in world pixels — everything ROI stats, phenotyping,
 * clustering and the Analysis tab need from a user's own segmentation.
 */
export function analyzeLabelMask(
  labels: ArrayLike<number>,
  width: number,
  height: number,
  opts: AnalyzeMaskOptions = {}
): MaskResult {
  const { scaleX = 1, scaleY = 1, simplifyEps = 0.75, maxOutlines = 400000, intensity, onProgress } = opts;
  const notes: string[] = [];
  onProgress?.(0.05, "scanning labels");
  const scan = scanLabels(labels, width, height);
  const ids = scan.ids;
  if (!ids.length) throw new Error("No non-zero labels found — this file doesn't look like a segmentation mask.");

  const nCh = intensity?.planes.length ?? 0;
  const sums = nCh ? new Float64Array(ids.length * nCh) : null;
  if (intensity && sums) {
    onProgress?.(0.25, "sampling channel intensities");
    const slot = new Int32Array(scan.maxLabel + 1).fill(-1);
    ids.forEach((id, i) => (slot[id] = i));
    const kx = intensity.width / width;
    const ky = intensity.height / height;
    for (let y = 0; y < height; y++) {
      const iy = Math.min(intensity.height - 1, Math.floor(y * ky));
      const irow = iy * intensity.width;
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const lab = labels[row + x];
        if (!lab) continue;
        const s = slot[Math.floor(lab)];
        if (s < 0) continue;
        const ix = Math.min(intensity.width - 1, Math.floor(x * kx));
        const at = irow + ix;
        for (let c = 0; c < nCh; c++) sums[s * nCh + c] += intensity.planes[c][at];
      }
    }
  }

  onProgress?.(0.5, `tracing ${ids.length.toLocaleString()} outlines`);
  const cells: MaskCell[] = [];
  const rings: Float32Array[] = [];
  let traced = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const area = scan.count[id];
    const cx = scan.sumX[id] / area;
    const cy = scan.sumY[id] / area;
    const markers: number[] = [];
    for (let c = 0; c < nCh; c++) {
      const [lo, hi] = intensity!.domains[c] ?? [0, 1];
      const mean = sums![i * nCh + c] / area;
      const t = (mean - lo) / (hi - lo || 1);
      markers.push(t <= 0 ? 0 : t >= 1 ? 1 : t);
    }
    cells.push({
      id,
      x: (cx + 0.5) * scaleX,
      y: (cy + 0.5) * scaleY,
      area: area * scaleX * scaleY,
      markers,
    });
    if (traced < maxOutlines) {
      const ring = simplifyRing(traceContour(labels, width, height, id, scan.firstIdx[id]), simplifyEps);
      const flat = new Float32Array(ring.length * 2);
      for (let p = 0; p < ring.length; p++) {
        flat[p * 2] = ring[p][0] * scaleX;
        flat[p * 2 + 1] = ring[p][1] * scaleY;
      }
      rings.push(flat);
      traced += 1;
    } else {
      rings.push(new Float32Array(0));
    }
    if (onProgress && i % 4096 === 0) onProgress(0.5 + 0.45 * (i / ids.length), `tracing outlines ${i.toLocaleString()}/${ids.length.toLocaleString()}`);
  }
  if (traced < ids.length) notes.push(`Outlines drawn for the first ${traced.toLocaleString()} of ${ids.length.toLocaleString()} cells (render cap); all cells still carry stats.`);
  onProgress?.(1, "done");
  return { cells, rings, labelCount: ids.length, notes };
}

import type { Cell, CellTypeDef, MarkerDef, Tissue } from "./types";

// 12-plex immuno-oncology panel (index 0 == DAPI nucleus)
export const MARKERS: MarkerDef[] = [
  { name: "DAPI", color: "#3b82f6", kind: "nuclear", defaultOn: true },
  { name: "PanCK", color: "#a78bfa", kind: "membrane", defaultOn: true },
  { name: "Ki67", color: "#f0abfc", kind: "nuclear", defaultOn: false },
  { name: "PD-L1", color: "#67e8f9", kind: "membrane", defaultOn: false },
  { name: "CD45", color: "#e2e8f0", kind: "membrane", defaultOn: false },
  { name: "CD3", color: "#22d3ee", kind: "membrane", defaultOn: true },
  { name: "CD8", color: "#f43f5e", kind: "membrane", defaultOn: true },
  { name: "CD4", color: "#34d399", kind: "membrane", defaultOn: false },
  { name: "CD20", color: "#fbbf24", kind: "membrane", defaultOn: false },
  { name: "CD68", color: "#fb923c", kind: "cyto", defaultOn: false },
  { name: "SMA", color: "#94a3b8", kind: "cyto", defaultOn: false },
  { name: "CD31", color: "#ef4444", kind: "membrane", defaultOn: false },
];

export const M = MARKERS.length;
const idx = (n: string) => MARKERS.findIndex((m) => m.name === n);

function profile(entries: Record<string, number>): number[] {
  const p = new Array(M).fill(0.04);
  p[0] = 0.95; // DAPI always high (nucleus)
  for (const [k, v] of Object.entries(entries)) p[idx(k)] = v;
  return p;
}

export const CELL_TYPES: CellTypeDef[] = [
  { name: "Tumor (PanCK+)", short: "Tumor", color: "#a78bfa", profile: profile({ PanCK: 0.92, Ki67: 0.55, "PD-L1": 0.35 }) },
  { name: "Tumor Ki67-high", short: "Tumor·Ki67", color: "#f0abfc", profile: profile({ PanCK: 0.88, Ki67: 0.95, "PD-L1": 0.3 }) },
  { name: "CD8 T cell", short: "CD8 T", color: "#f43f5e", profile: profile({ CD45: 0.85, CD3: 0.86, CD8: 0.9 }) },
  { name: "CD4 T cell", short: "CD4 T", color: "#34d399", profile: profile({ CD45: 0.85, CD3: 0.82, CD4: 0.82 }) },
  { name: "B cell", short: "B", color: "#fbbf24", profile: profile({ CD45: 0.8, CD20: 0.92 }) },
  { name: "Macrophage", short: "Mac", color: "#fb923c", profile: profile({ CD45: 0.75, CD68: 0.9, "PD-L1": 0.5 }) },
  { name: "Fibroblast", short: "Fibro", color: "#94a3b8", profile: profile({ SMA: 0.85 }) },
  { name: "Endothelial", short: "Endo", color: "#ef4444", profile: profile({ CD31: 0.9 }) },
];

// deterministic RNG so the demo is reproducible
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number, mean: number, sd: number) {
  const u = Math.max(1e-6, rng());
  const v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * sd;
}

export interface Region {
  cx: number;
  cy: number;
  r: number;
}

export function generateTissue(nCells = 4200, seed = 7): Tissue {
  const rng = mulberry32(seed);
  const width = 1500;
  const height = 1020;

  // tumor nests
  const nests: Region[] = [
    { cx: width * 0.3, cy: height * 0.36, r: 210 },
    { cx: width * 0.66, cy: height * 0.6, r: 250 },
    { cx: width * 0.82, cy: height * 0.24, r: 140 },
  ];
  // vessels (endothelial-rich curves)
  const vessels = [
    { x0: width * 0.05, y0: height * 0.8, x1: width * 0.95, y1: height * 0.68 },
    { x0: width * 0.12, y0: height * 0.1, x1: width * 0.5, y1: height * 0.95 },
  ];

  const cells: Cell[] = [];
  for (let i = 0; i < nCells; i++) {
    const x = rng() * width;
    const y = rng() * height;

    // distance to nearest nest
    let dNest = Infinity;
    let nestR = 1;
    for (const n of nests) {
      const d = Math.hypot(x - n.cx, y - n.cy) - n.r;
      if (d < dNest) {
        dNest = d;
        nestR = n.r;
      }
    }
    // distance to nearest vessel segment
    let dVess = Infinity;
    for (const v of vessels) {
      dVess = Math.min(dVess, distToSeg(x, y, v.x0, v.y0, v.x1, v.y1));
    }

    let typeIndex: number;
    const roll = rng();
    if (dNest < -nestR * 0.15) {
      // deep inside nest -> tumor, some infiltrating immune / macrophage
      if (roll < 0.72) typeIndex = rng() < 0.4 ? 1 : 0;
      else if (roll < 0.86) typeIndex = 5; // mac
      else typeIndex = 2; // CD8 infiltrate
    } else if (dNest < nestR * 0.35) {
      // invasive margin -> immune rich
      if (roll < 0.3) typeIndex = 2;
      else if (roll < 0.5) typeIndex = 3;
      else if (roll < 0.64) typeIndex = 4;
      else if (roll < 0.8) typeIndex = 5;
      else typeIndex = rng() < 0.5 ? 0 : 6;
    } else if (dVess < 16) {
      typeIndex = 7; // endothelial along vessels
    } else {
      // stroma
      if (roll < 0.5) typeIndex = 6;
      else if (roll < 0.62) typeIndex = 7;
      else if (roll < 0.76) typeIndex = 3;
      else if (roll < 0.86) typeIndex = 2;
      else if (roll < 0.94) typeIndex = 5;
      else typeIndex = 4;
    }

    const t = CELL_TYPES[typeIndex];
    const markers = t.profile.map((mean, mi) => {
      if (mi === 0) return clamp01(gauss(rng, 0.9, 0.07));
      const val = gauss(rng, mean, 0.06 + mean * 0.12);
      return clamp01(val);
    });

    const baseR =
      typeIndex <= 1 ? gauss(rng, 9.5, 1.4) : typeIndex === 6 ? gauss(rng, 7.5, 1.2) : gauss(rng, 6.4, 1.0);

    cells.push({
      id: i,
      x,
      y,
      r: Math.max(3.5, baseR),
      typeIndex,
      markers,
    });
  }

  return { width, height, cells, seed };
}

function distToSeg(px: number, py: number, x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - x0) * dx + (py - y0) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Build per-marker 8-bit intensity maps by splatting gaussian/ring kernels for
 * each cell. Returns packed RGBA textures (4 channels per texture) plus a
 * grayscale map per marker for reuse. Fast enough to run on the main thread.
 */
export interface ChannelMaps {
  width: number;
  height: number;
  scale: number;
  maps: Uint8ClampedArray[]; // one per marker (single channel intensity)
}

export function buildChannelMaps(tissue: Tissue, targetW = 1200): ChannelMaps {
  const scale = targetW / tissue.width;
  const width = Math.round(tissue.width * scale);
  const height = Math.round(tissue.height * scale);
  const maps: Uint8ClampedArray[] = [];
  for (let m = 0; m < M; m++) maps.push(new Uint8ClampedArray(width * height));

  for (const c of tissue.cells) {
    const cx = c.x * scale;
    const cy = c.y * scale;
    const rr = Math.max(2, c.r * scale);
    for (let m = 0; m < M; m++) {
      const inten = c.markers[m];
      if (inten < 0.12) continue;
      const kind = MARKERS[m].kind;
      splat(maps[m], width, height, cx, cy, rr, inten, kind);
    }
  }
  return { width, height, scale, maps };
}

function splat(
  buf: Uint8ClampedArray,
  W: number,
  H: number,
  cx: number,
  cy: number,
  r: number,
  inten: number,
  kind: "nuclear" | "membrane" | "cyto"
) {
  const rad = kind === "membrane" ? r * 1.35 : r * 1.15;
  const x0 = Math.max(0, Math.floor(cx - rad));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad));
  const peak = inten * 255;
  const ringR = r * 0.82;
  const ringW = Math.max(1.4, r * 0.5);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let a: number;
      if (kind === "membrane") {
        // donut / ring profile approximating a cell membrane stain
        const dd = (d - ringR) / ringW;
        a = Math.exp(-dd * dd);
      } else {
        const dd = d / (r * (kind === "nuclear" ? 0.7 : 0.9));
        a = Math.exp(-dd * dd);
      }
      const v = peak * a;
      const i = y * W + x;
      const nv = buf[i] + v;
      buf[i] = nv > 255 ? 255 : nv;
    }
  }
}

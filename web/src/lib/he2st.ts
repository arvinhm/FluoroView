/**
 * H&E → Spatial Transcriptomics, client side.
 *
 * This is the SAME transparent morphology/marker estimate the backend falls back
 * to (`server/he2st.py`), ported so the feature works with no server at all. It
 * is deliberately NOT sCellST: sCellST needs a GPU, the `scellst` package and a
 * trained MIL checkpoint that upstream does not publish.
 *
 * Values are arbitrary units, not transcript counts. Everything produced here is
 * EXPERIMENTAL and must not be used clinically or diagnostically.
 *
 * sCellST: Chadoutaud et al., Nat Commun 2026 (DOI 10.1038/s41467-025-67965-1),
 * https://github.com/sysbio-curie/sCellST — CC BY-NC 4.0 (non-commercial).
 */
import type { Cell } from "./types";

export const HE2ST_LICENSE = "CC BY-NC 4.0 (non-commercial)";
export const HE2ST_LICENSE_URL = "https://creativecommons.org/licenses/by-nc/4.0/";
export const HE2ST_REPO_URL = "https://github.com/sysbio-curie/sCellST";
export const HE2ST_DOI_URL = "https://doi.org/10.1038/s41467-025-67965-1";
export const HE2ST_ATTRIBUTION =
  "Predictions powered by sCellST — Chadoutaud et al., 'Learning single-cell gene expression from H&E images', Nat Commun 2026. Licensed CC BY-NC 4.0 (non-commercial).";
export const HE2ST_UNITS = "log1p-normalised (arbitrary units, not transcript counts)";
export const FALLBACK_NOTE =
  "Transparent morphology/marker-derived ESTIMATE — NOT sCellST and NOT validated model output. Arbitrary units, not transcript counts.";

export type Program = "tumor" | "prolif" | "tcell" | "bcell" | "myeloid" | "nk" | "fibroblast" | "endothelial" | "housekeeping";

export const PROGRAMS: Program[] = ["tumor", "prolif", "tcell", "bcell", "myeloid", "nk", "fibroblast", "endothelial", "housekeeping"];

/** Gene panel, each tagged with the cell programme it belongs to. */
export const GENE_PANEL: { gene: string; program: Program }[] = [
  ...["EPCAM", "KRT8", "KRT18", "KRT19", "CDH1", "ERBB2", "MUC1", "ELF3", "KRT5", "EPCAM2"].map((g) => ({ gene: g, program: "tumor" as Program })),
  ...["MKI67", "TOP2A", "PCNA", "CCNB1"].map((g) => ({ gene: g, program: "prolif" as Program })),
  ...["CD3D", "CD3E", "CD2", "CD8A", "CD4", "IL7R", "FOXP3", "GZMB", "PDCD1", "CTLA4"].map((g) => ({ gene: g, program: "tcell" as Program })),
  ...["MS4A1", "CD79A", "CD79B", "MZB1", "IGHG1"].map((g) => ({ gene: g, program: "bcell" as Program })),
  ...["CD68", "CD14", "LYZ", "ITGAX", "C1QA", "APOE", "CD274"].map((g) => ({ gene: g, program: "myeloid" as Program })),
  ...["NKG7", "KLRD1", "GNLY"].map((g) => ({ gene: g, program: "nk" as Program })),
  ...["COL1A1", "COL1A2", "COL3A1", "VIM", "ACTA2", "FN1", "PDGFRB", "DCN", "LUM"].map((g) => ({ gene: g, program: "fibroblast" as Program })),
  ...["PECAM1", "VWF", "CLDN5", "CDH5", "FLT1"].map((g) => ({ gene: g, program: "endothelial" as Program })),
  ...["ACTB", "GAPDH", "B2M", "MALAT1"].map((g) => ({ gene: g, program: "housekeeping" as Program })),
];

/** FluoroView's 12-plex protein panel order. */
const MARKER_PANEL = ["DAPI", "PanCK", "Ki67", "PD-L1", "CD45", "CD3", "CD8", "CD4", "CD20", "CD68", "SMA", "CD31"];

/** How each protein marker feeds each programme. */
const MARKER_TO_PROGRAM: Record<string, Partial<Record<Program, number>>> = {
  PanCK: { tumor: 1.0 },
  Ki67: { prolif: 1.0, tumor: 0.2 },
  "PD-L1": { myeloid: 0.6, tumor: 0.4 },
  CD45: { tcell: 0.4, bcell: 0.3, myeloid: 0.4, nk: 0.3 },
  CD3: { tcell: 1.0 },
  CD8: { tcell: 0.8, nk: 0.4 },
  CD4: { tcell: 0.8 },
  CD20: { bcell: 1.0 },
  CD68: { myeloid: 1.0 },
  SMA: { fibroblast: 1.0 },
  CD31: { endothelial: 1.0 },
  DAPI: { housekeeping: 0.5 },
};

/** Coarse mapping used when a cell has only a type index, no markers. */
const TYPE_TO_PROGRAM: Program[] = ["tumor", "tcell", "bcell", "myeloid", "fibroblast", "endothelial", "fibroblast", "nk"];

export interface He2stResult {
  model: "experimental-fallback" | "scellst";
  experimental: boolean;
  validated: boolean;
  genes: string[];
  units: string;
  /** per cell, aligned to `genes` */
  expression: number[][];
  license: string;
  licenseUrl: string;
  attribution: string;
  note: string;
  fallbackReason?: string;
  engine: "client" | "server";
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller on a seeded uniform stream. */
function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function zscoreColumns(X: number[][]): number[][] {
  const n = X.length;
  if (!n) return X;
  const d = X[0].length;
  const mu = new Array<number>(d).fill(0);
  const sd = new Array<number>(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mu[j] += row[j];
  for (let j = 0; j < d; j++) mu[j] /= n;
  for (const row of X) for (let j = 0; j < d; j++) sd[j] += (row[j] - mu[j]) ** 2;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / n) || 1;
  return X.map((row) => row.map((v, j) => (v - mu[j]) / sd[j]));
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Predict per-cell expression for `genes` from morphology + protein markers.
 *
 * Deterministic for a given seed, so the same tissue always paints the same map.
 */
export function predictHe2st(cells: Cell[], genes: string[], seed = 0): He2stResult {
  const panel = GENE_PANEL.filter((g) => genes.includes(g.gene));
  if (!panel.length) throw new Error("None of those genes are in the panel.");
  if (!cells.length) throw new Error("No cells to predict for.");
  const n = cells.length;
  const geneNames = panel.map((p) => p.gene);
  const progIdx = new Map(PROGRAMS.map((p, i) => [p, i]));

  // --- per-cell programme activity (the "biological" driver) ---
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(PROGRAMS.length).fill(0));
  const hasMarkers = cells.every((c) => c.markers && c.markers.length === MARKER_PANEL.length);
  if (hasMarkers) {
    const mz = zscoreColumns(cells.map((c) => c.markers));
    for (let mi = 0; mi < MARKER_PANEL.length; mi++) {
      const contrib = MARKER_TO_PROGRAM[MARKER_PANEL[mi]];
      if (!contrib) continue;
      for (const [prog, w] of Object.entries(contrib) as [Program, number][]) {
        const pi = progIdx.get(prog)!;
        for (let i = 0; i < n; i++) A[i][pi] += w * clamp(mz[i][mi], -2.5, 2.5);
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const prog = TYPE_TO_PROGRAM[((cells[i].typeIndex % 8) + 8) % 8] ?? "housekeeping";
      A[i][progIdx.get(prog)!] += 2.0;
    }
  }
  const hk = progIdx.get("housekeeping")!;
  for (let i = 0; i < n; i++) A[i][hk] += 0.75;

  // --- spatial smoothing so the map reads as tissue, not salt and pepper ---
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const densR = 0.04 * span;
  const smoothR = 0.05 * span;

  // Uniform grid so smoothing is O(n) rather than O(n²) on 30k cells.
  const cellSize = Math.max(smoothR, 1e-6);
  const key = (gx: number, gy: number) => `${gx},${gy}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(cells[i].x / cellSize), Math.floor(cells[i].y / cellSize));
    const b = grid.get(k);
    if (b) b.push(i);
    else grid.set(k, [i]);
  }
  const density = new Float64Array(n);
  const Asm: number[][] = Array.from({ length: n }, () => new Array<number>(PROGRAMS.length).fill(0));
  const densR2 = densR * densR;
  const smoothR2 = smoothR * smoothR;
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(cells[i].x / cellSize);
    const gy = Math.floor(cells[i].y / cellSize);
    const acc = new Array<number>(PROGRAMS.length).fill(0);
    let wsum = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = grid.get(key(gx + dx, gy + dy));
        if (!b) continue;
        for (const j of b) {
          const d2 = (cells[i].x - cells[j].x) ** 2 + (cells[i].y - cells[j].y) ** 2;
          if (d2 <= densR2 && i !== j) density[i] += 1;
          if (d2 <= smoothR2) {
            wsum += 1;
            for (let p = 0; p < PROGRAMS.length; p++) acc[p] += A[j][p];
          }
        }
      }
    }
    for (let p = 0; p < PROGRAMS.length; p++) Asm[i][p] = wsum > 0 ? 0.5 * A[i][p] + 0.5 * (acc[p] / wsum) : A[i][p];
  }

  // --- morphology feature block ---
  const featRows: number[][] = cells.map((c, i) => [c.r, density[i]]);
  let F = zscoreColumns(featRows);
  if (hasMarkers) {
    const mz = zscoreColumns(cells.map((c) => c.markers));
    F = F.map((row, i) => [...row, ...mz[i].map((v) => clamp(v, -2.5, 2.5))]);
  }

  // --- assemble expression: programme term + morphology term + baseline ---
  const rand = mulberry32(seed);
  const d = F[0].length;
  const G = geneNames.length;
  const W: number[][] = Array.from({ length: d }, () => Array.from({ length: G }, () => gaussian(rand) * 0.15));
  const baseline = Array.from({ length: G }, () => -1.2 + rand() * 1.0);
  const PROG_STRENGTH = 1.6;

  const expression: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(G);
    for (let g = 0; g < G; g++) {
      let morph = 0;
      for (let j = 0; j < d; j++) morph += F[i][j] * W[j][g];
      const prog = Asm[i][progIdx.get(panel[g].program)!] * PROG_STRENGTH;
      const logit = prog + morph + baseline[g] + gaussian(rand) * 0.05;
      // softplus keeps it non-negative, log1p emulates normalised expression
      const softplus = logit > 30 ? logit : Math.log1p(Math.exp(logit));
      row[g] = Math.log1p(softplus);
    }
    expression[i] = row;
  }

  return {
    model: "experimental-fallback",
    experimental: true,
    validated: false,
    genes: geneNames,
    units: HE2ST_UNITS,
    expression,
    license: HE2ST_LICENSE,
    licenseUrl: HE2ST_LICENSE_URL,
    attribution: HE2ST_ATTRIBUTION,
    note: FALLBACK_NOTE,
    fallbackReason: "Computed in this browser tab — sCellST needs a GPU, the scellst package and a trained checkpoint, none of which run client-side.",
    engine: "client",
  };
}

interface ServerCellExpr {
  id: number;
  expression: number[];
}

interface ServerHe2st {
  model: "scellst" | "experimental-fallback";
  experimental: boolean;
  validated: boolean;
  genes: string[];
  units: string;
  cells: ServerCellExpr[];
  license: string;
  licenseUrl: string;
  attribution: string;
  note: string;
  fallbackReason?: string;
}

/** Ask the backend (which may have real sCellST); throws so callers can fall back. */
export async function fetchHe2st(cells: Cell[], genes: string[], imageB64?: string | null): Promise<He2stResult> {
  const res = await fetch("/api/he2st", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cells: cells.map((c) => ({ id: c.id, x: c.x, y: c.y, r: c.r, typeIndex: c.typeIndex, markers: c.markers })),
      genes,
      image_b64: imageB64 ?? null,
    }),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* keep the status line */
    }
    throw new Error(detail);
  }
  const j = (await res.json()) as ServerHe2st;
  // Re-align rows to the caller's cell order — the server echoes ids, not order.
  const byId = new Map(j.cells.map((c) => [c.id, c.expression]));
  const expression = cells.map((c, i) => byId.get(typeof c.id === "number" ? c.id : i) ?? new Array<number>(j.genes.length).fill(0));
  return { ...j, expression, engine: "server" };
}

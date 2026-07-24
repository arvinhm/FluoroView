import type { Cell } from "./types";

/**
 * Marker indices used for phenotyping / clustering. Channel 0 is the nuclear
 * (DAPI-equivalent) channel and is excluded, matching the desktop workflow.
 */
export function panelIndices(nChannels: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < nChannels; i++) out.push(i);
  return out;
}

export function markerMatrix(cells: Cell[], cols?: number[]): number[][] {
  const c = cols ?? panelIndices(cells[0]?.markers.length ?? 0);
  return cells.map((cell) => c.map((j) => cell.markers[j]));
}

function mean(a: number[]) {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

export function standardize(X: number[][]): number[][] {
  const n = X.length;
  const d = X[0].length;
  const mu = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mu[j] += row[j];
  for (let j = 0; j < d; j++) mu[j] /= n;
  for (const row of X) for (let j = 0; j < d; j++) sd[j] += (row[j] - mu[j]) ** 2;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / n) || 1;
  return X.map((row) => row.map((v, j) => (v - mu[j]) / sd[j]));
}

/** PCA via covariance power-iteration + deflation. Returns scores [n x k]. */
export function pca(X: number[][], k = 6): number[][] {
  const n = X.length;
  const d = X[0].length;
  // covariance (d x d)
  const cov: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const row of X) {
    for (let a = 0; a < d; a++) {
      const ra = row[a];
      for (let b = a; b < d; b++) {
        cov[a][b] += ra * row[b];
      }
    }
  }
  for (let a = 0; a < d; a++)
    for (let b = a; b < d; b++) {
      cov[a][b] /= n;
      cov[b][a] = cov[a][b];
    }

  const comps: number[][] = [];
  const work = cov.map((r) => r.slice());
  for (let c = 0; c < Math.min(k, d); c++) {
    let v = new Array(d).fill(0).map(() => Math.random() - 0.5);
    normalize(v);
    for (let it = 0; it < 80; it++) {
      const nv = new Array(d).fill(0);
      for (let a = 0; a < d; a++) {
        let s = 0;
        for (let b = 0; b < d; b++) s += work[a][b] * v[b];
        nv[a] = s;
      }
      normalize(nv);
      v = nv;
    }
    // eigenvalue
    let lambda = 0;
    for (let a = 0; a < d; a++) {
      let s = 0;
      for (let b = 0; b < d; b++) s += work[a][b] * v[b];
      lambda += v[a] * s;
    }
    // deflate
    for (let a = 0; a < d; a++)
      for (let b = 0; b < d; b++) work[a][b] -= lambda * v[a] * v[b];
    comps.push(v);
  }

  return X.map((row) =>
    comps.map((v) => {
      let s = 0;
      for (let j = 0; j < d; j++) s += row[j] * v[j];
      return s;
    })
  );
}

function normalize(v: number[]) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
}

/** k-means++ initialization + Lloyd iterations. */
export function kmeans(X: number[][], k: number, iters = 40): number[] {
  const n = X.length;
  const d = X[0].length;
  const centers: number[][] = [];
  centers.push(X[Math.floor(Math.random() * n)].slice());
  const dist2 = new Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dd = sqdist(X[i], centers[centers.length - 1]);
      if (dd < dist2[i]) dist2[i] = dd;
      sum += dist2[i];
    }
    let r = Math.random() * sum;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      r -= dist2[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centers.push(X[pick].slice());
  }

  const labels = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = sqdist(X[i], centers[c]);
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      if (labels[i] !== best) moved++;
      labels[i] = best;
    }
    const sums = Array.from({ length: k }, () => new Array(d).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      counts[labels[i]]++;
      const row = X[i];
      const s = sums[labels[i]];
      for (let j = 0; j < d; j++) s[j] += row[j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < d; j++) centers[c][j] = sums[c][j] / counts[c];
    }
    if (moved === 0 && it > 3) break;
  }
  return labels;
}

function sqdist(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const dd = a[i] - b[i];
    s += dd * dd;
  }
  return s;
}

/**
 * UMAP-style neighbor embedding: kNN graph in PC space + SGD with attractive
 * (neighbor) and repulsive (negative-sampled) forces. Genuine neighbor
 * embedding, tuned to be fast on a few thousand points.
 */
export function umapEmbed(
  Xpc: number[][],
  opts: { neighbors?: number; iters?: number; seed?: number } = {}
): [number, number][] {
  const n = Xpc.length;
  const K = opts.neighbors ?? 14;
  const iters = opts.iters ?? 220;

  // brute-force kNN
  const knn: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ds: [number, number][] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      ds.push([sqdist(Xpc[i], Xpc[j]), j]);
    }
    ds.sort((a, b) => a[0] - b[0]);
    knn[i] = ds.slice(0, K).map((x) => x[1]);
  }

  // init from first two PCs
  const pos: [number, number][] = Xpc.map((r) => [
    (r[0] || 0) + (Math.random() - 0.5) * 0.01,
    (r[1] || 0) + (Math.random() - 0.5) * 0.01,
  ]);
  scaleToUnit(pos);

  let alpha = 1.0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      const nbrs = knn[i];
      // attractive
      for (const j of nbrs) {
        applyForce(pos, i, j, alpha, true);
      }
      // repulsive (negative sampling)
      for (let s = 0; s < 4; s++) {
        const j = (Math.random() * n) | 0;
        if (j !== i) applyForce(pos, i, j, alpha, false);
      }
    }
    alpha = 1.0 * (1 - it / iters);
  }
  scaleToUnit(pos);
  return pos;
}

function applyForce(pos: [number, number][], i: number, j: number, alpha: number, attract: boolean) {
  const dx = pos[i][0] - pos[j][0];
  const dy = pos[i][1] - pos[j][1];
  const d2 = dx * dx + dy * dy + 1e-4;
  let grad: number;
  if (attract) {
    grad = (-2 * 1.0) / (1 + d2);
  } else {
    grad = (2 * 1.0) / ((0.01 + d2) * (1 + d2));
  }
  const c = Math.max(-4, Math.min(4, grad)) * alpha * 0.06;
  pos[i][0] += c * dx;
  pos[i][1] += c * dy;
}

function scaleToUnit(pos: [number, number][]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pos) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const sx = maxX - minX || 1;
  const sy = maxY - minY || 1;
  const s = Math.max(sx, sy);
  for (const p of pos) {
    p[0] = (p[0] - minX) / s;
    p[1] = (p[1] - minY) / s;
  }
}

/**
 * Otsu threshold on a [0,1] intensity vector, returned in [0,1].
 *
 * When several bin boundaries tie for maximal between-class variance (e.g. a
 * clean bimodal split with an empty valley between the modes), we return the
 * midpoint of that plateau so the threshold lands in the valley rather than at
 * the edge of a mode — which matters for phenotype gating.
 */
export function otsu(values: number[], bins = 64): number {
  if (values.length === 0) return 0.5;
  const hist = new Array(bins).fill(0);
  for (const v of values) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(v * bins)));
    hist[b]++;
  }
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];

  const between = new Array(bins).fill(-1);
  let sumB = 0,
    wB = 0,
    maxVar = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    between[i] = v;
    if (v > maxVar) maxVar = v;
  }
  if (maxVar <= 0) return 0.5;

  let lo = -1;
  let hi = -1;
  for (let i = 0; i < bins; i++) {
    if (between[i] >= maxVar * (1 - 1e-6)) {
      if (lo < 0) lo = i;
      hi = i;
    }
  }
  const thr = (lo + hi) / 2;
  return (thr + 0.5) / bins;
}

/**
 * Embed EVERY cell in 2D. A true neighbor embedding (kNN + SGD) is O(n²) for the
 * kNN graph, which is too slow in-browser at tens of thousands of points, so we:
 *   1. run the genuine `umapEmbed` on a strided LANDMARK subset (fast, faithful),
 *   2. project every remaining cell onto that layout via an inverse-distance
 *      weighted average of its nearest landmarks in PC space (out-of-sample
 *      extension — the standard landmark trick).
 * Result: a clean, sharp embedding of all n cells, computed in ~1–2 s with no
 * backend. Positions are returned in [0,1]² (one per input row, in order).
 */
export function embedAllCells(
  scores: number[][],
  opts: { landmarks?: number; neighbors?: number; iters?: number } = {}
): [number, number][] {
  const n = scores.length;
  if (n === 0) return [];
  const L = Math.min(opts.landmarks ?? 2600, n);
  const step = Math.max(1, Math.floor(n / L));
  const landmarkIdx: number[] = [];
  for (let i = 0; i < n && landmarkIdx.length < L; i += step) landmarkIdx.push(i);

  const landmarkScores = landmarkIdx.map((i) => scores[i]);
  const landmarkPos = umapEmbed(landmarkScores, { neighbors: opts.neighbors ?? 14, iters: opts.iters ?? 200 });
  if (landmarkIdx.length === n) return landmarkPos;

  const M = 4; // nearest landmarks blended per cell
  const pos: [number, number][] = new Array(n);
  const bestD = new Float64Array(M);
  const bestJ = new Int32Array(M);
  for (let i = 0; i < n; i++) {
    for (let m = 0; m < M; m++) {
      bestD[m] = Infinity;
      bestJ[m] = 0;
    }
    const row = scores[i];
    for (let l = 0; l < landmarkScores.length; l++) {
      const d = sqdist(row, landmarkScores[l]);
      // insert into the small sorted top-M list
      if (d < bestD[M - 1]) {
        let p = M - 1;
        while (p > 0 && bestD[p - 1] > d) {
          bestD[p] = bestD[p - 1];
          bestJ[p] = bestJ[p - 1];
          p--;
        }
        bestD[p] = d;
        bestJ[p] = l;
      }
    }
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (let m = 0; m < M; m++) {
      const w = 1 / (bestD[m] + 1e-4);
      wx += landmarkPos[bestJ[m]][0] * w;
      wy += landmarkPos[bestJ[m]][1] * w;
      wsum += w;
    }
    pos[i] = [wx / wsum, wy / wsum];
  }
  return pos;
}

export interface MarkerSign {
  index: number;
  name: string;
  sign: "+" | "-" | "~";
  value: number;
  z: number;
}

/**
 * Per-channel +/- signature of a cluster: z-score of the cluster's mean marker
 * intensity vs. the whole-image mean. Used to name/annotate cell types
 * ("CD8+ CD3+ …"). Excludes the nuclear channel (panel convention).
 */
export function clusterSignature(cells: Cell[], labels: number[], cluster: number, channelNames: string[]): MarkerSign[] {
  const M = channelNames.length;
  const panel = panelIndices(M);
  const n = cells.length || 1;
  const gMean = new Array(M).fill(0);
  const gSd = new Array(M).fill(0);
  for (const c of cells) for (let m = 0; m < M; m++) gMean[m] += c.markers[m];
  for (let m = 0; m < M; m++) gMean[m] /= n;
  for (const c of cells) for (let m = 0; m < M; m++) gSd[m] += (c.markers[m] - gMean[m]) ** 2;
  for (let m = 0; m < M; m++) gSd[m] = Math.sqrt(gSd[m] / n) || 1;

  const members = cells.filter((_, i) => labels[i] === cluster);
  const cMean = new Array(M).fill(0);
  for (const c of members) for (let m = 0; m < M; m++) cMean[m] += c.markers[m];
  for (let m = 0; m < M; m++) cMean[m] /= members.length || 1;

  const out: MarkerSign[] = panel.map((m) => {
    const z = (cMean[m] - gMean[m]) / gSd[m];
    const sign: "+" | "-" | "~" = z > 0.5 ? "+" : z < -0.5 ? "-" : "~";
    return { index: m, name: channelNames[m], sign, value: cMean[m], z };
  });
  out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return out;
}

export interface ClusterSummary {
  cluster: number;
  count: number;
  pct: number;
  topMarkers: { name: string; value: number }[];
}

export function summarizeClusters(
  cells: Cell[],
  labels: number[],
  k: number,
  channelNames: string[]
): ClusterSummary[] {
  const M = channelNames.length;
  const panel = panelIndices(M);
  const out: ClusterSummary[] = [];
  for (let c = 0; c < k; c++) {
    const members = cells.filter((_, i) => labels[i] === c);
    const means = new Array(M).fill(0);
    for (const cell of members) for (let m = 0; m < M; m++) means[m] += cell.markers[m];
    for (let m = 0; m < M; m++) means[m] /= members.length || 1;
    const top = panel
      .map((m) => ({ name: channelNames[m], value: means[m] }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
    out.push({
      cluster: c,
      count: members.length,
      pct: (members.length / cells.length) * 100,
      topMarkers: top,
    });
  }
  return out;
}

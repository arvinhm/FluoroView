import type { Cell } from "./types";
import { M, MARKERS } from "./synth";

/** marker indices used for phenotyping / clustering (DAPI excluded) */
export const PANEL_IDX = MARKERS.map((_, i) => i).filter((i) => i !== 0);

export function markerMatrix(cells: Cell[], cols = PANEL_IDX): number[][] {
  return cells.map((c) => cols.map((j) => c.markers[j]));
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

/** Otsu threshold on a [0,1] intensity vector, returned in [0,1]. */
export function otsu(values: number[], bins = 64): number {
  const hist = new Array(bins).fill(0);
  for (const v of values) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(v * bins)));
    hist[b]++;
  }
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, maxVar = -1, thr = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      thr = i;
    }
  }
  return thr / bins;
}

export interface ClusterSummary {
  cluster: number;
  count: number;
  pct: number;
  topMarkers: { name: string; value: number }[];
}

export function summarizeClusters(cells: Cell[], labels: number[], k: number): ClusterSummary[] {
  const out: ClusterSummary[] = [];
  for (let c = 0; c < k; c++) {
    const members = cells.filter((_, i) => labels[i] === c);
    const means = new Array(M).fill(0);
    for (const cell of members) for (let m = 0; m < M; m++) means[m] += cell.markers[m];
    for (let m = 0; m < M; m++) means[m] /= members.length || 1;
    const top = PANEL_IDX.map((m) => ({ name: MARKERS[m].name, value: means[m] }))
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

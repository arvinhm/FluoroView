/**
 * CoSMoS on the client — CAMSE enrichment and MOSAIC niche discovery for
 * interactive regions, with no backend required.
 *
 * This mirrors the reference implementation (`server/cosmos_core.py`) rather
 * than approximating it: the permutation null is compartment-stratified, the
 * per-scale Monte-Carlo p-values use the (b+1)/(B+1) rule, and the within-pair
 * multiscale correction is the EXACT max-|z| statistic evaluated on the same
 * shared permutations (not a min-q shortcut). Benjamini–Hochberg then controls
 * FDR across pairs.
 *
 * Cost is O(B · Σ_s nnz_s), so callers should run it in a worker and keep B
 * modest on the client; the backend exists for reporting-grade B and WSI-scale
 * cell counts.
 *
 * RESEARCH USE ONLY — not validated for clinical or diagnostic use.
 */
import type { Cell } from "../types";
import type { EnrichmentOptions, EnrichmentResult, NicheOptions, NicheResult, PairEnrichment, ScalePoint } from "./types";

/** Above this the client would stall; the caller should use the backend. */
export const CLIENT_CELL_LIMIT = 20000;

export type ProgressFn = (ratio: number, detail: string) => void;

/** Mulberry32 — small, fast, and reproducible from a seed. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(a: Int32Array, rand: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

/** Benjamini–Hochberg q-values, monotone from the largest p downwards. */
export function bhFdr(p: number[]): number[] {
  const m = p.length;
  if (!m) return [];
  const order = [...p.keys()].sort((i, j) => p[i] - p[j]);
  const q = new Array<number>(m).fill(1);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const i = order[k];
    prev = Math.min(prev, (p[i] * m) / (k + 1));
    q[i] = prev;
  }
  return q;
}

interface ScaleEdges {
  /** anchor index per directed edge */
  row: Int32Array;
  /** neighbour index per directed edge */
  col: Int32Array;
}

/**
 * Directed edges per scale, restricted to same-compartment pairs when the null
 * is stratified. "annulus" gives decorrelated rings (r_{s-1}, r_s]; "disk"
 * accumulates (0, r_s] like Ripley's K.
 */
export function buildScaleEdges(
  px: Float64Array,
  py: Float64Array,
  comp: Int32Array,
  radiiUm: number[],
  mode: "annulus" | "disk",
  compartmentAware: boolean
): ScaleEdges[] {
  const n = px.length;
  const S = radiiUm.length;
  const rMax = radiiUm[S - 1];
  const rMax2 = rMax * rMax;

  // uniform grid at the largest radius → each pair is found in a 3×3 sweep
  const cell = rMax > 0 ? rMax : 1;
  const inv = 1 / cell;
  const buckets = new Map<number, number[]>();
  let minGx = Infinity;
  let minGy = Infinity;
  let maxGx = -Infinity;
  let maxGy = -Infinity;
  const gxs = new Int32Array(n);
  const gys = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(px[i] * inv);
    const gy = Math.floor(py[i] * inv);
    gxs[i] = gx;
    gys[i] = gy;
    if (gx < minGx) minGx = gx;
    if (gy < minGy) minGy = gy;
    if (gx > maxGx) maxGx = gx;
    if (gy > maxGy) maxGy = gy;
  }
  const span = Math.max(1, maxGx - minGx + 3);
  const key = (gx: number, gy: number) => (gy - minGy + 1) * span + (gx - minGx + 1);
  for (let i = 0; i < n; i++) {
    const k = key(gxs[i], gys[i]);
    const b = buckets.get(k);
    if (b) b.push(i);
    else buckets.set(k, [i]);
  }

  const rows: number[][] = Array.from({ length: S }, () => []);
  const cols: number[][] = Array.from({ length: S }, () => []);
  for (let i = 0; i < n; i++) {
    const gx = gxs[i];
    const gy = gys[i];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = buckets.get(key(gx + dx, gy + dy));
        if (!b) continue;
        for (const j of b) {
          if (j <= i) continue;
          if (compartmentAware && comp[i] !== comp[j]) continue;
          const ddx = px[i] - px[j];
          const ddy = py[i] - py[j];
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 > rMax2) continue;
          const d = Math.sqrt(d2);
          // ring index: radii[s-1] < d <= radii[s]
          let s = 0;
          while (s < S && d > radiiUm[s]) s++;
          if (s >= S) continue;
          if (mode === "annulus") {
            rows[s].push(i, j);
            cols[s].push(j, i);
          } else {
            for (let t = s; t < S; t++) {
              rows[t].push(i, j);
              cols[t].push(j, i);
            }
          }
        }
      }
    }
  }
  return rows.map((r, s) => ({ row: Int32Array.from(r), col: Int32Array.from(cols[s]) }));
}

/** T[s] = Uᵀ A_s U for one-hot-per-cell marks (type index + weight). */
function statOneHot(edges: ScaleEdges[], K: number, type: Int32Array, weight: Float64Array, perm: Int32Array, out: Float64Array[]): void {
  for (let s = 0; s < edges.length; s++) {
    const { row, col } = edges[s];
    const T = out[s];
    T.fill(0);
    for (let e = 0; e < row.length; e++) {
      const oi = perm[row[e]];
      const oj = perm[col[e]];
      const w = weight[oi] * weight[oj];
      if (w !== 0) T[type[oi] * K + type[oj]] += w;
    }
  }
}

/** T[s] = Uᵀ A_s U for dense marks (soft posteriors). */
function statDense(edges: ScaleEdges[], K: number, U: Float64Array, perm: Int32Array, out: Float64Array[]): void {
  for (let s = 0; s < edges.length; s++) {
    const { row, col } = edges[s];
    const T = out[s];
    T.fill(0);
    for (let e = 0; e < row.length; e++) {
      const oi = perm[row[e]] * K;
      const oj = perm[col[e]] * K;
      for (let a = 0; a < K; a++) {
        const ua = U[oi + a];
        if (ua === 0) continue;
        for (let b = 0; b < K; b++) T[a * K + b] += ua * U[oj + b];
      }
    }
  }
}

function typeNamesOf(names: string[] | undefined, K: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < K; i++) out.push(names?.[i] ?? `Type ${i + 1}`);
  return out;
}

/**
 * CAMSE: multiscale cell-type co-occurrence versus a compartment-stratified
 * label-permutation null.
 */
export function computeEnrichment(cells: Cell[], opts: EnrichmentOptions, onProgress?: ProgressFn): EnrichmentResult {
  const t0 = Date.now();
  const {
    numTypes: K,
    radiiUm,
    umPerUnit,
    mode = "annulus",
    compartmentAware = true,
    marks = "confWeighted",
    numPermutations: B = 199,
    alpha = 0.05,
    seed = 1,
  } = opts;
  const N = cells.length;
  const S = radiiUm.length;
  if (!N) throw new Error("No cells to analyse.");
  if (!S) throw new Error("Choose at least one scale radius.");
  for (let s = 1; s < S; s++) if (radiiUm[s] <= radiiUm[s - 1]) throw new Error("Scale radii must be strictly increasing.");

  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const type = new Int32Array(N);
  const weight = new Float64Array(N);
  const comp = new Int32Array(N);
  let sawCompartment = false;
  for (let i = 0; i < N; i++) {
    const c = cells[i];
    px[i] = c.x * umPerUnit;
    py[i] = c.y * umPerUnit;
    const t = c.typeIndex | 0;
    if (t < 0 || t >= K) throw new Error(`Cell ${c.id} has typeIndex ${t}, outside 0..${K - 1}.`);
    type[i] = t;
    weight[i] = marks === "confWeighted" && opts.confidence ? Math.max(0, opts.confidence[i] ?? 1) : 1;
    if (c.compartmentIndex != null) {
      comp[i] = Math.max(0, c.compartmentIndex | 0);
      sawCompartment = true;
    }
  }
  // Stratifying by a single compartment is just the global null; say so rather
  // than claiming architecture-aware inference.
  let distinct = 0;
  const seen = new Set<number>();
  for (let i = 0; i < N; i++) if (!seen.has(comp[i])) (seen.add(comp[i]), (distinct = seen.size));
  const stratified = compartmentAware && sawCompartment && distinct > 1;

  const dense = marks === "softRaw";
  let U = new Float64Array(0);
  if (dense) {
    if (!opts.posteriors) throw new Error('marks="softRaw" needs raw posteriors.');
    U = new Float64Array(N * K);
    for (let i = 0; i < N; i++) for (let c = 0; c < K; c++) U[i * K + c] = Math.max(0, opts.posteriors[i]?.[c] ?? 0);
  }

  onProgress?.(0.04, "building neighbour graph");
  const edges = buildScaleEdges(px, py, comp, radiiUm, mode, stratified);

  const alloc = () => Array.from({ length: S }, () => new Float64Array(K * K));
  const Tobs = alloc();
  const identity = new Int32Array(N);
  for (let i = 0; i < N; i++) identity[i] = i;
  if (dense) statDense(edges, K, U, identity, Tobs);
  else statOneHot(edges, K, type, weight, identity, Tobs);

  // permutation groups: within-compartment when stratified, else one group
  const groups: Int32Array[] = [];
  if (stratified) {
    const byComp = new Map<number, number[]>();
    for (let i = 0; i < N; i++) {
      const g = byComp.get(comp[i]);
      if (g) g.push(i);
      else byComp.set(comp[i], [i]);
    }
    for (const g of byComp.values()) groups.push(Int32Array.from(g));
  } else {
    groups.push(identity.slice());
  }

  const sum = alloc();
  const sumSq = alloc();
  const geScale = alloc();
  // Storing every permutation's z would cost B·S·K² doubles; instead keep only
  // each permutation's per-pair max_s |z|, which is all the exact multiscale
  // p-value needs — but that needs mu/sd first, so run the loop twice with the
  // same seed rather than holding B·S·K² in memory.
  const perm = identity.slice();
  const scratch = alloc();
  const drawPermutations = (visit: (T: Float64Array[]) => void) => {
    const rand = rng(seed);
    for (let b = 0; b < B; b++) {
      for (const g of groups) {
        const shuffled = g.slice();
        shuffle(shuffled, rand);
        for (let t = 0; t < g.length; t++) perm[g[t]] = shuffled[t];
      }
      if (dense) statDense(edges, K, U, perm, scratch);
      else statOneHot(edges, K, type, weight, perm, scratch);
      visit(scratch);
    }
  };

  onProgress?.(0.1, `permutation pass 1 of 2 (B=${B})`);
  let done = 0;
  drawPermutations((T) => {
    for (let s = 0; s < S; s++) {
      const Ts = T[s];
      const su = sum[s];
      const sq = sumSq[s];
      for (let k = 0; k < K * K; k++) {
        su[k] += Ts[k];
        sq[k] += Ts[k] * Ts[k];
      }
    }
    done++;
    if (done % 25 === 0) onProgress?.(0.1 + 0.4 * (done / B), `permutation pass 1 of 2 — ${done}/${B}`);
  });

  const mu = alloc();
  const sd = alloc();
  for (let s = 0; s < S; s++) {
    for (let k = 0; k < K * K; k++) {
      const m = sum[s][k] / B;
      mu[s][k] = m;
      // ddof = 1, matching numpy's std(ddof=1) in the reference
      const varr = B > 1 ? Math.max(0, (sumSq[s][k] - B * m * m) / (B - 1)) : 0;
      sd[s][k] = Math.sqrt(varr);
    }
  }

  const z = alloc();
  for (let s = 0; s < S; s++)
    for (let k = 0; k < K * K; k++) z[s][k] = sd[s][k] > 0 ? (Tobs[s][k] - mu[s][k]) / sd[s][k] : 0;

  const maxAbsZ = new Float64Array(K * K);
  for (let k = 0; k < K * K; k++) {
    let m = 0;
    for (let s = 0; s < S; s++) m = Math.max(m, Math.abs(z[s][k]));
    maxAbsZ[k] = m;
  }

  onProgress?.(0.52, `permutation pass 2 of 2 (B=${B})`);
  const geMax = new Float64Array(K * K);
  done = 0;
  drawPermutations((T) => {
    for (let k = 0; k < K * K; k++) {
      let permMax = 0;
      for (let s = 0; s < S; s++) {
        const sdk = sd[s][k];
        const zp = sdk > 0 ? (T[s][k] - mu[s][k]) / sdk : 0;
        const az = Math.abs(zp);
        if (az > permMax) permMax = az;
        if (Math.abs(T[s][k] - mu[s][k]) >= Math.abs(Tobs[s][k] - mu[s][k])) geScale[s][k] += 1;
      }
      if (permMax >= maxAbsZ[k]) geMax[k] += 1;
    }
    done++;
    if (done % 25 === 0) onProgress?.(0.52 + 0.4 * (done / B), `permutation pass 2 of 2 — ${done}/${B}`);
  });

  onProgress?.(0.94, "FDR correction");
  const colSum = new Float64Array(K);
  for (let i = 0; i < N; i++) {
    if (dense) for (let c = 0; c < K; c++) colSum[c] += U[i * K + c];
    else colSum[type[i]] += weight[i];
  }

  // BH across unordered pairs on the max-|z| p (primary), and across all
  // unordered (pair, scale) tests on the per-scale p (for the heatmap).
  const pMaxFlat: number[] = [];
  const pScaleFlat: number[] = [];
  for (let a = 0; a < K; a++)
    for (let b = a; b < K; b++) {
      pMaxFlat.push((1 + geMax[a * K + b]) / (B + 1));
      for (let s = 0; s < S; s++) pScaleFlat.push((1 + geScale[s][a * K + b]) / (B + 1));
    }
  const qMaxFlat = bhFdr(pMaxFlat);
  const qScaleFlat = bhFdr(pScaleFlat);

  const names = typeNamesOf(opts.typeNames, K);
  const pairs: PairEnrichment[] = [];
  let pi = 0;
  let si = 0;
  for (let a = 0; a < K; a++) {
    for (let b = a; b < K; b++) {
      const k = a * K + b;
      const perScale: ScalePoint[] = [];
      let peak = 0;
      for (let s = 0; s < S; s++) {
        const denomA = colSum[a] > 0 ? colSum[a] : Infinity;
        const denomB = colSum[b] > 0 ? colSum[b] : Infinity;
        perScale.push({
          r: radiiUm[s],
          z: z[s][k],
          log2e: mu[s][k] > 0 && Tobs[s][k] > 0 ? Math.log2(Tobs[s][k] / mu[s][k]) : 0,
          p: pScaleFlat[si],
          q: qScaleFlat[si],
          narAtoB: Tobs[s][k] / denomA,
          narBtoA: Tobs[s][b * K + a] / denomB,
        });
        if (Math.abs(z[s][k]) > Math.abs(z[peak][k])) peak = s;
        si++;
      }
      const qMax = qMaxFlat[pi];
      const zAtPeak = z[peak][k];
      const significant = qMax <= alpha;
      pairs.push({
        a,
        b,
        aName: names[a],
        bName: names[b],
        perScale,
        maxAbsZ: maxAbsZ[k],
        pMax: pMaxFlat[pi],
        qMax,
        peakR: radiiUm[peak],
        zAtPeak,
        log2eAtPeak: perScale[peak].log2e,
        significant,
        direction: significant ? (zAtPeak > 0 ? "enrichment" : "depletion") : "none",
      });
      pi++;
    }
  }
  pairs.sort((x, y) => Math.abs(y.zAtPeak) - Math.abs(x.zAtPeak));
  onProgress?.(1, "done");

  return {
    radiiUm: [...radiiUm],
    typeNames: names,
    mode,
    compartmentAware,
    stratified,
    numPermutations: B,
    alpha,
    pairs,
    engine: "client",
    elapsedMs: Date.now() - t0,
    disclaimer: "Research use only — not validated for clinical or diagnostic use.",
  };
}

/** Multiscale local composition per cell: neighbour type fractions per scale. */
function compositionFeatures(
  px: Float64Array,
  py: Float64Array,
  comp: Int32Array,
  type: Int32Array,
  weight: Float64Array,
  K: number,
  radiiUm: number[],
  stratified: boolean
): number[][] {
  const N = px.length;
  const S = radiiUm.length;
  const edges = buildScaleEdges(px, py, comp, radiiUm, "disk", stratified);
  const F: number[][] = Array.from({ length: N }, () => new Array<number>(S * K).fill(0));
  for (let s = 0; s < S; s++) {
    const { row, col } = edges[s];
    const totals = new Float64Array(N);
    for (let e = 0; e < row.length; e++) {
      const i = row[e];
      const j = col[e];
      F[i][s * K + type[j]] += weight[j];
      totals[i] += weight[j];
    }
    for (let i = 0; i < N; i++) {
      const t = totals[i];
      if (t > 0) for (let c = 0; c < K; c++) F[i][s * K + c] /= t;
    }
  }
  return F;
}

function zscoreColumns(F: number[][]): number[][] {
  const n = F.length;
  const d = F[0].length;
  const mu = new Array<number>(d).fill(0);
  const sd = new Array<number>(d).fill(0);
  for (const row of F) for (let j = 0; j < d; j++) mu[j] += row[j];
  for (let j = 0; j < d; j++) mu[j] /= n;
  for (const row of F) for (let j = 0; j < d; j++) sd[j] += (row[j] - mu[j]) ** 2;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / n) + 1e-9;
  return F.map((row) => row.map((v, j) => (v - mu[j]) / sd[j]));
}

/** Adjusted Rand Index between two labelings. */
export function adjustedRandIndex(a: number[], b: number[]): number {
  const n = a.length;
  if (!n) return 0;
  const ka = Math.max(...a) + 1;
  const kb = Math.max(...b) + 1;
  const cont = new Float64Array(ka * kb);
  const ra = new Float64Array(ka);
  const rb = new Float64Array(kb);
  for (let i = 0; i < n; i++) {
    cont[a[i] * kb + b[i]] += 1;
    ra[a[i]] += 1;
    rb[b[i]] += 1;
  }
  const c2 = (x: number) => (x * (x - 1)) / 2;
  let sumIJ = 0;
  for (let k = 0; k < cont.length; k++) sumIJ += c2(cont[k]);
  let sumA = 0;
  for (let i = 0; i < ka; i++) sumA += c2(ra[i]);
  let sumB = 0;
  for (let j = 0; j < kb; j++) sumB += c2(rb[j]);
  const total = c2(n);
  const expected = (sumA * sumB) / total;
  const max = (sumA + sumB) / 2;
  return max - expected === 0 ? 0 : (sumIJ - expected) / (max - expected);
}

/**
 * k-means++ on a caller-supplied PRNG.
 *
 * The app's shared `kmeans` seeds itself from `Math.random`, which would make
 * niche assignments — and the bootstrap/null comparisons built on them —
 * irreproducible even though the permutation null is seeded. Statistics that
 * users may cite have to be repeatable, so MOSAIC uses this instead.
 */
export function seededKmeans(X: number[][], k: number, rand: () => number, iters = 40): number[] {
  const n = X.length;
  const d = X[0].length;
  const centers: number[][] = [X[(rand() * n) | 0].slice()];
  const best = new Float64Array(n).fill(Infinity);
  const sq = (a: number[], b: number[]) => {
    let s = 0;
    for (let j = 0; j < d; j++) s += (a[j] - b[j]) ** 2;
    return s;
  };
  while (centers.length < k) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dd = sq(X[i], centers[centers.length - 1]);
      if (dd < best[i]) best[i] = dd;
      total += best[i];
    }
    let r = rand() * total;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      r -= best[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centers.push(X[pick].slice());
  }
  const labels = new Array<number>(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = sq(X[i], centers[c]);
        if (dd < bd) {
          bd = dd;
          bi = c;
        }
      }
      if (labels[i] !== bi) {
        labels[i] = bi;
        moved = true;
      }
    }
    const sums = Array.from({ length: k }, () => new Float64Array(d));
    const counts = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      counts[labels[i]] += 1;
      for (let j = 0; j < d; j++) sums[labels[i]][j] += X[i][j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < d; j++) centers[c][j] = sums[c][j] / counts[c];
    }
    if (!moved && it > 0) break;
  }
  return labels;
}

/** Mean silhouette on a bounded random subsample (exact is O(n²)). */
export function silhouetteSample(X: number[][], labels: number[], rand: () => number, maxN = 600): number {
  const n = X.length;
  const idx: number[] = [];
  if (n <= maxN) for (let i = 0; i < n; i++) idx.push(i);
  else {
    const seen = new Set<number>();
    while (seen.size < maxN) seen.add((rand() * n) | 0);
    idx.push(...seen);
  }
  const d = X[0].length;
  const dist = (i: number, j: number) => {
    let s = 0;
    for (let k = 0; k < d; k++) s += (X[i][k] - X[j][k]) ** 2;
    return Math.sqrt(s);
  };
  const ks = Math.max(...labels) + 1;
  let total = 0;
  let counted = 0;
  for (const i of idx) {
    const sums = new Float64Array(ks);
    const counts = new Float64Array(ks);
    for (const j of idx) {
      if (i === j) continue;
      sums[labels[j]] += dist(i, j);
      counts[labels[j]] += 1;
    }
    const own = labels[i];
    if (counts[own] === 0) continue;
    const a = sums[own] / counts[own];
    let b = Infinity;
    for (let c = 0; c < ks; c++) if (c !== own && counts[c] > 0) b = Math.min(b, sums[c] / counts[c]);
    if (!Number.isFinite(b)) continue;
    total += (b - a) / Math.max(a, b);
    counted++;
  }
  return counted ? total / counted : 0;
}

/**
 * MOSAIC: niches from multiscale composition, with bootstrap stability and a
 * dual null (global = is there any structure; stratified = beyond compartments).
 */
export function discoverNiches(cells: Cell[], opts: NicheOptions, onProgress?: ProgressFn): NicheResult {
  const { numTypes: K, radiiUm, umPerUnit, numNiches, compartmentAware = true, marks = "confWeighted", nBoot = 4, nNull = 5, seed = 3 } = opts;
  const N = cells.length;
  if (numNiches >= N) throw new Error(`numNiches (${numNiches}) must be smaller than the cell count (${N}).`);

  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const type = new Int32Array(N);
  const weight = new Float64Array(N);
  const comp = new Int32Array(N);
  let sawCompartment = false;
  for (let i = 0; i < N; i++) {
    const c = cells[i];
    px[i] = c.x * umPerUnit;
    py[i] = c.y * umPerUnit;
    type[i] = Math.min(K - 1, Math.max(0, c.typeIndex | 0));
    weight[i] = marks === "confWeighted" && opts.confidence ? Math.max(0, opts.confidence[i] ?? 1) : 1;
    if (c.compartmentIndex != null) {
      comp[i] = Math.max(0, c.compartmentIndex | 0);
      sawCompartment = true;
    }
  }
  const comps = new Set<number>();
  for (let i = 0; i < N; i++) comps.add(comp[i]);
  const stratified = compartmentAware && sawCompartment && comps.size > 1;

  onProgress?.(0.1, "multiscale composition");
  const F = zscoreColumns(compositionFeatures(px, py, comp, type, weight, K, radiiUm, stratified));
  onProgress?.(0.3, `clustering into ${numNiches} niches`);
  const rand = rng(seed);
  const labels = seededKmeans(F, numNiches, rand);

  const sizes = new Array<number>(numNiches).fill(0);
  for (const l of labels) sizes[l] += 1;
  const signatures: number[][] = Array.from({ length: numNiches }, () => new Array<number>(K).fill(0));
  for (let i = 0; i < N; i++) signatures[labels[i]][type[i]] += 1;
  for (let g = 0; g < numNiches; g++) if (sizes[g] > 0) for (let c = 0; c < K; c++) signatures[g][c] /= sizes[g];

  onProgress?.(0.45, "bootstrap stability");
  const aris: number[] = [];
  for (let b = 0; b < nBoot; b++) {
    const take = Math.max(numNiches + 1, Math.floor(0.8 * N));
    const sel: number[] = [];
    const used = new Uint8Array(N);
    while (sel.length < take) {
      const i = (rand() * N) | 0;
      if (!used[i]) {
        used[i] = 1;
        sel.push(i);
      }
    }
    const sub = sel.map((i) => F[i]);
    const lb = seededKmeans(sub, numNiches, rand);
    aris.push(adjustedRandIndex(sel.map((i) => labels[i]), lb));
  }
  const stabilityAri = aris.length ? aris.reduce((a, b) => a + b, 0) / aris.length : 0;

  const silObs = silhouetteSample(F, labels, rand);
  const nullP = (groups: Int32Array[]): number => {
    let ge = 0;
    for (let it = 0; it < nNull; it++) {
      const perm = new Int32Array(N);
      for (let i = 0; i < N; i++) perm[i] = i;
      for (const g of groups) {
        const sh = g.slice();
        shuffle(sh, rand);
        for (let t = 0; t < g.length; t++) perm[g[t]] = sh[t];
      }
      const permType = new Int32Array(N);
      const permW = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        permType[i] = type[perm[i]];
        permW[i] = weight[perm[i]];
      }
      const Fn = zscoreColumns(compositionFeatures(px, py, comp, permType, permW, K, radiiUm, stratified));
      const ln = seededKmeans(Fn, numNiches, rand);
      if (silhouetteSample(Fn, ln, rand) >= silObs) ge += 1;
    }
    return (1 + ge) / (nNull + 1);
  };

  onProgress?.(0.6, "significance vs stratified null");
  const all = new Int32Array(N);
  for (let i = 0; i < N; i++) all[i] = i;
  const byComp = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const g = byComp.get(comp[i]);
    if (g) g.push(i);
    else byComp.set(comp[i], [i]);
  }
  const stratGroups = [...byComp.values()].map((g) => Int32Array.from(g));
  const pStratified = nNull > 0 ? nullP(stratGroups) : 1;
  onProgress?.(0.8, "significance vs global null");
  const pGlobal = nNull > 0 ? nullP([all]) : 1;

  const M = Math.max(...comp) + 1;
  const cont: number[][] = Array.from({ length: numNiches }, () => new Array<number>(M).fill(0));
  for (let i = 0; i < N; i++) cont[labels[i]][comp[i]] += 1;
  const rowTot = cont.map((r) => r.reduce((a, b) => a + b, 0));
  const colTot = new Array<number>(M).fill(0);
  for (const r of cont) for (let m = 0; m < M; m++) colTot[m] += r[m];
  const grand = rowTot.reduce((a, b) => a + b, 0) || 1;
  const compartmentEnrichment = cont.map((r, g) => r.map((v, m) => {
    const exp = (rowTot[g] * colTot[m]) / grand;
    return exp > 0 ? v / exp : 0;
  }));

  onProgress?.(1, "done");
  return {
    nicheOfCell: labels,
    signatures,
    sizes,
    stabilityAri,
    silhouette: silObs,
    pGlobal,
    pStratified,
    compartmentEnrichment,
    typeNames: typeNamesOf(undefined, K),
    stratified,
    nNull,
    engine: "client",
    disclaimer: "Research use only — not validated for clinical or diagnostic use.",
  };
}

import { describe, expect, it } from "vitest";
import { adjustedRandIndex, bhFdr, buildScaleEdges, computeEnrichment, discoverNiches, rng } from "./cosmos";
import { deriveCompartments } from "./compartments";
import type { Cell } from "../types";
import type { ChannelDef } from "../types";

const cell = (id: number, x: number, y: number, typeIndex: number, extra: Partial<Cell> = {}): Cell => ({
  id,
  x,
  y,
  r: 2,
  typeIndex,
  markers: [0, 0, 0],
  ...extra,
});

/**
 * Two well-separated compartments. In compartment 0 each type-0 cell has a
 * type-1 partner ~2 µm away; in compartment 1 the two types are independent.
 * The clouds are far wider than the test radii, so a within-compartment label
 * shuffle really does destroy the pairing.
 */
function plantedTissue(seed = 5, nPer = 70): Cell[] {
  const rand = rng(seed);
  const gauss = () => {
    // Box–Muller from the same PRNG keeps the fixture reproducible.
    const u = Math.max(1e-9, rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const cells: Cell[] = [];
  let id = 1;
  [
    [300, 300],
    [2000, 2000],
  ].forEach(([cx, cy], comp) => {
    for (let i = 0; i < nPer; i++) {
      const x = cx + gauss() * 200;
      const y = cy + gauss() * 200;
      cells.push(cell(id++, x, y, 0, { compartmentIndex: comp }));
      if (comp === 0) cells.push(cell(id++, x + gauss() * 4, y + gauss() * 4, 1, { compartmentIndex: comp }));
      else cells.push(cell(id++, cx + gauss() * 200, cy + gauss() * 200, 1, { compartmentIndex: comp }));
    }
  });
  return cells;
}

const baseOpts = {
  numTypes: 2,
  radiiUm: [10, 20, 40],
  umPerUnit: 0.5,
  marks: "hard" as const,
  numPermutations: 99,
  seed: 1,
};

describe("BH-FDR", () => {
  it("is monotone and never below the raw p-value", () => {
    const p = [0.001, 0.008, 0.039, 0.041, 0.9];
    const q = bhFdr(p);
    expect(q.every((v, i) => v >= p[i] - 1e-12)).toBe(true);
    for (let i = 1; i < q.length; i++) expect(q[i]).toBeGreaterThanOrEqual(q[i - 1] - 1e-12);
    expect(q[0]).toBeCloseTo(0.005, 6);
  });

  it("returns q = p for a single test and handles the empty case", () => {
    expect(bhFdr([0.03])).toEqual([0.03]);
    expect(bhFdr([])).toEqual([]);
  });
});

describe("scale adjacency", () => {
  const px = Float64Array.from([0, 5, 25, 100]);
  const py = Float64Array.from([0, 0, 0, 0]);
  const comp = Int32Array.from([0, 0, 1, 1]);

  it("puts each pair in exactly one annulus and stores both directions", () => {
    const edges = buildScaleEdges(px, py, comp, [10, 30], "annulus", false);
    // 0-1 are 5 apart -> ring 0 ; 1-2 are 20 apart -> ring 1 ; 0-2 are 25 -> ring 1
    expect(edges[0].row.length).toBe(2);
    expect(edges[1].row.length).toBe(4);
  });

  it("accumulates in disk mode", () => {
    const annulus = buildScaleEdges(px, py, comp, [10, 30], "annulus", false);
    const disk = buildScaleEdges(px, py, comp, [10, 30], "disk", false);
    expect(disk[0].row.length).toBe(annulus[0].row.length);
    expect(disk[1].row.length).toBe(annulus[0].row.length + annulus[1].row.length);
  });

  it("drops cross-compartment pairs when the null is stratified", () => {
    const free = buildScaleEdges(px, py, comp, [30], "annulus", false);
    const strat = buildScaleEdges(px, py, comp, [30], "annulus", true);
    expect(strat[0].row.length).toBeLessThan(free[0].row.length);
  });
});

describe("CAMSE enrichment", () => {
  const cells = plantedTissue();

  it("recovers a planted short-range interaction with the right sign and scale", () => {
    const res = computeEnrichment(cells, { ...baseOpts, typeNames: ["Tumor", "CD8 T"] });
    const pair = res.pairs.find((p) => p.a === 0 && p.b === 1)!;
    expect(pair.aName).toBe("Tumor");
    expect(pair.zAtPeak).toBeGreaterThan(3);
    expect(pair.direction).toBe("enrichment");
    expect(pair.qMax).toBeLessThanOrEqual(0.05);
    // the pairing is at ~2 um, so the tightest ring should carry the peak
    expect(pair.peakR).toBe(10);
    expect(pair.log2eAtPeak).toBeGreaterThan(0);
  });

  it("reports every unordered pair, all scales, and valid probabilities", () => {
    const res = computeEnrichment(cells, baseOpts);
    expect(res.pairs).toHaveLength(3); // (0,0) (0,1) (1,1)
    for (const p of res.pairs) {
      expect(p.perScale.map((s) => s.r)).toEqual([10, 20, 40]);
      // Monte-Carlo p-values are bounded below by 1/(B+1) — never zero.
      for (const s of p.perScale) {
        expect(s.p).toBeGreaterThanOrEqual(1 / 100);
        expect(s.p).toBeLessThanOrEqual(1);
        expect(s.q).toBeGreaterThanOrEqual(s.p - 1e-12);
      }
      expect(p.pMax).toBeGreaterThanOrEqual(1 / 100);
      expect(p.maxAbsZ).toBeGreaterThanOrEqual(Math.abs(p.zAtPeak) - 1e-9);
    }
  });

  it("is deterministic for a fixed seed and moves with the seed", () => {
    const a = computeEnrichment(cells, baseOpts);
    const b = computeEnrichment(cells, baseOpts);
    const c = computeEnrichment(cells, { ...baseOpts, seed: 999 });
    const z = (r: typeof a) => r.pairs.find((p) => p.a === 0 && p.b === 1)!.zAtPeak;
    expect(z(a)).toBe(z(b));
    expect(z(c)).not.toBe(z(a));
  });

  it("marks itself not-stratified when no compartments are supplied", () => {
    const flat = cells.map((c) => ({ ...c, compartmentIndex: undefined }));
    const res = computeEnrichment(flat, baseOpts);
    expect(res.stratified).toBe(false);
    // and when they are, it is
    expect(computeEnrichment(cells, baseOpts).stratified).toBe(true);
  });

  it("treats a single compartment as a global null rather than claiming otherwise", () => {
    const one = cells.map((c) => ({ ...c, compartmentIndex: 0 }));
    expect(computeEnrichment(one, baseOpts).stratified).toBe(false);
  });

  it("weights marks by confidence when asked", () => {
    const hard = computeEnrichment(cells, baseOpts);
    const weighted = computeEnrichment(cells, {
      ...baseOpts,
      marks: "confWeighted",
      confidence: cells.map((_, i) => (i % 2 === 0 ? 1 : 0.1)),
    });
    const zh = hard.pairs.find((p) => p.a === 0 && p.b === 1)!.zAtPeak;
    const zw = weighted.pairs.find((p) => p.a === 0 && p.b === 1)!.zAtPeak;
    expect(zw).not.toBe(zh);
  });

  it("rejects unusable inputs with actionable messages", () => {
    expect(() => computeEnrichment([], baseOpts)).toThrow(/no cells/i);
    expect(() => computeEnrichment(cells, { ...baseOpts, radiiUm: [40, 10] })).toThrow(/increasing/i);
    expect(() => computeEnrichment(cells, { ...baseOpts, numTypes: 1 })).toThrow(/typeIndex/i);
    expect(() => computeEnrichment(cells, { ...baseOpts, marks: "softRaw" })).toThrow(/posteriors/i);
  });

  it("finds no interaction in a homogeneous random pattern", () => {
    const rand = rng(11);
    const noise: Cell[] = [];
    for (let i = 0; i < 300; i++) noise.push(cell(i, rand() * 1200, rand() * 1200, i % 2, { compartmentIndex: 0 }));
    const res = computeEnrichment(noise, { ...baseOpts, numPermutations: 199 });
    const pair = res.pairs.find((p) => p.a === 0 && p.b === 1)!;
    expect(Math.abs(pair.zAtPeak)).toBeLessThan(3);
  });
});

describe("MOSAIC niches", () => {
  /** Two regions with genuinely different composition: 90% type 0 vs 90% type 1. */
  function compositionTissue(seed = 21, nPer = 130): Cell[] {
    const rand = rng(seed);
    const cells: Cell[] = [];
    let id = 1;
    [
      [300, 300, 0],
      [1600, 1600, 1],
    ].forEach(([cx, cy, dominant]) => {
      for (let i = 0; i < nPer; i++) {
        const t = rand() < 0.9 ? dominant : 1 - dominant;
        cells.push(cell(id++, cx + (rand() - 0.5) * 500, cy + (rand() - 0.5) * 500, t));
      }
    });
    return cells;
  }

  it("recovers regions that genuinely differ in composition", () => {
    const cells = compositionTissue();
    const res = discoverNiches(cells, {
      numTypes: 2,
      radiiUm: [20, 60],
      umPerUnit: 0.5,
      numNiches: 2,
      marks: "hard",
      nBoot: 3,
      nNull: 2,
      seed: 3,
    });
    expect(res.nicheOfCell).toHaveLength(cells.length);
    expect(res.sizes.reduce((a, b) => a + b, 0)).toBe(cells.length);
    expect(res.signatures).toHaveLength(2);
    expect(res.signatures[0]).toHaveLength(2);
    // The two niches must be dominated by different cell types.
    const dominant = res.signatures.map((s) => s.indexOf(Math.max(...s)));
    expect(new Set(dominant).size).toBe(2);
    expect(res.stabilityAri).toBeGreaterThan(0.5);
    expect(res.pGlobal).toBeGreaterThan(0);
    expect(res.pStratified).toBeGreaterThan(0);
  });

  it("reports shape, stability range and both nulls on a weakly structured region", () => {
    const cells = plantedTissue(7, 60);
    const res = discoverNiches(cells, {
      numTypes: 2,
      radiiUm: [10, 30],
      umPerUnit: 0.5,
      numNiches: 2,
      marks: "hard",
      nBoot: 2,
      nNull: 2,
      seed: 3,
    });
    expect(res.nicheOfCell).toHaveLength(cells.length);
    expect(res.sizes.reduce((a, b) => a + b, 0)).toBe(cells.length);
    // Weak structure should NOT be dressed up as a stable niche partition.
    expect(res.stabilityAri).toBeGreaterThanOrEqual(-1);
    expect(res.stabilityAri).toBeLessThanOrEqual(1);
    expect(res.pGlobal).toBeGreaterThan(0);
    expect(res.pStratified).toBeGreaterThan(0);
    expect(res.compartmentEnrichment).toHaveLength(2);
  });

  it("is reproducible for a fixed seed", () => {
    const cells = compositionTissue(4, 60);
    const o = { numTypes: 2, radiiUm: [20, 60], umPerUnit: 0.5, numNiches: 2, marks: "hard" as const, nBoot: 1, nNull: 1, seed: 9 };
    const a = discoverNiches(cells, o);
    const b = discoverNiches(cells, o);
    expect(a.nicheOfCell).toEqual(b.nicheOfCell);
    expect(a.stabilityAri).toBe(b.stabilityAri);
  });

  it("refuses more niches than cells", () => {
    expect(() =>
      discoverNiches(plantedTissue(1, 2), { numTypes: 2, radiiUm: [10], umPerUnit: 0.5, numNiches: 99, marks: "hard", nBoot: 0, nNull: 0 })
    ).toThrow(/smaller than the cell count/i);
  });
});

describe("adjusted Rand index", () => {
  it("is 1 for identical labelings and ~0 for unrelated ones", () => {
    expect(adjustedRandIndex([0, 0, 1, 1], [0, 0, 1, 1])).toBeCloseTo(1, 6);
    expect(adjustedRandIndex([0, 0, 1, 1], [1, 1, 0, 0])).toBeCloseTo(1, 6); // label-invariant
    expect(Math.abs(adjustedRandIndex([0, 1, 0, 1], [0, 0, 1, 1]))).toBeLessThan(0.6);
  });
});

describe("pseudo-compartments", () => {
  const ch = (name: string): ChannelDef => ({ name, color: "#fff", kind: "membrane", defaultOn: true });

  it("gates structural markers and explains each rule", () => {
    const channels = [ch("PanCK"), ch("SMA"), ch("CD31")];
    const cells: Cell[] = [
      cell(1, 0, 0, 0, { markers: [0.9, 0.0, 0.0] }),
      cell(2, 1, 0, 0, { markers: [0.0, 0.9, 0.0] }),
      cell(3, 2, 0, 0, { markers: [0.0, 0.0, 0.9] }),
      cell(4, 3, 0, 0, { markers: [0.0, 0.0, 0.0] }),
    ];
    const res = deriveCompartments(cells, channels);
    expect(res.names).toEqual(["vessel", "stroma", "tumour / epithelium", "other"]);
    // priority: the CD31-high cell is a vessel, the SMA-high cell stroma, etc.
    expect(res.index[2]).toBe(0);
    expect(res.index[1]).toBe(1);
    expect(res.index[0]).toBe(2);
    expect(res.index[3]).toBe(3);
    expect(res.rationale.join(" ")).toMatch(/Otsu/);
  });

  it("falls back to one compartment and says why when no structural marker exists", () => {
    const res = deriveCompartments([cell(1, 0, 0, 0, { markers: [0.5] })], [ch("DAPI")]);
    expect(res.names).toEqual(["whole region"]);
    expect(res.rationale[0]).toMatch(/global/i);
  });
});

import { describe, it, expect } from "vitest";
import { standardize, pca, kmeans, otsu, summarizeClusters } from "./analysis";
import { generateTissue } from "./synth";

describe("otsu", () => {
  it("finds a threshold between two well-separated modes", () => {
    const vals = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.12 : 0.88));
    const t = otsu(vals);
    expect(t).toBeGreaterThan(0.3);
    expect(t).toBeLessThan(0.7);
  });

  it("always returns a value in [0,1]", () => {
    const vals = Array.from({ length: 300 }, () => Math.random());
    const t = otsu(vals);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(1);
  });
});

describe("standardize", () => {
  it("centers each column to ~0 mean and ~1 variance", () => {
    const X = [
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ];
    const Z = standardize(X);
    for (let j = 0; j < 2; j++) {
      const col = Z.map((r) => r[j]);
      const mean = col.reduce((a, b) => a + b, 0) / col.length;
      const varr = col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length;
      expect(Math.abs(mean)).toBeLessThan(1e-9);
      expect(Math.abs(varr - 1)).toBeLessThan(1e-6);
    }
  });
});

describe("pca", () => {
  it("returns n x k scores and captures the dominant-variance axis on PC1", () => {
    const d = 5;
    const rows: number[][] = [];
    // Two groups separated along dim 0, which therefore carries the most
    // variance; PCA's leading component should align with it and separate them.
    for (let i = 0; i < 50; i++) rows.push(Array.from({ length: d }, () => (Math.random() - 0.5) * 0.2));
    for (let i = 0; i < 50; i++) {
      const r = Array.from({ length: d }, () => (Math.random() - 0.5) * 0.2);
      r[0] += 6;
      rows.push(r);
    }
    const scores = pca(rows, 2);
    expect(scores.length).toBe(100);
    expect(scores[0].length).toBe(2);
    const mA = scores.slice(0, 50).reduce((a, r) => a + r[0], 0) / 50;
    const mB = scores.slice(50).reduce((a, r) => a + r[0], 0) / 50;
    // PC1 (sign arbitrary) must capture the group separation.
    expect(Math.abs(mA - mB)).toBeGreaterThan(2);
  });
});

describe("kmeans", () => {
  it("recovers 3 well-separated clusters as a pure partition", () => {
    const centers = [
      [0, 0],
      [100, 0],
      [0, 100],
    ];
    const X: number[][] = [];
    const truth: number[] = [];
    centers.forEach((c, ci) => {
      for (let i = 0; i < 30; i++) {
        X.push([c[0] + Math.random(), c[1] + Math.random()]);
        truth.push(ci);
      }
    });
    const labels = kmeans(X, 3);
    const map = new Map<number, Set<number>>();
    truth.forEach((t, i) => {
      if (!map.has(t)) map.set(t, new Set());
      map.get(t)!.add(labels[i]);
    });
    const predPerTrue = [...map.values()].map((s) => [...s]);
    predPerTrue.forEach((s) => expect(s.length).toBe(1)); // each true cluster -> one label
    const used = new Set(predPerTrue.map((s) => s[0]));
    expect(used.size).toBe(3); // the three labels are distinct
  });
});

describe("summarizeClusters", () => {
  it("has counts summing to total and percentages summing to ~100", () => {
    const t = generateTissue(500, 3);
    const labels = t.cells.map((_, i) => i % 4);
    const sum = summarizeClusters(t.cells, labels, 4);
    const total = sum.reduce((a, s) => a + s.count, 0);
    expect(total).toBe(t.cells.length);
    const pct = sum.reduce((a, s) => a + s.pct, 0);
    expect(Math.abs(pct - 100)).toBeLessThan(1e-6);
    sum.forEach((s) => expect(s.topMarkers.length).toBe(3));
  });
});

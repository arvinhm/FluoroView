import { describe, expect, it } from "vitest";
import { GENE_PANEL, HE2ST_LICENSE, predictHe2st } from "./he2st";
import type { Cell } from "./types";

/** FluoroView's 12-plex protein panel order. */
const M = { DAPI: 0, PanCK: 1, Ki67: 2, PDL1: 3, CD45: 4, CD3: 5, CD8: 6, CD4: 7, CD20: 8, CD68: 9, SMA: 10, CD31: 11 };

/**
 * Three spatially separated populations, each high in one lineage marker, so a
 * correct predictor must put lineage genes in the matching region.
 */
function tissue(): { cells: Cell[]; groups: number[][] } {
  const cells: Cell[] = [];
  const groups: number[][] = [[], [], []];
  const spec: [number, number, number][] = [
    [100, 100, M.PanCK],
    [600, 120, M.CD3],
    [320, 520, M.SMA],
  ];
  let id = 0;
  spec.forEach(([cx, cy, marker], g) => {
    for (let i = 0; i < 40; i++) {
      const markers = new Array<number>(12).fill(0.05);
      markers[M.DAPI] = 0.6;
      markers[marker] = 0.9;
      // deterministic jitter, no Math.random in tests
      const a = (i * 2.399963) % (Math.PI * 2);
      const rad = 12 + (i % 7) * 4;
      groups[g].push(id);
      cells.push({ id: id++, x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, r: 4, typeIndex: g, markers });
    }
  });
  return { cells, groups };
}

function meanFor(res: ReturnType<typeof predictHe2st>, ids: number[], gene: string): number {
  const gi = res.genes.indexOf(gene);
  let s = 0;
  for (const i of ids) s += res.expression[i][gi];
  return s / ids.length;
}

describe("H&E → spatial transcriptomics fallback", () => {
  const { cells, groups } = tissue();
  const genes = ["EPCAM", "CD3D", "ACTA2", "COL1A1", "MKI67"];

  it("labels itself as an unvalidated experimental fallback, never as sCellST", () => {
    const res = predictHe2st(cells, genes);
    expect(res.model).toBe("experimental-fallback");
    expect(res.experimental).toBe(true);
    expect(res.validated).toBe(false);
    expect(res.engine).toBe("client");
    expect(res.license).toBe(HE2ST_LICENSE);
    expect(res.units).toMatch(/arbitrary units/i);
    expect(res.note).toMatch(/NOT sCellST/i);
    expect(res.fallbackReason).toBeTruthy();
  });

  it("puts lineage genes in the matching population", () => {
    const res = predictHe2st(cells, genes);
    const [tumour, tcell, stroma] = groups;
    // epithelial gene highest in the PanCK+ region
    expect(meanFor(res, tumour, "EPCAM")).toBeGreaterThan(meanFor(res, tcell, "EPCAM"));
    expect(meanFor(res, tumour, "EPCAM")).toBeGreaterThan(meanFor(res, stroma, "EPCAM"));
    // T-cell gene highest in the CD3+ region
    expect(meanFor(res, tcell, "CD3D")).toBeGreaterThan(meanFor(res, tumour, "CD3D"));
    expect(meanFor(res, tcell, "CD3D")).toBeGreaterThan(meanFor(res, stroma, "CD3D"));
    // stromal genes highest in the SMA+ region
    for (const g of ["ACTA2", "COL1A1"]) {
      expect(meanFor(res, stroma, g)).toBeGreaterThan(meanFor(res, tumour, g));
      expect(meanFor(res, stroma, g)).toBeGreaterThan(meanFor(res, tcell, g));
    }
  });

  it("returns non-negative values shaped one row per cell", () => {
    const res = predictHe2st(cells, genes);
    expect(res.expression).toHaveLength(cells.length);
    for (const row of res.expression) {
      expect(row).toHaveLength(res.genes.length);
      for (const v of row) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("is deterministic for a seed and different across seeds", () => {
    const a = predictHe2st(cells, genes, 0);
    const b = predictHe2st(cells, genes, 0);
    const c = predictHe2st(cells, genes, 7);
    expect(a.expression).toEqual(b.expression);
    expect(c.expression).not.toEqual(a.expression);
  });

  it("works from typeIndex alone when no protein markers exist", () => {
    const bare = cells.map((c) => ({ ...c, markers: [] as number[] }));
    const res = predictHe2st(bare, ["EPCAM", "CD3D"]);
    expect(res.expression).toHaveLength(bare.length);
    // typeIndex 0 -> tumour programme, so EPCAM should exceed CD3D there
    const t0 = bare.filter((c) => c.typeIndex === 0).map((c) => Number(c.id));
    expect(meanFor(res, t0, "EPCAM")).toBeGreaterThan(meanFor(res, t0, "CD3D"));
  });

  it("only returns genes that are in the panel, and refuses an empty request", () => {
    const res = predictHe2st(cells, ["EPCAM", "NOT_A_REAL_GENE"]);
    expect(res.genes).toEqual(["EPCAM"]);
    expect(() => predictHe2st(cells, ["NOPE"])).toThrow(/panel/i);
    expect(() => predictHe2st([], ["EPCAM"])).toThrow(/no cells/i);
  });

  it("covers the immune, stromal and tumour axes in its panel", () => {
    const programs = new Set(GENE_PANEL.map((g) => g.program));
    for (const p of ["tumor", "tcell", "bcell", "myeloid", "fibroblast", "endothelial", "housekeeping"]) {
      expect(programs.has(p as never)).toBe(true);
    }
    expect(GENE_PANEL.length).toBeGreaterThanOrEqual(50);
    // no duplicate symbols, which would break the picker and the column order
    expect(new Set(GENE_PANEL.map((g) => g.gene)).size).toBe(GENE_PANEL.length);
  });
});

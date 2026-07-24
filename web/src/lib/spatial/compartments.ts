/**
 * Tissue compartments for CoSMoS.
 *
 * CoSMoS conditions on tissue architecture, so it needs a compartment label per
 * cell. Real compartments come from a tissue-segmentation map; in a fluorescence
 * panel we can derive *pseudo*-compartments by Otsu-gating structural markers
 * (endothelial → vessel, fibroblast/stroma → stroma, epithelial/tumour → tumour).
 *
 * These are explicitly approximations, and the UI says so: the alternative is a
 * global null, which is exactly the assumption CoSMoS exists to improve on.
 */
import { otsu } from "../analysis";
import type { Cell, ChannelDef } from "../types";

export interface CompartmentAssignment {
  /** compartmentIndex per cell, aligned to `cells` */
  index: number[];
  names: string[];
  /** how each compartment was decided, for the UI to show verbatim */
  rationale: string[];
  /** cell counts per compartment */
  sizes: number[];
}

/** Marker-name patterns that mark a structural compartment, most specific first. */
const RULES: { name: string; test: RegExp; kinds?: string[] }[] = [
  { name: "vessel", test: /\b(cd31|pecam|erg|vwf|endothel)/i },
  { name: "stroma", test: /\b(sma|acta2|vimentin|collagen|col1|fap|pdgfr|fibro|ecm)/i },
  { name: "tumour / epithelium", test: /\b(panck|cytokeratin|ck\d|ecad|cdh1|epcam|epitheli)/i },
];

export const SINGLE_COMPARTMENT: CompartmentAssignment = {
  index: [],
  names: ["whole region"],
  rationale: ["One compartment — the permutation null is global, not architecture-aware."],
  sizes: [],
};

/**
 * Assign pseudo-compartments by gating structural channels at their Otsu
 * threshold. Cells that pass none land in "other", and priority runs
 * vessel → stroma → epithelium so the most specific structure wins.
 */
export function deriveCompartments(cells: Cell[], channels: ChannelDef[]): CompartmentAssignment {
  if (!cells.length) return { ...SINGLE_COMPARTMENT, index: [], sizes: [] };

  const picks: { rule: string; channel: number; name: string; threshold: number }[] = [];
  for (const rule of RULES) {
    const ci = channels.findIndex((c) => rule.test.test(c.name));
    if (ci < 0) continue;
    const values = cells.map((c) => c.markers[ci] ?? 0);
    const spread = Math.max(...values) - Math.min(...values);
    // A flat channel carries no gating information; Otsu would split noise.
    if (spread < 1e-3) continue;
    picks.push({ rule: rule.name, channel: ci, name: channels[ci].name, threshold: otsu(values) });
  }

  if (!picks.length) {
    return {
      index: new Array(cells.length).fill(0),
      names: ["whole region"],
      rationale: ["No structural marker (CD31 / SMA / PanCK-like) in this panel, so every cell shares one compartment and the null is global."],
      sizes: [cells.length],
    };
  }

  const names = [...picks.map((p) => p.rule), "other"];
  const index = cells.map((cell) => {
    for (let p = 0; p < picks.length; p++) {
      if ((cell.markers[picks[p].channel] ?? 0) > picks[p].threshold) return p;
    }
    return picks.length;
  });
  const sizes = new Array<number>(names.length).fill(0);
  for (const i of index) sizes[i] += 1;
  const rationale = picks.map((p) => `${p.rule}: ${p.name} > ${p.threshold.toFixed(3)} (Otsu)`);
  rationale.push("other: passed no structural gate");
  return { index, names, rationale, sizes };
}

/** Compartments from per-cell cluster assignments (data-driven, not marker rules). */
export function compartmentsFromClusters(cells: Cell[], k: number): CompartmentAssignment {
  const index = cells.map((c) => Math.max(0, Math.min(k - 1, c.cluster ?? 0)));
  const sizes = new Array<number>(k).fill(0);
  for (const i of index) sizes[i] += 1;
  return {
    index,
    names: Array.from({ length: k }, (_, i) => `cluster ${i}`),
    rationale: ["Compartments are the clusters from the Analysis tab — data-driven regions rather than annotated tissue classes."],
    sizes,
  };
}

/** Attach compartment indices without mutating the store's cells. */
export function withCompartments(cells: Cell[], index: number[]): Cell[] {
  if (!index.length) return cells;
  return cells.map((c, i) => ({ ...c, compartmentIndex: index[i] ?? 0 }));
}

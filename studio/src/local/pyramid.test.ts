import { describe, expect, it } from "vitest";
import type { Histogram } from "../api/types";
import raw from "./fixtures/reference.json";
import { accumulate, bandRowsFor, downsample2, histogramSummary, planLevels } from "./pyramid";
import type { Pixels } from "./source";

const ref = raw as unknown as {
  image: number[][];
  levels: number[][][];
  histogram16: Histogram;
  histogram_wide: Histogram;
  histogram_all: Histogram;
  plans: Record<string, [number, number][]>;
  band_rows: Record<string, number>;
};

describe("zoom levels", () => {
  it("are planned as the engine plans them", () => {
    for (const [size, want] of Object.entries(ref.plans)) {
      const [w, h] = size.split("x").map(Number);
      expect(planLevels(w!, h!).map((lv) => [lv.width, lv.height])).toEqual(want);
    }
  });

  it("are built in bands of the engine's height", () => {
    for (const [n, rows] of Object.entries(ref.band_rows)) expect(bandRowsFor(Number(n))).toBe(rows);
  });

  it("match the engine's pixel for pixel, odd edges included", () => {
    let a: Pixels = Uint16Array.from(ref.image.flat());
    let w = ref.image[0]!.length;
    let h = ref.image.length;
    for (const want of ref.levels.slice(1)) {
      ({ data: a, width: w, height: h } = downsample2(a, w, h));
      expect([w, h]).toEqual([want[0]!.length, want.length]);
      expect(Array.from(a)).toEqual(want.flat());
    }
  });
});

describe("histograms", () => {
  const counts = new Float64Array(65536);
  accumulate(Uint16Array.from(ref.image.flat()), counts);

  it("are summarised as the engine summarises them", () => {
    expect(histogramSummary(counts, 4000, 16, true)).toEqual(ref.histogram16);
    expect(histogramSummary(counts, null, 256, false)).toEqual(ref.histogram_wide);
    expect(histogramSummary(counts, 2000, 65536, true)).toEqual(ref.histogram_all);
  });

  it("are empty before any pixel is counted", () => {
    expect(histogramSummary(new Float64Array(256), null, 256, false)).toEqual({
      complete: false, total: 0, counts: [], range: [0, 1], min: 0, max: 0, saturated: 0, saturation: null, percentiles: {},
    });
  });
});

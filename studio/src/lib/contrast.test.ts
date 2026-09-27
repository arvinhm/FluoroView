import { describe, expect, it } from "vitest";
import type { Histogram } from "../api/types";
import { autoWindow, dtypeMax } from "./contrast";

const base: Histogram = {
  complete: true, total: 100, counts: [], range: [0, 65521], min: 10, max: 65520, saturated: 3, saturation: 65520,
  percentiles: { "0.5": 1363, "99.8": 59696 },
};

describe("autoWindow", () => {
  it("uses the exact percentiles", () => {
    expect(autoWindow(base)).toEqual([1363, 59696]);
  });

  it("falls back to min/max and never returns an empty window", () => {
    expect(autoWindow({ ...base, percentiles: {} })).toEqual([10, 65520]);
    expect(autoWindow({ ...base, percentiles: { "0.5": 7, "99.8": 7 }, max: 7 })).toEqual([7, 8]);
  });

  it("knows the dtype range", () => {
    expect(dtypeMax("<u2")).toBe(65535);
    expect(dtypeMax("|u1")).toBe(255);
  });
});

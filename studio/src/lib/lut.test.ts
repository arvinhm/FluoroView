import { describe, expect, it } from "vitest";
import { channelLut, colormapAt, type CurvePoint, IDENTITY_CURVE, lookup, toneCurve } from "./lut";

const CURVE: CurvePoint[] = [[0, 0], [0.25, 0.5], [0.75, 0.6], [1, 1]];
const SAMPLES = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1.0];
// Shared with engine/tests/test_luts.py: both implementations must give these numbers.
const EXPECTED = [0.0, 0.236855, 0.5, 0.543763, 0.555277, 0.565102, 0.6, 0.810719, 1.0];

describe("tone curves match the engine", () => {
  it("pass through their points without overshoot", () => {
    const f = toneCurve(CURVE);
    SAMPLES.forEach((t, i) => expect(f(t)).toBeCloseTo(EXPECTED[i]!, 6));
    let last = -1;
    for (let i = 0; i <= 2000; i++) {
      const y = f(i / 2000);
      expect(y).toBeGreaterThanOrEqual(last - 1e-12);
      last = y;
    }
    const peak = toneCurve([[0, 0], [0.5, 1], [1, 0]]);
    expect(peak(0.25)).toBeCloseTo(0.625, 6);
    expect(peak(0.5)).toBe(1);
    expect(toneCurve(IDENTITY_CURVE)(0.37)).toBe(0.37);
  });

  it("colour maps and channel tables use the engine's numbers", () => {
    expect(colormapAt("grays", 0.5)).toEqual([0.5, 0.5, 0.5]);
    const fire = colormapAt("fire", 0.5);
    [0.919608, 0.266667, 0.009804].forEach((v, i) => expect(fire[i]).toBeCloseTo(v, 6));
    const table = channelLut({ color: "#00ff00", lut: "color", invert: false, curve: CURVE, intensity: 0.5 }, 5);
    [0, 0.25, 0.277638, 0.3, 0.5].forEach((v, i) => expect(table[3 * i + 1]).toBeCloseTo(v, 6));
    const inverted = channelLut({ color: "#ffffff", lut: "grays", invert: true, curve: IDENTITY_CURVE, intensity: 1 });
    expect(lookup(inverted, 0)[0]).toBeCloseTo(1, 6);
    expect(lookup(inverted, 1)[0]).toBeCloseTo(0, 6);
  });
});

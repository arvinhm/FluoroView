import { describe, expect, it } from "vitest";
import { niceStep, niceTicks } from "./ticks";

describe("axis ticks", () => {
  it("rounds steps to 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(100, 4)).toBe(50);
    expect(niceStep(65535, 4)).toBe(20000);
    expect(niceStep(1, 4)).toBe(0.5);
    expect(niceStep(0, 4)).toBe(1);
  });

  it("covers the range with round numbers", () => {
    expect(niceTicks(0, 1000, 4)).toEqual([0, 500, 1000]);
    expect(niceTicks(-0.2, 1, 4)).toEqual([0, 0.5, 1]);
    expect(niceTicks(-1, 1, 4)).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(niceTicks(0, 412.3, 5)).toEqual([0, 100, 200, 300, 400]);
  });
});

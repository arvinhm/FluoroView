import { describe, expect, it } from "vitest";
import { flight, flightDuration } from "./flight";

const vp = { width: 1920, height: 1080, dpr: 2 };

describe("flight", () => {
  it("starts and ends exactly at the two views", () => {
    const a = { cx: 1000, cy: 2000, scale: 0.05 };
    const b = { cx: 20000, cy: 9000, scale: 1 };
    const f = flight(a, b, vp);
    const s0 = f.at(0);
    const s1 = f.at(1);
    expect(s0.cx).toBeCloseTo(a.cx, 6);
    expect(s0.scale).toBeCloseTo(a.scale, 9);
    expect(s1.cx).toBeCloseTo(b.cx, 4);
    expect(s1.cy).toBeCloseTo(b.cy, 4);
    expect(s1.scale).toBeCloseTo(b.scale, 6);
  });

  it("zooms out mid-way when travelling far at high zoom", () => {
    const a = { cx: 1000, cy: 1000, scale: 2 };
    const b = { cx: 26000, cy: 16000, scale: 2 };
    const mid = flight(a, b, vp).at(0.5);
    expect(mid.scale).toBeLessThan(0.2);
  });

  it("handles a pure zoom without travel", () => {
    const f = flight({ cx: 5, cy: 5, scale: 0.1 }, { cx: 5, cy: 5, scale: 3.2 }, vp);
    expect(f.at(1).scale).toBeCloseTo(3.2, 6);
    expect(f.at(0.5).scale).toBeCloseTo(Math.sqrt(0.1 * 3.2), 6);
  });

  it("keeps durations brief", () => {
    const short = flight({ cx: 0, cy: 0, scale: 1 }, { cx: 10, cy: 0, scale: 1 }, vp);
    const long = flight({ cx: 0, cy: 0, scale: 4 }, { cx: 27000, cy: 17000, scale: 4 }, vp);
    expect(flightDuration(short)).toBe(250);
    expect(flightDuration(long)).toBe(700);
  });
});

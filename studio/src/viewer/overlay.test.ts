import { describe, expect, it } from "vitest";
import { placeBeside } from "./overlay";

const bounds = { w: 1000, h: 800 };

describe("card placement", () => {
  it("prefers the right of the region", () => {
    expect(placeBeside({ x: 100, y: 100, w: 100, h: 100 }, 200, 150, bounds, [])).toEqual({ x: 214, y: 100 });
  });

  it("moves to the left when the right edge is too close", () => {
    expect(placeBeside({ x: 700, y: 100, w: 200, h: 100 }, 200, 150, bounds, [])).toEqual({ x: 486, y: 100 });
  });

  it("avoids covering other regions", () => {
    const target = { x: 700, y: 100, w: 200, h: 100 };
    const neighbour = { x: 480, y: 90, w: 150, h: 120 };
    expect(placeBeside(target, 200, 150, bounds, [neighbour])).toEqual({ x: 700, y: 214 });
  });

  it("never covers the region itself when there is room around it", () => {
    const big = { x: 50, y: 50, w: 900, h: 500 };
    const p = placeBeside(big, 200, 150, bounds, []);
    expect(p.y).toBe(564);
  });
});

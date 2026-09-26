import { describe, expect, it } from "vitest";
import { galleryLayout, lerpRect, panelShrink } from "./gallery";

describe("galleryLayout", () => {
  it("fills a wide canvas with a wide grid", () => {
    const cells = galleryLayout(5, 1900, 1100, 2);
    expect(cells).toHaveLength(5);
    const cols = new Set(cells.map((c) => c.x)).size;
    expect(cols).toBe(3);
    for (const c of cells) {
      expect(c.x + c.width).toBeLessThanOrEqual(1900);
      expect(c.y + c.height).toBeLessThanOrEqual(1100);
    }
  });

  it("stacks two panels on a tall canvas and places four in a square", () => {
    expect(new Set(galleryLayout(2, 400, 1600, 2).map((c) => c.x)).size).toBe(1);
    expect(new Set(galleryLayout(2, 1600, 400, 2).map((c) => c.y)).size).toBe(1);
    const four = galleryLayout(4, 1600, 1000, 2);
    expect(new Set(four.map((c) => c.x)).size).toBe(2);
    expect(new Set(four.map((c) => c.y)).size).toBe(2);
  });

  it("interpolates rectangles and shrink factors", () => {
    const full = { x: 0, y: 0, width: 1000, height: 500 };
    const cell = { x: 500, y: 250, width: 500, height: 250 };
    expect(lerpRect(full, cell, 0.5)).toEqual({ x: 250, y: 125, width: 750, height: 375 });
    expect(panelShrink(cell, 1000, 500)).toBe(0.5);
  });
});

import { describe, it, expect } from "vitest";
import { generateTissue, buildChannelMaps, M, CELL_TYPES } from "./synth";

describe("generateTissue", () => {
  it("is deterministic for a fixed seed", () => {
    const a = generateTissue(300, 42);
    const b = generateTissue(300, 42);
    expect(a.cells.length).toBe(300);
    expect(b.cells.length).toBe(300);
    for (let i = 0; i < 300; i += 37) {
      expect(a.cells[i].x).toBe(b.cells[i].x);
      expect(a.cells[i].y).toBe(b.cells[i].y);
      expect(a.cells[i].typeIndex).toBe(b.cells[i].typeIndex);
      expect(a.cells[i].markers).toEqual(b.cells[i].markers);
    }
  });

  it("differs for a different seed", () => {
    const a = generateTissue(300, 1);
    const b = generateTissue(300, 2);
    const identical = a.cells.every((c, i) => c.x === b.cells[i].x && c.y === b.cells[i].y);
    expect(identical).toBe(false);
  });

  it("produces markers of length M in [0,1] and valid cell types", () => {
    const t = generateTissue(250, 7);
    for (const c of t.cells) {
      expect(c.markers.length).toBe(M);
      for (const v of c.markers) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(c.typeIndex).toBeGreaterThanOrEqual(0);
      expect(c.typeIndex).toBeLessThan(CELL_TYPES.length);
    }
  });
});

describe("buildChannelMaps", () => {
  it("builds one 8-bit intensity map per marker at the target size", () => {
    const t = generateTissue(200, 7);
    const maps = buildChannelMaps(t, 240);
    expect(maps.maps.length).toBe(M);
    expect(maps.width).toBeGreaterThan(0);
    expect(maps.height).toBeGreaterThan(0);
    expect(maps.maps[0]).toBeInstanceOf(Uint8ClampedArray);
    expect(maps.maps[0].length).toBe(maps.width * maps.height);
  });
});

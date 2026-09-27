import { describe, expect, it } from "vitest";
import type { Point, Region } from "../api/types";
import {
  area, constrainAngle, contains, dragBox, handles, hasArea, hitRegion, moveHandle, outlineDistance, regionBox,
  regionContains, ringKinds, simplify,
} from "./geometry";

function region(id: string, shape: Region["shape"], points: Point[]): Region {
  return { id, name: id, shape, points, color: "#ffffff", created: "", modified: "", author: null };
}

describe("containment matches the engine's pixel-centre rule", () => {
  it("rectangles are half-open", () => {
    const pts: Point[] = [[10, 10], [20, 30]];
    expect(contains("rectangle", pts, 10.5, 10.5)).toBe(true);
    expect(contains("rectangle", pts, 19.5, 29.5)).toBe(true);
    expect(contains("rectangle", pts, 20.5, 15.5)).toBe(false);
    expect(contains("rectangle", [[20, 30], [10, 10]], 15, 20)).toBe(true);
  });

  it("ellipses are analytic", () => {
    const pts: Point[] = [[0, 0], [20, 10]];
    expect(contains("ellipse", pts, 10, 5)).toBe(true);
    expect(contains("ellipse", pts, 19.9, 5)).toBe(true);
    expect(contains("ellipse", pts, 1, 1)).toBe(false);
  });

  it("polygons use the even-odd rule", () => {
    const star = [0, 2, 4, 1, 3].map((k): Point => {
      const a = Math.PI / 2 + (2 * Math.PI * k) / 5;
      return [10 * Math.cos(a), 10 * Math.sin(a)];
    });
    expect(contains("polygon", star, 0, 0)).toBe(false);
    expect(contains("polygon", star, 0, 8)).toBe(true);
    expect(contains("polygon", star, 0, -8)).toBe(false);
    const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(contains("freehand", square, 5, 5)).toBe(true);
    expect(contains("freehand", square, 11, 5)).toBe(false);
  });
});

describe("hit testing", () => {
  const big = region("big", "rectangle", [[0, 0], [100, 100]]);
  const small = region("small", "ellipse", [[40, 40], [60, 60]]);

  it("prefers the smallest region containing the point", () => {
    expect(hitRegion([big, small], 50, 50, 1)).toBe("small");
    expect(hitRegion([small, big], 50, 50, 1)).toBe("small");
    expect(hitRegion([big, small], 10, 10, 1)).toBe("big");
    expect(hitRegion([big, small], 150, 150, 1)).toBeNull();
  });

  it("an outline within tolerance wins over an interior", () => {
    expect(hitRegion([big, small], 50, 39.5, 1)).toBe("small");
    expect(hitRegion([big, small], 100.5, 50, 1)).toBe("big");
    expect(outlineDistance("rectangle", big.points, 50, 50)).toBe(50);
  });
});

describe("regions with rings", () => {
  const donut: Region = {
    ...region("donut", "polygon", [[0, 0], [100, 0], [100, 100], [0, 100]]),
    rings: [[[30, 30], [70, 30], [70, 70], [30, 70]], [[150, 0], [170, 0], [170, 20], [150, 20]]],
  };

  it("holes are outside and extra parts inside, as the engine rasterizes them", () => {
    expect(regionContains(donut, 10, 10)).toBe(true);
    expect(regionContains(donut, 50, 50)).toBe(false);
    expect(regionContains(donut, 160, 10)).toBe(true);
    expect(regionContains(donut, 120, 10)).toBe(false);
    expect(ringKinds(donut)).toEqual({ holes: 1, parts: 2 });
  });

  it("boxes, hits and handles account for the rings", () => {
    expect(regionBox(donut)).toEqual([0, 0, 170, 100]);
    expect(hitRegion([donut], 50, 50, 1)).toBeNull();
    expect(hitRegion([donut], 30.5, 50, 1)).toBe("donut");
    expect(hitRegion([donut], 160, 10, 1)).toBe("donut");
    expect(handles(donut)).toEqual([]);
  });
});

describe("editing", () => {
  it("drags boxes on whole pixels, square and from the centre", () => {
    expect(dragBox([10.4, 10.6], [20.2, 15.7], false, false)).toEqual([[10, 11], [20, 16]]);
    expect(dragBox([10, 10], [20, 14], true, false)).toEqual([[10, 10], [20, 20]]);
    expect(dragBox([10, 10], [4, 12], true, false)).toEqual([[10, 10], [4, 16]]);
    expect(dragBox([10, 10], [14, 13], false, true)).toEqual([[6, 7], [14, 13]]);
  });

  it("moves a box corner against the opposite corner", () => {
    const r = region("r", "rectangle", [[10, 10], [20, 20]]);
    expect(handles(r)).toHaveLength(4);
    expect(moveHandle(r, 2, [30.2, 25.8], false)).toEqual([[10, 10], [30, 26]]);
    expect(moveHandle(r, 0, [0, 0], false)).toEqual([[20, 20], [0, 0]]);
  });

  it("edits polygon vertices; freehand shapes have no vertex handles", () => {
    const p = region("p", "polygon", [[0, 0], [10, 0], [5, 8]]);
    expect(moveHandle(p, 2, [5, 12], false)).toEqual([[0, 0], [10, 0], [5, 12]]);
    expect(handles(region("f", "freehand", [[0, 0], [10, 0], [5, 8]]))).toEqual([]);
  });

  it("rejects shapes without area", () => {
    expect(hasArea("rectangle", [[5, 5], [5, 9]])).toBe(false);
    expect(hasArea("ellipse", [[5, 5], [6, 6]])).toBe(true);
    expect(hasArea("polygon", [[0, 0], [5, 5], [10, 10]])).toBe(false);
    expect(area("polygon", [[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(100);
  });
});

describe("paths", () => {
  it("simplify keeps corners and drops collinear points", () => {
    const pts: Point[] = [[0, 0], [1, 0.01], [2, 0], [3, 0], [3, 1], [3, 2], [3, 3]];
    expect(simplify(pts, 0.1)).toEqual([[0, 0], [3, 0], [3, 3]]);
  });

  it("constrains lines to 45° steps", () => {
    const [x, y] = constrainAngle([0, 0], [10, 1]);
    expect(x).toBeCloseTo(Math.hypot(10, 1));
    expect(y).toBeCloseTo(0);
  });
});

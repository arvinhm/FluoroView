import { describe, expect, it } from "vitest";
import { chooseLevel, clampCenter, fit, formatLength, imageToScreen, scaleBar, screenToImage, visibleTiles, zoomAt } from "./camera";

const vp = { width: 1920, height: 1770, dpr: 2 };
const W = 27643;
const H = 17482;

describe("camera", () => {
  it("round-trips screen and image coordinates", () => {
    const cam = { cx: 15760, cy: 4885, scale: 1 };
    const [sx, sy] = imageToScreen(cam, vp, 15000, 5000);
    const [x, y] = screenToImage(cam, vp, sx, sy);
    expect(x).toBeCloseTo(15000);
    expect(y).toBeCloseTo(5000);
  });

  it("keeps the point under the cursor fixed while zooming", () => {
    const cam = fit(W, H, vp);
    const before = screenToImage(cam, vp, 300, 400);
    const after = screenToImage(zoomAt(cam, vp, 300, 400, 3.7, W, H), vp, 300, 400);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });

  it("fits the whole image with a margin", () => {
    const cam = fit(W, H, vp);
    expect(W * cam.scale).toBeLessThan(vp.width);
    expect(H * cam.scale).toBeLessThanOrEqual(vp.height);
  });

  it("never lets the view centre leave the image", () => {
    expect(clampCenter({ cx: -500, cy: 1e9, scale: 1 }, W, H)).toEqual({ cx: 0, cy: H, scale: 1 });
  });

  it("chooses the coarsest level that is still at least device resolution", () => {
    expect(chooseLevel(4, 7)).toBe(0);
    expect(chooseLevel(1, 7)).toBe(0);
    expect(chooseLevel(0.5, 7)).toBe(1);
    expect(chooseLevel(0.3, 7)).toBe(1);
    expect(chooseLevel(0.26, 7)).toBe(1);
    expect(chooseLevel(0.25, 7)).toBe(2);
    expect(chooseLevel(0.001, 7)).toBe(6);
  });

  it("lists the tiles covering the viewport", () => {
    const r = visibleTiles({ cx: 512, cy: 512, scale: 1 }, { width: 1024, height: 1024, dpr: 1 }, 0, W, H, 512);
    expect(r).toEqual({ tx0: 0, tx1: 2, ty0: 0, ty1: 2 });
    expect(visibleTiles({ cx: -5000, cy: -5000, scale: 1 }, { width: 100, height: 100, dpr: 1 }, 0, W, H, 512)).toBeNull();
  });
});

describe("scale bar", () => {
  it("uses 1-2-5 lengths that fit the target width", () => {
    const bar = scaleBar(1.3156, 120);
    expect(bar.lengthUm).toBe(100);
    expect(bar.cssPx).toBeCloseTo(76.01, 1);
    expect(scaleBar(10, 120).label).toBe("1 mm");
    expect(scaleBar(0.05, 120).label).toBe("5 µm");
  });

  it("formats lengths", () => {
    expect(formatLength(1500)).toBe("1.5 mm");
    expect(formatLength(0.5)).toBe("500 nm");
    expect(formatLength(200)).toBe("200 µm");
  });
});

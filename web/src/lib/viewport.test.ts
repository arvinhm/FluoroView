import { describe, expect, it } from "vitest";
import type { ChannelMaps } from "./synth";
import { buildChannelMaps, generateTissue } from "./synth";
import { fitRect } from "./compositor";
import {
  clampPan,
  computeContentExtent,
  contentInViewport,
  extentRect,
  fitView,
  fullExtent,
  nearestContent,
  viewportNorm,
} from "./viewport";

/** A map with signal only inside [x0,x1)x[y0,y1) — a stand-in for tissue in a
 *  mostly empty slide. */
function mapWithBlock(w: number, h: number, x0: number, y0: number, x1: number, y1: number, value = 200): ChannelMaps {
  const a = new Uint8ClampedArray(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = value;
  return { width: w, height: h, scale: 1, maps: [a] };
}

/** Diagonal band, like the bundled multiplex scan. */
function diagonalMap(w: number, h: number, halfWidth = 0.12): ChannelMaps {
  const a = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.abs(y / h - (1 - x / w));
      if (d < halfWidth) a[y * w + x] = 180;
    }
  }
  return { width: w, height: h, scale: 1, maps: [a] };
}

describe("computeContentExtent", () => {
  it("finds the bounding box of the signal, not the canvas", () => {
    const e = computeContentExtent(mapWithBlock(400, 400, 200, 300, 280, 380), { stride: 1 });
    expect(e.full).toBe(false);
    // 64x64 grid over 400px => ~6.25px bins; the block spans x 200..280, y 300..380
    expect(e.x0).toBeCloseTo(0.5, 1);
    expect(e.x1).toBeCloseTo(0.7, 1);
    expect(e.y0).toBeCloseTo(0.75, 1);
    expect(e.y1).toBeCloseTo(0.95, 1);
    expect(e.coverage).toBeLessThan(0.1);
  });

  it("falls back to the full image when signal is everywhere (bright-field/H&E)", () => {
    const bright = mapWithBlock(200, 200, 0, 0, 200, 200, 240);
    expect(computeContentExtent(bright, { stride: 1 }).full).toBe(true);
  });

  it("falls back to the full image when there is no signal at all", () => {
    expect(computeContentExtent(mapWithBlock(200, 200, 0, 0, 0, 0)).full).toBe(true);
    expect(computeContentExtent(null).full).toBe(true);
  });

  it("rejects isolated hot pixels", () => {
    const a = new Uint8ClampedArray(400 * 400);
    a[123 * 400 + 77] = 255;
    a[300 * 400 + 300] = 255;
    const e = computeContentExtent({ width: 400, height: 400, scale: 1, maps: [a] }, { stride: 1 });
    expect(e.full).toBe(true); // nothing passed the per-bin fill threshold
  });

  it("treats the synthetic demo as full-frame content (its cells fill the canvas)", () => {
    const maps = buildChannelMaps(generateTissue(4200, 7), 1200);
    const e = computeContentExtent(maps);
    expect(e.full).toBe(true);
    // …so it keeps the exact pre-existing full-image fit
    const v = fitView(e, maps.width, maps.height, 900, 600);
    expect(v.zoom).toBeCloseTo(1, 6);
    expect(v.panX).toBeCloseTo(0, 6);
  });

  it("keeps a diagonal band sparse — its bbox is nearly the whole image but most bins are empty", () => {
    const e = computeContentExtent(diagonalMap(340, 220), { stride: 1 });
    expect(e.full).toBe(false);
    expect(e.x1 - e.x0).toBeGreaterThan(0.9); // bbox spans the image…
    expect(e.coverage).toBeLessThan(0.45); // …but the occupancy grid knows better
  });
});

describe("fitView", () => {
  it("reproduces the plain full-image fit when everything is content", () => {
    const v = fitView(fullExtent(), 800, 600, 400, 300, { margin: 0 });
    expect(v.zoom).toBeCloseTo(1, 6);
    expect(v.panX).toBeCloseTo(0, 6);
    expect(v.panY).toBeCloseTo(0, 6);
  });

  it("frames a small block of tissue so it lands in the middle of the canvas", () => {
    const e = computeContentExtent(mapWithBlock(400, 400, 300, 300, 360, 360), { stride: 1 });
    const cw = 600;
    const ch = 400;
    const v = fitView(e, 400, 400, cw, ch, { margin: 0.03 });
    const rect = fitRect(400, 400, { ...v, canvasW: cw, canvasH: ch });
    const r = extentRect(e, 400, 400);
    const midX = rect.x + (r.x + r.w / 2) * rect.s;
    const midY = rect.y + (r.y + r.h / 2) * rect.s;
    expect(midX).toBeCloseTo(cw / 2, 4);
    expect(midY).toBeCloseTo(ch / 2, 4);
    // and it is magnified, since the tissue is a small part of the image
    expect(v.zoom).toBeGreaterThan(3);
  });

  it("respects the zoom clamp", () => {
    const e = computeContentExtent(mapWithBlock(4000, 4000, 2000, 2000, 2010, 2010), { stride: 1 });
    const v = fitView(e, 4000, 4000, 500, 500, { zoomMax: 12 });
    expect(v.zoom).toBeLessThanOrEqual(12);
  });
});

describe("clampPan", () => {
  const e = computeContentExtent(mapWithBlock(1000, 1000, 100, 100, 400, 400), { stride: 1 });
  const imgW = 1000;
  const imgH = 1000;
  const cw = 500;
  const ch = 400;

  const visibleContentPx = (panX: number, panY: number, zoom: number) => {
    const rect = fitRect(imgW, imgH, { zoom, panX, panY, canvasW: cw, canvasH: ch });
    const r = extentRect(e, imgW, imgH);
    const x0 = rect.x + r.x * rect.s;
    const x1 = rect.x + (r.x + r.w) * rect.s;
    const y0 = rect.y + r.y * rect.s;
    const y1 = rect.y + (r.y + r.h) * rect.s;
    return {
      w: Math.max(0, Math.min(cw, x1) - Math.max(0, x0)),
      h: Math.max(0, Math.min(ch, y1) - Math.max(0, y0)),
    };
  };

  it("leaves a reasonable view untouched", () => {
    const v = fitView(e, imgW, imgH, cw, ch);
    const c = clampPan(v, e, imgW, imgH, cw, ch);
    expect(c.panX).toBeCloseTo(v.panX, 6);
    expect(c.panY).toBeCloseTo(v.panY, 6);
  });

  it("stops an absurd pan from carrying the data off screen", () => {
    for (const pan of [-99999, -5000, 5000, 99999]) {
      const c = clampPan({ zoom: 6, panX: pan, panY: pan }, e, imgW, imgH, cw, ch);
      const vis = visibleContentPx(c.panX, c.panY, 6);
      expect(vis.w).toBeGreaterThan(0);
      expect(vis.h).toBeGreaterThan(0);
    }
  });

  it("keeps at least the requested fraction of the content on screen", () => {
    const keepFrac = 0.22;
    const c = clampPan({ zoom: 4, panX: -1e6, panY: 1e6 }, e, imgW, imgH, cw, ch, keepFrac);
    const rect = fitRect(imgW, imgH, { zoom: 4, panX: c.panX, panY: c.panY, canvasW: cw, canvasH: ch });
    const r = extentRect(e, imgW, imgH);
    const contentW = r.w * rect.s;
    const contentH = r.h * rect.s;
    const vis = visibleContentPx(c.panX, c.panY, 4);
    expect(vis.w).toBeGreaterThanOrEqual(Math.min(contentW, cw) * keepFrac - 0.5);
    expect(vis.h).toBeGreaterThanOrEqual(Math.min(contentH, ch) * keepFrac - 0.5);
  });

  it("does not fight a full-image extent at fit zoom", () => {
    const full = fullExtent();
    const c = clampPan({ zoom: 1, panX: 0, panY: 0 }, full, imgW, imgH, cw, ch);
    expect(c.panX).toBeCloseTo(0, 6);
    expect(c.panY).toBeCloseTo(0, 6);
  });
});

describe("contentInViewport / nearestContent", () => {
  const e = computeContentExtent(diagonalMap(340, 220), { stride: 1 });

  it("reports true for the whole slide and false for an empty corner", () => {
    expect(contentInViewport(e, { x0: 0, y0: 0, x1: 1, y1: 1 })).toBe(true);
    // top-left corner of a bottom-left→top-right diagonal band is empty
    expect(contentInViewport(e, { x0: 0.01, y0: 0.01, x1: 0.12, y1: 0.12 })).toBe(false);
    // on the band itself
    expect(contentInViewport(e, { x0: 0.45, y0: 0.45, x1: 0.55, y1: 0.55 })).toBe(true);
  });

  it("reports false when the viewport is entirely outside the image", () => {
    expect(contentInViewport(e, { x0: 1.4, y0: 0.2, x1: 2.2, y1: 0.6 })).toBe(false);
    expect(contentInViewport(fullExtent(), { x0: -3, y0: -3, x1: -1, y1: -1 })).toBe(false);
  });

  it("finds a genuinely occupied bin to recenter on", () => {
    const t = nearestContent(e, 0.02, 0.02);
    expect(contentInViewport(e, { x0: t.x - 0.01, y0: t.y - 0.01, x1: t.x + 0.01, y1: t.y + 0.01 })).toBe(true);
  });
});

describe("viewportNorm", () => {
  it("describes the whole image at fit and a sub-rectangle when zoomed", () => {
    const full = viewportNorm(800, 800, { zoom: 1, panX: 0, panY: 0, canvasW: 400, canvasH: 400 });
    expect(full.x0).toBeCloseTo(0, 6);
    expect(full.x1).toBeCloseTo(1, 6);
    const zoomed = viewportNorm(800, 800, { zoom: 4, panX: 0, panY: 0, canvasW: 400, canvasH: 400 });
    expect(zoomed.x1 - zoomed.x0).toBeCloseTo(0.25, 6);
    expect((zoomed.x0 + zoomed.x1) / 2).toBeCloseTo(0.5, 6);
  });
});

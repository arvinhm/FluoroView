/**
 * View maths. World coordinates are full-resolution image pixels. `scale` is device pixels per
 * image pixel, so 100% zoom shows one image pixel per physical screen pixel on any display.
 */

export interface Camera {
  cx: number;
  cy: number;
  scale: number;
}

export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

export interface TileRange {
  tx0: number;
  tx1: number;
  ty0: number;
  ty1: number;
}

export const MIN_SCALE_FACTOR = 0.5;
export const MAX_SCALE = 64;

export function screenToImage(cam: Camera, vp: Viewport, sx: number, sy: number): [number, number] {
  return [cam.cx + (sx - vp.width / 2) / cam.scale, cam.cy + (sy - vp.height / 2) / cam.scale];
}

export function imageToScreen(cam: Camera, vp: Viewport, x: number, y: number): [number, number] {
  return [(x - cam.cx) * cam.scale + vp.width / 2, (y - cam.cy) * cam.scale + vp.height / 2];
}

export function fitScale(imageW: number, imageH: number, vp: Viewport, margin = 0.04): number {
  return Math.min(vp.width / imageW, vp.height / imageH) * (1 - 2 * margin);
}

export function fit(imageW: number, imageH: number, vp: Viewport): Camera {
  return { cx: imageW / 2, cy: imageH / 2, scale: fitScale(imageW, imageH, vp) };
}

export function clampScale(scale: number, imageW: number, imageH: number, vp: Viewport): number {
  const min = fitScale(imageW, imageH, vp) * MIN_SCALE_FACTOR;
  return Math.min(MAX_SCALE, Math.max(min, scale));
}

/** Zoom by `factor`, keeping the image point under screen position (sx, sy) fixed. */
export function zoomAt(cam: Camera, vp: Viewport, sx: number, sy: number, factor: number, imageW: number,
  imageH: number): Camera {
  const scale = clampScale(cam.scale * factor, imageW, imageH, vp);
  const [ix, iy] = screenToImage(cam, vp, sx, sy);
  return clampCenter({ cx: ix - (sx - vp.width / 2) / scale, cy: iy - (sy - vp.height / 2) / scale, scale },
    imageW, imageH);
}

/** Keep the view centre on the image so the scan cannot be lost off screen. */
export function clampCenter(cam: Camera, imageW: number, imageH: number): Camera {
  return { ...cam, cx: Math.min(imageW, Math.max(0, cam.cx)), cy: Math.min(imageH, Math.max(0, cam.cy)) };
}

/** Coarsest pyramid level whose pixels are still no larger than a device pixel. */
export function chooseLevel(scale: number, nLevels: number): number {
  if (scale >= 1) return 0;
  return Math.max(0, Math.min(nLevels - 1, Math.floor(Math.log2(1 / scale))));
}

export function visibleTiles(cam: Camera, vp: Viewport, level: number, levelW: number, levelH: number,
  tile: number, margin = 0): TileRange | null {
  const f = 2 ** level;
  const halfW = vp.width / 2 / cam.scale;
  const halfH = vp.height / 2 / cam.scale;
  const x0 = (cam.cx - halfW) / f;
  const x1 = (cam.cx + halfW) / f;
  const y0 = (cam.cy - halfH) / f;
  const y1 = (cam.cy + halfH) / f;
  const nx = Math.ceil(levelW / tile);
  const ny = Math.ceil(levelH / tile);
  const r = {
    tx0: Math.max(0, Math.floor(x0 / tile) - margin),
    tx1: Math.min(nx - 1, Math.floor(x1 / tile) + margin),
    ty0: Math.max(0, Math.floor(y0 / tile) - margin),
    ty1: Math.min(ny - 1, Math.floor(y1 / tile) + margin),
  };
  return r.tx0 > r.tx1 || r.ty0 > r.ty1 ? null : r;
}

export interface ScaleBar {
  lengthUm: number;
  cssPx: number;
  label: string;
}

/** Largest 1-2-5 length that fits in `targetCss` CSS pixels. */
export function scaleBar(umPerCssPx: number, targetCss = 120): ScaleBar {
  const raw = umPerCssPx * targetCss;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const nice = [5, 2, 1].map((n) => n * pow).find((v) => v <= raw) ?? pow;
  return { lengthUm: nice, cssPx: nice / umPerCssPx, label: formatLength(nice) };
}

export function formatLength(um: number): string {
  if (um >= 1000) return `${+(um / 1000).toPrecision(3)} mm`;
  if (um < 1) return `${+(um * 1000).toPrecision(3)} nm`;
  return `${+um.toPrecision(3)} µm`;
}

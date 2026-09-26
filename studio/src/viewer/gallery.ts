import type { Camera } from "./camera";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Grid of `n` equal cells in a `width` x `height` canvas. Each cell shows the full field of view
 * scaled down, so the grid chosen is the one that shrinks the view least.
 */
export function galleryLayout(n: number, width: number, height: number, gap: number): Rect[] {
  let best = { cols: 1, rows: n, k: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = (width - gap * (cols - 1)) / cols;
    const h = (height - gap * (rows - 1)) / rows;
    const k = Math.min(w / width, h / height);
    if (k > best.k) best = { cols, rows, k };
  }
  const { cols, rows } = best;
  const w = (width - gap * (cols - 1)) / cols;
  const h = (height - gap * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => ({
    x: Math.round((i % cols) * (w + gap)),
    y: Math.round(Math.floor(i / cols) * (h + gap)),
    width: Math.round(w),
    height: Math.round(h),
  }));
}

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: Math.round(a.x + (b.x - a.x) * t),
    y: Math.round(a.y + (b.y - a.y) * t),
    width: Math.max(1, Math.round(a.width + (b.width - a.width) * t)),
    height: Math.max(1, Math.round(a.height + (b.height - a.height) * t)),
  };
}

/** How much a panel shrinks the shared view so the whole field of view still fits inside it. */
export function panelShrink(panel: Rect, width: number, height: number): number {
  return Math.min(panel.width / width, panel.height / height);
}

export function panelCamera(cam: Camera, panel: Rect, width: number, height: number): Camera {
  return { ...cam, scale: cam.scale * panelShrink(panel, width, height) };
}

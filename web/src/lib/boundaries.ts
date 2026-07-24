import type { BoundaryCell } from "./types";

/**
 * Parse the packed per-cell contour file produced by
 * `web/scripts/generate_pyramid.py`.
 *
 * Layout (little-endian):
 *   u32  count
 *   repeated `count` times:
 *     u32  id
 *     u16  npts
 *     npts * (u16 x, u16 y)   // full-resolution image pixel coords
 *
 * Vector polygons stay razor-sharp at any zoom (unlike the old raster overlay),
 * and are extracted from the FULL-RES label mask so the outlines are pixel-exact.
 */
export function parseBoundaries(buf: ArrayBuffer): BoundaryCell[] {
  const dv = new DataView(buf);
  let o = 0;
  const count = dv.getUint32(o, true);
  o += 4;
  const cells: BoundaryCell[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const id = dv.getUint32(o, true);
    o += 4;
    const n = dv.getUint16(o, true);
    o += 2;
    const path: [number, number][] = new Array(n);
    for (let p = 0; p < n; p++) {
      const x = dv.getUint16(o, true);
      o += 2;
      const y = dv.getUint16(o, true);
      o += 2;
      path[p] = [x, y];
    }
    cells[i] = { id, path };
  }
  return cells;
}

/** Bounding box per cell, used for viewport culling / spatial indexing. */
export interface BoundaryIndex {
  cells: BoundaryCell[];
  bbox: Float32Array; // [minx,miny,maxx,maxy] * n
}

export function indexBoundaries(cells: BoundaryCell[]): BoundaryIndex {
  const bbox = new Float32Array(cells.length * 4);
  for (let i = 0; i < cells.length; i++) {
    let minx = Infinity,
      miny = Infinity,
      maxx = -Infinity,
      maxy = -Infinity;
    for (const [x, y] of cells[i].path) {
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
    bbox[i * 4] = minx;
    bbox[i * 4 + 1] = miny;
    bbox[i * 4 + 2] = maxx;
    bbox[i * 4 + 3] = maxy;
  }
  return { cells, bbox };
}

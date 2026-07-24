import { fromArrayBuffer } from "geotiff";
import type { Cell } from "./types";
import type { ChannelMaps } from "./synth";

export interface DecodedMask {
  width: number;
  height: number;
  labels: ArrayLike<number>;
}

/** Decode a single-band label/segmentation TIFF (QuPath/CellProfiler/ImageJ). */
export async function decodeLabelTiff(file: File): Promise<DecodedMask> {
  const buf = await file.arrayBuffer();
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters({ samples: [0] });
  const labels = rasters[0] as ArrayLike<number>;
  if (!labels || labels.length !== width * height) throw new Error("Unexpected mask raster size");
  return { width, height, labels };
}

/**
 * Convert an integer label mask into Cell[] (one cell per non-zero label),
 * computing centroids + areas and sampling the current channel maps at each
 * centroid so downstream analysis/phenotyping works on the imported cells.
 */
export function labelsToCells(mask: DecodedMask, maps: ChannelMaps): Cell[] {
  const { width: mw, height: mh, labels } = mask;
  const sumX = new Map<number, number>();
  const sumY = new Map<number, number>();
  const cnt = new Map<number, number>();
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const lab = labels[y * mw + x];
      if (!lab) continue;
      sumX.set(lab, (sumX.get(lab) ?? 0) + x);
      sumY.set(lab, (sumY.get(lab) ?? 0) + y);
      cnt.set(lab, (cnt.get(lab) ?? 0) + 1);
    }
  }
  const sx = maps.width / mw; // mask px -> image px
  const sy = maps.height / mh;
  const scale = maps.scale || 1; // image px -> tissue units
  const nCh = maps.maps.length;
  const cells: Cell[] = [];
  for (const [lab, n] of cnt) {
    const cxImg = (sumX.get(lab)! / n) * sx;
    const cyImg = (sumY.get(lab)! / n) * sy;
    const px = Math.min(maps.width - 1, Math.max(0, Math.round(cxImg)));
    const py = Math.min(maps.height - 1, Math.max(0, Math.round(cyImg)));
    const at = py * maps.width + px;
    const markers: number[] = [];
    for (let c = 0; c < nCh; c++) markers.push(maps.maps[c][at] / 255);
    cells.push({
      id: lab,
      x: cxImg / scale,
      y: cyImg / scale,
      r: Math.max(2, Math.sqrt((n * sx * sy) / Math.PI) / scale),
      typeIndex: 0,
      markers,
    });
  }
  return cells;
}

import type { Cell, ChannelDef, Tissue } from "./types";
import type { ChannelMaps } from "./synth";
import type { DatasetDef } from "./datasets";

const slug = (n: string) => n.toLowerCase().replace(/\s+/g, "_");

/** Resolve a data URL relative to the Vite base (works at root or a subpath). */
function dataUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || "./";
  return `${base}${base.endsWith("/") ? "" : "/"}${rel}`.replace(/([^:])\/\/+/g, "$1/");
}

/** Load an <img> and wait for it to decode; returns null if it isn't available. */
async function loadImage(url: string): Promise<HTMLImageElement | null> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

async function decodeGray(url: string): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  // Grayscale PNGs decode with R=G=B; take the red channel (fall back to luma).
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    gray[i] = r === g && g === b ? r : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { w, h, data: gray };
}

export interface LoadedDataset {
  tissue: Tissue;
  maps: ChannelMaps;
  channels: ChannelDef[];
  /** Precomputed true cell-boundary overlay (from the real label mask), or null. */
  boundaries: HTMLImageElement | null;
}

interface RawCell {
  id: number;
  x: number;
  y: number;
  area: number;
}

export async function loadRealDataset(ds: DatasetDef): Promise<LoadedDataset> {
  if (!ds.basePath) throw new Error(`Dataset ${ds.id} has no basePath`);
  const base = ds.basePath;

  // (a) per-channel PNGs -> single-channel intensity maps for the compositor
  const decoded = await Promise.all(ds.channels.map((c) => decodeGray(dataUrl(`${base}/${slug(c.name)}.png`))));
  const w = decoded[0].w;
  const h = decoded[0].h;
  for (const d of decoded) {
    if (d.w !== w || d.h !== h) throw new Error("Channel images have mismatched dimensions");
  }
  const maps: ChannelMaps = { width: w, height: h, scale: 1, maps: decoded.map((d) => d.data) };

  // (a2) precomputed TRUE cell-boundary overlay derived from the real label mask
  // (skimage find_boundaries, upsampled for crisp per-cell outlines). Optional —
  // the viewer falls back to marker dots if it's absent.
  const boundaries = await loadImage(dataUrl(`${base}/boundaries.png`));

  // (b) cells.json (already in PNG pixel space) -> Cell[] for overlay + analysis.
  const res = await fetch(dataUrl(`${base}/cells.json`));
  if (!res.ok) throw new Error(`Failed to fetch cells.json (${res.status})`);
  const raw = (await res.json()) as RawCell[];
  const cells: Cell[] = raw.map((c) => {
    const px = Math.min(w - 1, Math.max(0, Math.round(c.x)));
    const py = Math.min(h - 1, Math.max(0, Math.round(c.y)));
    // Sample each channel's intensity as the MEAN over the cell's footprint
    // (a small window sized from its area) rather than a single centroid pixel.
    // This is less noisy and yields meaningful per-ROI mean±SEM bars.
    const rad = Math.max(0, Math.min(3, Math.round(Math.sqrt(Math.max(c.area, 1) / Math.PI))));
    const markers = decoded.map((d) => {
      let sum = 0;
      let cnt = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = px + dx;
          if (xx < 0 || xx >= w) continue;
          sum += d.data[yy * w + xx];
          cnt++;
        }
      }
      return cnt ? sum / cnt / 255 : 0;
    });
    return {
      id: c.id,
      x: c.x,
      y: c.y,
      r: Math.max(2, Math.sqrt(Math.max(c.area, 1) / Math.PI)),
      typeIndex: 0,
      markers,
    };
  });

  return { tissue: { width: w, height: h, cells, seed: 0 }, maps, channels: ds.channels, boundaries };
}

import type { Cell, ChannelDef, Tissue } from "./types";
import type { ChannelMaps } from "./synth";
import type { DatasetDef } from "./datasets";

const slug = (n: string) => n.toLowerCase().replace(/\s+/g, "_");

/** Resolve a data URL relative to the Vite base (works at root or a subpath). */
function dataUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || "./";
  return `${base}${base.endsWith("/") ? "" : "/"}${rel}`.replace(/([^:])\/\/+/g, "$1/");
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

  // (b) cells.json (already in PNG pixel space) -> Cell[] for overlay + analysis.
  const res = await fetch(dataUrl(`${base}/cells.json`));
  if (!res.ok) throw new Error(`Failed to fetch cells.json (${res.status})`);
  const raw = (await res.json()) as RawCell[];
  const cells: Cell[] = raw.map((c) => {
    const px = Math.min(w - 1, Math.max(0, Math.round(c.x)));
    const py = Math.min(h - 1, Math.max(0, Math.round(c.y)));
    const at = py * w + px;
    return {
      id: c.id,
      x: c.x,
      y: c.y,
      r: Math.max(2, Math.sqrt(Math.max(c.area, 1) / Math.PI)),
      typeIndex: 0,
      // Sample each channel's intensity at the cell centroid as its expression.
      markers: decoded.map((d) => d.data[at] / 255),
    };
  });

  return { tissue: { width: w, height: h, cells, seed: 0 }, maps, channels: ds.channels };
}

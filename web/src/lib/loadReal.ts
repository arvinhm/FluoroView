import type { BoundaryCell, Cell, ChannelDef, ChannelHistogram, ScanMeta, Tissue } from "./types";
import type { ChannelMaps } from "./synth";
import type { DatasetDef } from "./datasets";
import { parseBoundaries } from "./boundaries";
import { loadVivImage, type VivLoader } from "./vivSource";

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
  /** bounded preview intensity maps (for CPU ROI-crop export); scale = arrayPx/worldPx */
  maps: ChannelMaps;
  channels: ChannelDef[];
  /** legacy raster boundary overlay — null for the pyramid path (we use vectors) */
  boundaries: HTMLImageElement | null;
  /** vector cell outlines from the full-res mask (razor-sharp at any zoom) */
  boundaryPolys: BoundaryCell[] | null;
  /** Viv multiscale pixel-source array for the full-res pyramid image */
  imageSource: VivLoader | null;
  scanMeta: ScanMeta | null;
  /** Per-channel histograms measured at load time (uploads); else computed lazily. */
  channelStats?: ChannelHistogram[] | null;
  /** True when the dataset ships/carries a real segmentation. */
  segmented?: boolean;
  segMethod?: string;
  /** Honest, user-facing notes about how this dataset was loaded. */
  notes?: string[];
}

interface RawCell {
  id: number;
  x: number;
  y: number;
  area: number;
  markers?: number[];
}

/**
 * Load the REAL multiplex scan as a full-resolution pyramid (Viv) + vector cell
 * boundaries. The world coordinate space is the scan's native pixel space
 * (e.g. 8500x5625). `cells.json` carries per-channel mean intensities baked at
 * full resolution, so analysis is accurate without holding 240 MB of pixels.
 */
export async function loadRealDataset(ds: DatasetDef): Promise<LoadedDataset> {
  if (!ds.basePath) throw new Error(`Dataset ${ds.id} has no basePath`);
  const base = ds.basePath;

  const metaRes = await fetch(dataUrl(`${base}/scan.meta.json`));
  if (!metaRes.ok) throw new Error(`Failed to fetch scan.meta.json (${metaRes.status})`);
  const meta = (await metaRes.json()) as ScanMeta;

  // (a) bounded per-channel preview arrays for CPU ROI-crop export.
  const decoded = await Promise.all(ds.channels.map((c) => decodeGray(dataUrl(`${base}/${slug(c.name)}.png`))));
  const pw = decoded[0].w;
  const ph = decoded[0].h;
  const maps: ChannelMaps = { width: pw, height: ph, scale: meta.previewScale || pw / meta.width, maps: decoded.map((d) => d.data) };

  // (b) cells.json — full-res centroids/area + baked per-channel mean intensity.
  const cRes = await fetch(dataUrl(`${base}/cells.json`));
  if (!cRes.ok) throw new Error(`Failed to fetch cells.json (${cRes.status})`);
  const raw = (await cRes.json()) as RawCell[];
  const nCh = ds.channels.length;
  const cells: Cell[] = raw.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    r: Math.max(2, Math.sqrt(Math.max(c.area, 1) / Math.PI)),
    typeIndex: 0,
    markers: c.markers && c.markers.length === nCh ? c.markers : new Array(nCh).fill(0),
  }));

  // (c) vector cell boundaries (full-res, simplified) + (d) Viv pyramid.
  // geotiff (inside Viv) needs an ABSOLUTE URL — resolve the (relative) Vite
  // base against the document location.
  const imageUrl = new URL(dataUrl(`${base}/${meta.image}`), window.location.href).href;
  const [bBuf, viv] = await Promise.all([
    fetch(dataUrl(`${base}/${meta.boundaries}`)).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch ${meta.boundaries} (${r.status})`);
      return r.arrayBuffer();
    }),
    loadVivImage(imageUrl),
  ]);
  const boundaryPolys = parseBoundaries(bBuf);

  return {
    tissue: { width: meta.width, height: meta.height, cells, seed: 0 },
    maps,
    channels: ds.channels,
    boundaries: null,
    boundaryPolys,
    imageSource: viv.loader,
    scanMeta: meta,
  };
}

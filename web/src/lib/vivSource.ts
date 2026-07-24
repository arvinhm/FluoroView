// Viv's PixelSource type isn't cleanly re-exported and the library is heavy
// (pulls deck.gl + luma.gl + geotiff). We keep it OUT of the eager bundle by
// dynamically importing it here — `loadReal` is in the store's static graph, so
// a top-level `import` would bloat the entry chunk by ~1 MB. This is a
// deliberate code-splitting boundary, not an ordinary inline import.

export interface VivPixelData {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface VivRasterSelection {
  selection: Record<string, number>;
  signal?: AbortSignal;
}

export interface VivTileSelection extends VivRasterSelection {
  x: number;
  y: number;
}

export interface VivPixelSourceMeta {
  photometricInterpretation?: number;
  physicalSizes?: Record<string, { size: number; unit: string }>;
}

export interface VivPixelSource {
  dtype: string;
  shape: number[];
  labels: string[];
  tileSize?: number;
  meta?: VivPixelSourceMeta;
  getRaster: (sel: VivRasterSelection) => Promise<VivPixelData>;
  getTile?: (sel: VivTileSelection) => Promise<VivPixelData>;
  onTileError?: (err: Error) => void;
}

export type VivLoader = VivPixelSource[];

/** Channel appearance/metadata Viv can read out of OME-XML or OME-Zarr `omero`. */
export interface VivChannelMeta {
  name: string;
  color: string | null;
  window: [number, number] | null;
  visible: boolean | null;
}

export interface LoadedVivImage {
  loader: VivLoader;
  /** number of pyramid resolution levels */
  levels: number;
  channels: VivChannelMeta[];
  pixelSizeUm: number | null;
  dtype: string;
  width: number;
  height: number;
}

interface OmeXmlLike {
  Pixels?: {
    SizeC?: number;
    SizeX?: number;
    SizeY?: number;
    PhysicalSizeX?: number;
    PhysicalSizeXUnit?: string;
    Channels?: { Name?: string; Color?: [number, number, number, number] }[];
  };
}

function umFromPhysical(size: number | undefined, unit: string | undefined): number | null {
  if (!size || !Number.isFinite(size) || size <= 0) return null;
  switch (unit ?? "µm") {
    case "µm":
    case "um":
    case "micron":
      return size;
    case "nm":
      return size * 1e-3;
    case "mm":
      return size * 1e3;
    case "cm":
      return size * 1e4;
    case "m":
      return size * 1e6;
    default:
      return null; // "pixel" / "reference frame" → unknown, never fabricate µm
  }
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function describe(loader: VivLoader): { width: number; height: number; dtype: string } {
  const base = loader[0];
  const labels = base.labels;
  const xi = labels.indexOf("x");
  const yi = labels.indexOf("y");
  return {
    width: base.shape[xi >= 0 ? xi : base.shape.length - 1],
    height: base.shape[yi >= 0 ? yi : base.shape.length - 2],
    dtype: base.dtype,
  };
}

function omeChannels(meta: OmeXmlLike): VivChannelMeta[] {
  const pixels = meta.Pixels;
  const chans = pixels?.Channels ?? [];
  const n = pixels?.SizeC ?? chans.length ?? 1;
  const out: VivChannelMeta[] = [];
  for (let i = 0; i < Math.max(1, n); i++) {
    const c = chans[i];
    let color: string | null = null;
    if (c?.Color && Array.isArray(c.Color) && c.Color.length >= 3) {
      color = `#${hex(c.Color[0] & 255)}${hex(c.Color[1] & 255)}${hex(c.Color[2] & 255)}`;
      if (color === "#000000") color = null;
    }
    out.push({ name: c?.Name?.trim() || `Channel ${i + 1}`, color, window: null, visible: null });
  }
  return out;
}

/**
 * Load a pyramidal OME-TIFF (URL or dropped File) as a Viv multiscale pixel-source
 * array. Tiles stream on demand per zoom level, so memory stays bounded regardless
 * of file size.
 */
export async function loadVivImage(source: string | File): Promise<LoadedVivImage> {
  const { loadOmeTiff } = await import("@hms-dbmi/viv");
  const { data, metadata } = await loadOmeTiff(source as string, { images: "first" });
  const loader = data as unknown as VivLoader;
  const meta = metadata as unknown as OmeXmlLike;
  return {
    loader,
    levels: loader.length,
    channels: omeChannels(meta),
    pixelSizeUm: umFromPhysical(meta.Pixels?.PhysicalSizeX, meta.Pixels?.PhysicalSizeXUnit),
    ...describe(loader),
  };
}

interface OmeroMeta {
  omero?: {
    channels?: { label?: string; color?: string; channelsVisible?: boolean; window?: { start: number; end: number } }[];
  };
  multiscales?: { axes?: (string | { name: string; unit?: string })[]; datasets?: { coordinateTransformations?: { scale?: number[] }[] }[] }[];
}

function zarrChannels(meta: OmeroMeta, n: number): VivChannelMeta[] {
  const chans = meta.omero?.channels ?? [];
  const out: VivChannelMeta[] = [];
  for (let i = 0; i < Math.max(1, n); i++) {
    const c = chans[i];
    out.push({
      name: c?.label?.trim() || `Channel ${i + 1}`,
      color: c?.color ? (c.color.startsWith("#") ? c.color : `#${c.color}`) : null,
      window: c?.window ? [c.window.start, c.window.end] : null,
      visible: typeof c?.channelsVisible === "boolean" ? c.channelsVisible : null,
    });
  }
  return out;
}

/** µm/px from NGFF axes + the level-0 coordinate transform, when stated in µm. */
function zarrPixelSizeUm(meta: OmeroMeta): number | null {
  const ms = meta.multiscales?.[0];
  const axes = ms?.axes;
  const scale = ms?.datasets?.[0]?.coordinateTransformations?.find((t) => Array.isArray(t.scale))?.scale;
  if (!axes || !scale) return null;
  const idx = axes.findIndex((a) => (typeof a === "string" ? a === "x" : a.name === "x"));
  if (idx < 0 || typeof scale[idx] !== "number") return null;
  const axis = axes[idx];
  const unit = typeof axis === "string" ? undefined : axis.unit;
  return umFromPhysical(scale[idx], unit === "micrometer" ? "µm" : unit);
}

function channelCount(loader: VivLoader): number {
  const base = loader[0];
  const ci = base.labels.indexOf("c");
  return ci >= 0 ? base.shape[ci] : 1;
}

/** Load a remote OME-Zarr (NGFF multiscales) group by URL. */
export async function loadVivOmeZarrUrl(url: string): Promise<LoadedVivImage> {
  const { loadOmeZarr } = await import("@hms-dbmi/viv");
  const { data, metadata } = await loadOmeZarr(url, { type: "multiscales" });
  const loader = data as unknown as VivLoader;
  const meta = metadata as unknown as OmeroMeta;
  return {
    loader,
    levels: loader.length,
    channels: zarrChannels(meta, channelCount(loader)),
    pixelSizeUm: zarrPixelSizeUm(meta),
    ...describe(loader),
  };
}

/**
 * Load an OME-Zarr group the user dropped as a *folder*: zarrita only needs a
 * store with `get(key)`, so the dropped `File` handles serve chunks directly —
 * no server, no copy of the whole dataset.
 */
export async function loadVivOmeZarrFiles(members: Map<string, File>): Promise<LoadedVivImage> {
  const { loadOmeZarrFromStore } = await import("@hms-dbmi/viv");
  const store = {
    async get(key: string): Promise<Uint8Array | undefined> {
      const rel = key.replace(/^\/+/, "");
      const file = members.get(rel);
      if (!file) return undefined;
      return new Uint8Array(await file.arrayBuffer());
    },
  };
  const { data, metadata } = await loadOmeZarrFromStore(store as never);
  const loader = data as unknown as VivLoader;
  const meta = metadata as unknown as OmeroMeta;
  return {
    loader,
    levels: loader.length,
    channels: zarrChannels(meta, channelCount(loader)),
    pixelSizeUm: zarrPixelSizeUm(meta),
    ...describe(loader),
  };
}

/**
 * A small TIFF and BigTIFF reader for the in-browser engine: the page structure and the tags FluoroView
 * uses. Only the bytes that are needed are read from the file, so multi-gigabyte scans open instantly.
 */

export class TiffError extends Error {}

export interface TiffPage {
  index: number;
  width: number;
  height: number;
  bitsPerSample: number;
  samplesPerPixel: number;
  /** 1 unsigned integer, 2 signed, 3 floating point */
  sampleFormat: number;
  compression: number;
  predictor: number;
  /** 1 samples interleaved, 2 one plane per sample */
  planar: number;
  fillOrder: number;
  /** NewSubfileType; bit 0 marks reduced-resolution copies */
  subfileType: number;
  rowsPerStrip: number;
  /** strip or tile offsets and byte counts; with planar = 2, each sample's chunks follow the previous one's */
  offsets: number[];
  byteCounts: number[];
  tileWidth: number | null;
  tileHeight: number | null;
  xResolution: [number, number] | null;
  resolutionUnit: number | null;
  /** where the ImageDescription text is, read only when it is needed */
  description: [offset: number, length: number] | null;
  descriptionInline: string | null;
  /** ImageJ's binary metadata (channel labels and more) and the byte count of each of its blocks */
  imagej: [offset: number, length: number] | null;
  imagejCounts: number[];
}

export interface Tiff {
  littleEndian: boolean;
  bigTiff: boolean;
  pages: TiffPage[];
}

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8,
};
const TAG = {
  subfileType: 254, width: 256, height: 257, bits: 258, compression: 259, fillOrder: 266, description: 270,
  stripOffsets: 273, samples: 277, rowsPerStrip: 278, stripByteCounts: 279, xResolution: 282, planar: 284,
  resolutionUnit: 296, predictor: 317, tileWidth: 322, tileHeight: 323, tileOffsets: 324, tileByteCounts: 325,
  sampleFormat: 339, imagejCounts: 50838, imagej: 50839,
} as const;
/** read where they are, when needed, rather than with the page */
const DEFERRED = new Set<number>([TAG.description, TAG.imagej]);
const WANTED = new Set<number>(Object.values(TAG));
const MAX_PAGES = 4096;

interface Entry {
  type: number;
  count: number;
  data: DataView;
  /** file offset of values that did not fit in the entry */
  offset: number | null;
}

export async function readBytes(blob: Blob, offset: number, length: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  if (bytes.length < length) throw new TiffError("The file ends early; it may be incomplete.");
  return bytes;
}

async function view(blob: Blob, offset: number, length: number): Promise<DataView> {
  const bytes = await readBytes(blob, offset, length);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(v: DataView, at: number, le: boolean): number {
  const lo = v.getUint32(at + (le ? 0 : 4), le);
  const hi = v.getUint32(at + (le ? 4 : 0), le);
  return hi * 2 ** 32 + lo;
}

function values(e: Entry, le: boolean): number[] {
  const size = TYPE_SIZE[e.type] ?? 1;
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    const o = i * size;
    switch (e.type) {
      case 1: case 6: case 7:
        out.push(e.data.getUint8(o));
        break;
      case 3: case 8:
        out.push(e.data.getUint16(o, le));
        break;
      case 4: case 9: case 13:
        out.push(e.data.getUint32(o, le));
        break;
      case 16: case 17: case 18:
        out.push(u64(e.data, o, le));
        break;
      case 5: case 10:
        out.push(e.data.getUint32(o, le), e.data.getUint32(o + 4, le));
        break;
      default:
        throw new TiffError(`TIFF value type ${e.type} is not supported`);
    }
  }
  return out;
}

async function readIfd(blob: Blob, at: number, le: boolean, big: boolean): Promise<{ entries: Map<number, Entry>; next: number }> {
  const head = await view(blob, at, big ? 8 : 2);
  const n = big ? u64(head, 0, le) : head.getUint16(0, le);
  const size = big ? 20 : 12;
  const inline = big ? 8 : 4;
  const body = await view(blob, at + (big ? 8 : 2), n * size + inline);
  const entries = new Map<number, Entry>();
  const pending: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * size;
    const tag = body.getUint16(o, le);
    if (!WANTED.has(tag)) continue;
    const type = body.getUint16(o + 2, le);
    const count = big ? u64(body, o + 4, le) : body.getUint32(o + 4, le);
    const at2 = o + (big ? 12 : 8);
    const nbytes = (TYPE_SIZE[type] ?? 1) * count;
    if (nbytes <= inline) {
      entries.set(tag, { type, count, data: new DataView(body.buffer, body.byteOffset + at2, inline), offset: null });
      continue;
    }
    const offset = big ? u64(body, at2, le) : body.getUint32(at2, le);
    if (DEFERRED.has(tag)) {
      entries.set(tag, { type, count, data: new DataView(new ArrayBuffer(0)), offset });
      continue;
    }
    pending.push(view(blob, offset, nbytes).then((data) => void entries.set(tag, { type, count, data, offset })));
  }
  await Promise.all(pending);
  const next = big ? u64(body, n * size, le) : body.getUint32(n * size, le);
  return { entries, next };
}

function toPage(entries: Map<number, Entry>, index: number, le: boolean): TiffPage {
  const all = (tag: number) => {
    const e = entries.get(tag);
    return e ? values(e, le) : [];
  };
  const one = (tag: number, fallback: number) => all(tag)[0] ?? fallback;
  const width = one(TAG.width, 0);
  const height = one(TAG.height, 0);
  if (!width || !height) throw new TiffError("A TIFF page has no image size.");
  const tiled = entries.has(TAG.tileWidth);
  const res = entries.has(TAG.xResolution) ? all(TAG.xResolution) : null;
  const desc = entries.get(TAG.description);
  let descriptionInline: string | null = null;
  if (desc && desc.offset === null) {
    descriptionInline = new TextDecoder().decode(new Uint8Array(desc.data.buffer, desc.data.byteOffset, desc.count));
  }
  const rowsPerStrip = one(TAG.rowsPerStrip, height);
  const ij = entries.get(TAG.imagej);
  return {
    index,
    width,
    height,
    bitsPerSample: one(TAG.bits, 1),
    samplesPerPixel: one(TAG.samples, 1),
    sampleFormat: one(TAG.sampleFormat, 1),
    compression: one(TAG.compression, 1),
    predictor: one(TAG.predictor, 1),
    planar: one(TAG.planar, 1),
    fillOrder: one(TAG.fillOrder, 1),
    subfileType: one(TAG.subfileType, 0),
    rowsPerStrip: Math.min(rowsPerStrip, height),
    offsets: all(tiled ? TAG.tileOffsets : TAG.stripOffsets),
    byteCounts: all(tiled ? TAG.tileByteCounts : TAG.stripByteCounts),
    tileWidth: tiled ? one(TAG.tileWidth, 0) : null,
    tileHeight: tiled ? one(TAG.tileHeight, 0) : null,
    xResolution: res && res.length >= 2 ? [res[0]!, res[1]!] : null,
    resolutionUnit: entries.has(TAG.resolutionUnit) ? one(TAG.resolutionUnit, 2) : null,
    description: desc && desc.offset !== null ? [desc.offset, desc.count] : null,
    descriptionInline,
    imagej: ij && ij.offset !== null ? [ij.offset, ij.count] : null,
    imagejCounts: all(TAG.imagejCounts),
  };
}

/** Page structure of a TIFF or BigTIFF file; pixel data is not read. */
export async function readTiff(blob: Blob): Promise<Tiff> {
  const head = await view(blob, 0, 16).catch(() => {
    throw new TiffError("This is not a TIFF file.");
  });
  const order = head.getUint16(0, false);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) throw new TiffError("This is not a TIFF file.");
  const magic = head.getUint16(2, le);
  let big = false;
  let at: number;
  if (magic === 42) {
    at = head.getUint32(4, le);
  } else if (magic === 43) {
    big = true;
    at = u64(head, 8, le);
  } else {
    throw new TiffError("This is not a TIFF file.");
  }
  const pages: TiffPage[] = [];
  const seen = new Set<number>();
  while (at && !seen.has(at) && pages.length < MAX_PAGES) {
    seen.add(at);
    const { entries, next } = await readIfd(blob, at, le, big);
    pages.push(toPage(entries, pages.length, le));
    at = next;
  }
  if (!pages.length) throw new TiffError("The TIFF file has no images.");
  return { littleEndian: le, bigTiff: big, pages };
}

/** Channel labels from ImageJ's binary metadata (tag 50839), in page order; empty when there are none. */
export async function imagejLabels(blob: Blob, page: TiffPage, littleEndian: boolean): Promise<string[]> {
  const counts = page.imagejCounts;
  if (!page.imagej || !counts.length) return [];
  const data = await readBytes(blob, page.imagej[0], page.imagej[1]);
  const magic = String.fromCharCode(...data.subarray(0, 4));
  const header = counts[0]!;
  if ((magic !== "IJIJ" && magic !== "JIJI") || header < 12 || header > 804) return [];
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const text = new TextDecoder(littleEndian ? "utf-16le" : "utf-16be");
  const labels: string[] = [];
  let pos = header;
  let block = 1;
  for (let i = 0; i < Math.floor((header - 4) / 8); i++) {
    const type = String.fromCharCode(...data.subarray(4 + i * 8, 8 + i * 8));
    const n = v.getUint32(8 + i * 8, littleEndian);
    for (let j = 0; j < n; j++, block++) {
      const size = counts[block] ?? 0;
      if (type === "labl" || type === "lbal") labels.push(text.decode(data.subarray(pos, pos + size)));
      pos += size;
    }
  }
  return labels;
}

/** The page's ImageDescription (OME-XML, ImageJ or vendor metadata), or null. */
export async function pageDescription(blob: Blob, page: TiffPage): Promise<string | null> {
  if (page.descriptionInline !== null) return page.descriptionInline.replace(/\0+$/, "");
  if (!page.description) return null;
  const [offset, length] = page.description;
  return new TextDecoder().decode(await readBytes(blob, offset, length)).replace(/\0+$/, "");
}

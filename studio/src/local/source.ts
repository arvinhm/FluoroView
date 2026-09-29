/**
 * Scans read in the browser: which page and sample hold each channel, the channel names, colours and
 * pixel size (chosen as the engine's io/tiff.py, io/biotek.py and io/multifile.py choose them), and
 * full-width rows of one channel at a time.
 */

import type { ChannelInfo } from "../api/types";
import { GENERIC_NAME, RGB_COLORS, assignColors, channelNameFromFile, defaultColor, isTransmittedName } from "./colors";
import { decompress, undoPredictor } from "./decode";
import { TiffError, type TiffPage, imagejLabels, pageDescription, readBytes, readTiff } from "./tiff";

export type Pixels = Uint16Array | Uint8Array;

/** Where one channel's pixels are. */
export interface Plane {
  file: number;
  page: TiffPage;
  /** the sample within each pixel, for images with several samples per pixel */
  sample: number;
  littleEndian: boolean;
  /** byte offset of the plane when it is one uncompressed run of bytes, so rows are read by offset */
  contiguous: number | null;
}

/** What reading rows needs; plain data, so it can be posted to a worker. */
export interface SourceSpec {
  files: Blob[];
  width: number;
  height: number;
  bits: 8 | 16;
  planes: Plane[];
}

export interface SourceInfo {
  name: string;
  scanKey: string;
  /** member file names when the channels come from separate files */
  files: string[];
  width: number;
  height: number;
  dtype: "<u2" | "|u1";
  channels: ChannelInfo[];
  pixel_size_um: number | null;
  saturation: number | null;
  layout: "contiguous" | "chunked";
  vendor: string;
  acquisition: Record<string, string | number>;
}

export interface Source {
  spec: SourceSpec;
  info: SourceInfo;
}

const OPENABLE = /\.(tiff?|btf|tf8|qptiff)$/i;
const IMAGEJ_MICRONS = new Set(["micron", "microns", "um", "\u00b5m", "\u03bcm", "\\u00b5m"]);
const OME_UNITS: Record<string, number> = { "\u00b5m": 1, um: 1, nm: 1e-3, mm: 1e3 };

// -- small XML helpers: the metadata is machine-written, and workers have no DOMParser ------------------

interface Element {
  attrs: string;
  body: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k] ?? e;
  });
}

function child(xml: string, name: string): Element | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>)`).exec(xml);
  return m ? { attrs: m[1] ?? "", body: m[2] ?? "" } : null;
}

function find(xml: string, path: string): Element | null {
  let at: Element | null = { attrs: "", body: xml };
  for (const part of path.split("/")) {
    at = child(at.body, part);
    if (!at) return null;
  }
  return at;
}

function openingTags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}(\\s[^>]*?)?/?>`, "g"))].map((m) => m[1] ?? "");
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : null;
}

function text(xml: string, path: string): string | null {
  const el = find(xml, path);
  const t = el ? decodeEntities(el.body.replace(/<[\s\S]*$/, "")).trim() : "";
  return t || null;
}

function num(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return v.trim() && Number.isFinite(n) ? n : null;
}

// -- vendor metadata ----------------------------------------------------------------------------------

const BIOTEK_CHANNEL = /^\s*(?:[A-Za-z ]+\[)?\s*(.*?)\s+(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]?\s*$/;

interface BioTekPage {
  name: string | null;
  ex: number | null;
  em: number | null;
  transmitted: boolean;
  pixelSize: number | null;
  saturation: number | null;
  acquisition: Record<string, string | number>;
}

function parseBioTek(xml: string): BioTekPage {
  const root = child(xml, "BTIImageMetaData")?.body ?? "";
  const t = (path: string) => text(root, path);
  const n = (path: string) => num(t(path));
  const channel = find(root, "ImageAcquisition/Channel");
  const color = channel ? attr(channel.attrs, "Color") ?? "" : "";
  const m = BIOTEK_CHANNEL.exec(color);
  let name: string | null;
  let ex: number | null = null;
  let em: number | null = null;
  if (m && m[1]) {
    name = m[1].trim();
    ex = Number(m[2]);
    em = Number(m[3]);
  } else {
    name = color.replace(/^[A-Za-z ]+\[|\]$/g, "").trim() || null;
  }
  const transmitted = channel !== null
    && ["BrightField", "PhaseContrast"].some((tag) => (text(channel.body, tag) ?? "").toUpperCase() === "TRUE");
  const widthPx = n("ImageAcquisition/PixelWidth");
  const widthUm = n("ImageAcquisition/ImageWidthMicrons");
  const saturation = n("System/Camera/SaturationLevel");
  const version = t("System/Gen5/Version");
  const objective = [t("ImageAcquisition/DisplayedObjectiveSize"), t("ImageAcquisition/ObjectiveMfg")]
    .filter(Boolean).join(" ");
  const acquisition: Record<string, string | number | null> = {
    software: version ? `Gen5 ${version}` : null,
    camera: t("System/Camera/Model"),
    objective: objective || null,
    numerical_aperture: n("ImageAcquisition/NumericalAperture"),
    exposure_ms: n("ImageAcquisition/ShutterSpeedMS"),
    camera_gain: n("ImageAcquisition/CameraGain"),
    led_intensity: n("ImageAcquisition/LEDIntensity"),
    date: t("ImageReference/Date"),
    time: t("ImageReference/Time"),
    plate: t("ImageReference/Plate"),
    well: t("ImageReference/Well"),
    original_filename: t("ImageReference/OriginalFilename"),
  };
  const width = widthPx ? Math.trunc(widthPx) : null;
  return {
    name,
    ex,
    em,
    transmitted,
    pixelSize: widthUm && width ? widthUm / width : null,
    saturation: saturation ? Math.trunc(saturation) : null,
    acquisition: Object.fromEntries(Object.entries(acquisition).filter(([, v]) => v !== null)) as Record<string, string | number>,
  };
}

interface Ome {
  pixelSize: number | null;
  channels: { name: string | null; ex: number | null; em: number | null }[];
  /** page index of channel c at the first z and time point */
  page: (c: number) => number;
  sizeC: number;
}

function parseOme(xml: string): Ome | null {
  const pixels = find(xml, "Image/Pixels");
  if (!pixels) return null;
  const size = attr(pixels.attrs, "PhysicalSizeX");
  const scale = OME_UNITS[attr(pixels.attrs, "PhysicalSizeXUnit") ?? "\u00b5m"];
  const physical = num(size);
  const sizes: Record<string, number> = {
    Z: num(attr(pixels.attrs, "SizeZ")) ?? 1,
    C: num(attr(pixels.attrs, "SizeC")) ?? 1,
    T: num(attr(pixels.attrs, "SizeT")) ?? 1,
  };
  const order = (attr(pixels.attrs, "DimensionOrder") ?? "XYZCT").slice(2);
  let stride = 1;
  const strides: Record<string, number> = {};
  for (const d of order) {
    strides[d] = stride;
    stride *= sizes[d] ?? 1;
  }
  const tiffData = openingTags(pixels.body, "TiffData").map((a) => ({
    ifd: num(attr(a, "IFD")),
    c: num(attr(a, "FirstC")),
    z: num(attr(a, "FirstZ")),
    t: num(attr(a, "FirstT")),
  }));
  const base = tiffData[0]?.ifd ?? 0;
  return {
    pixelSize: physical && scale ? physical * scale : null,
    channels: openingTags(pixels.body, "Channel").map((a) => ({
      name: attr(a, "Name") || null,
      ex: num(attr(a, "ExcitationWavelength")),
      em: num(attr(a, "EmissionWavelength")),
    })),
    page: (c) => {
      const exact = tiffData.find((d) => d.ifd !== null && d.c === c && (d.z ?? 0) === 0 && (d.t ?? 0) === 0);
      return exact ? exact.ifd! : base + c * (strides.C ?? 1);
    },
    sizeC: sizes.C!,
  };
}

function imagejInfo(desc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of desc.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function resolutionUm(page: TiffPage, perUnit: number | null): number | null {
  if (!page.xResolution) return null;
  const [n, d] = page.xResolution;
  if (!n || !d) return null;
  const perPixel = n / d;
  if (perUnit !== null) return perUnit / perPixel;
  return page.resolutionUnit === 3 ? 1e4 / perPixel : null;
}

// -- channels -----------------------------------------------------------------------------------------

function dtypeName(page: TiffPage): string {
  const kind = page.sampleFormat === 2 ? "int" : page.sampleFormat === 3 ? "float" : "uint";
  return `${kind}${page.bitsPerSample}`;
}

/** The plane's byte offset when it is uncompressed and stored as one run of bytes (the Gen5 layout). */
function contiguousOffset(page: TiffPage, bytes: number): number | null {
  if (page.compression !== 1 || page.tileWidth || page.samplesPerPixel !== 1 || page.predictor !== 1
    || page.fillOrder !== 1 || !page.offsets.length) return null;
  const total = page.byteCounts.reduce((a, b) => a + b, 0);
  if (total !== page.width * page.height * bytes) return null;
  for (let i = 0; i < page.offsets.length - 1; i++) {
    if (page.offsets[i]! + page.byteCounts[i]! !== page.offsets[i + 1]) return null;
  }
  return page.offsets[0]!;
}

/** Pages of the first series: full-resolution pages stored like the first one. */
function seriesPages(pages: TiffPage[]): TiffPage[] {
  const f = pages[0]!;
  return pages.filter((p) => (p.subfileType & 1) === 0 && p.width === f.width && p.height === f.height
    && p.bitsPerSample === f.bitsPerSample && p.samplesPerPixel === f.samplesPerPixel
    && p.sampleFormat === f.sampleFormat && p.compression === f.compression && p.planar === f.planar
    && p.predictor === f.predictor && p.tileWidth === f.tileWidth && p.tileHeight === f.tileHeight);
}

async function single(file: File, index: number): Promise<Source> {
  const tiff = await readTiff(file);
  const le = tiff.littleEndian;
  const first = tiff.pages[0]!;
  const bits = first.bitsPerSample;
  if (first.sampleFormat !== 1 || (bits !== 8 && bits !== 16)) {
    throw new TiffError(`FluoroView reads 8- and 16-bit integer images; this file is ${dtypeName(first)}.`);
  }
  const bytes = bits / 8;
  const plane = (page: TiffPage, sample = 0): Plane =>
    ({ file: index, page, sample, littleEndian: le, contiguous: contiguousOffset(page, bytes) });
  const desc = await pageDescription(file, first);
  const vendor = desc?.slice(0, 1024).includes("<BTIImageMetaData") ? "biotek-gen5"
    : desc?.trim().endsWith("OME>") ? "ome-tiff"
      : desc?.startsWith("ImageJ=") ? "imagej" : "tiff";
  const ome = vendor === "ome-tiff" ? parseOme(desc!) : null;
  const ij = vendor === "imagej" ? imagejInfo(desc!) : null;

  let planes: Plane[];
  if (first.samplesPerPixel > 1) {
    planes = Array.from({ length: first.samplesPerPixel }, (_, s) => plane(first, s));
  } else if (ome) {
    planes = Array.from({ length: ome.sizeC }, (_, c) => {
      const page = tiff.pages[ome.page(c)];
      if (!page) throw new TiffError("The OME-XML lists more image planes than the file holds.");
      return plane(page);
    });
  } else if (ij) {
    const images = Number(ij.images ?? tiff.pages.length);
    const product = ["channels", "slices", "frames"].reduce((p, k) => p * Number(ij[k] ?? 1), 1);
    const n = images > 1 && product !== images ? images : Number(ij.channels ?? 1);
    const start = contiguousOffset(first, bytes);
    planes = Array.from({ length: n }, (_, c) => {
      const page = tiff.pages[c];
      if (page) return plane(page);
      if (start === null) throw new TiffError("This ImageJ file's planes could not be found.");
      return { ...plane(first), contiguous: start + c * first.width * first.height * bytes };
    });
  } else {
    planes = seriesPages(tiff.pages).map((p) => plane(p));
  }

  const n = planes.length;
  let names: (string | null)[] = new Array<string | null>(n).fill(null);
  const ex: (number | null)[] = new Array<number | null>(n).fill(null);
  const em: (number | null)[] = new Array<number | null>(n).fill(null);
  const transmitted: (boolean | null)[] = new Array<boolean | null>(n).fill(null);
  let pixelSize: number | null = null;
  let saturation: number | null = null;
  let acquisition: Record<string, string | number> = {};
  if (vendor === "biotek-gen5") {
    for (let c = 0; c < n; c++) {
      const page = planes[c]!.page;
      const meta = parseBioTek((page === first ? desc : await pageDescription(file, page)) ?? "");
      names[c] = meta.name;
      ex[c] = meta.ex;
      em[c] = meta.em;
      transmitted[c] = meta.transmitted;
      if (c === 0) ({ pixelSize, saturation, acquisition } = meta);
    }
  } else if (ome) {
    pixelSize = ome.pixelSize;
    ome.channels.slice(0, n).forEach((ch, c) => {
      names[c] = ch.name;
      ex[c] = ch.ex;
      em[c] = ch.em;
    });
  } else if (ij) {
    const labels = await imagejLabels(file, first, le);
    for (let c = 0; c < Math.min(n, labels.length); c++) names[c] = labels[c] || null;
    if (IMAGEJ_MICRONS.has((ij.unit ?? "").toLowerCase())) pixelSize = resolutionUm(first, 1);
  }
  if (pixelSize === null && vendor === "tiff") pixelSize = resolutionUm(first, null);

  const rgb = first.samplesPerPixel === 3;
  if (rgb && !names.some(Boolean)) names = ["Red", "Green", "Blue"];
  const channels: ChannelInfo[] = names.map((name, c) => {
    const isTransmitted = transmitted[c] ?? (em[c] === null && isTransmittedName(name ?? ""));
    return {
      index: c,
      name: name || `Channel ${c + 1}`,
      color: rgb ? RGB_COLORS[c]! : defaultColor(c, name ?? "", em[c] ?? null, isTransmitted),
      excitation_nm: ex[c] ?? null,
      emission_nm: em[c] ?? null,
      kind: isTransmitted && !rgb ? "transmitted" : "fluorescence",
    };
  });
  return {
    spec: { files: [file], width: first.width, height: first.height, bits, planes },
    info: {
      name: file.name,
      scanKey: file.name,
      files: [],
      width: first.width,
      height: first.height,
      dtype: bits === 16 ? "<u2" : "|u1",
      channels,
      pixel_size_um: pixelSize,
      saturation,
      layout: planes.every((p) => p.contiguous !== null) ? "contiguous" : "chunked",
      vendor,
      acquisition,
    },
  };
}

async function combined(files: File[]): Promise<Source> {
  const members = await Promise.all(files.map((f, i) => single(f, i)));
  const first = members[0]!.info;
  for (const { info: i } of members) {
    if (i.channels.length !== 1) {
      throw new TiffError(`${i.name} has ${i.channels.length} channels; combine single-channel files only.`);
    }
    if (i.width !== first.width || i.height !== first.height || i.dtype !== first.dtype) {
      throw new TiffError(`${i.name} is ${i.width} × ${i.height} ${i.dtype}, but ${first.name} is `
        + `${first.width} × ${first.height} ${first.dtype}; files must match to be combined.`);
    }
  }
  const only = members.map((m) => m.info.channels[0]!);
  const names = only.map((ch, i) => (GENERIC_NAME.test(ch.name) ? channelNameFromFile(files[i]!.name) : ch.name));
  const emissions = only.map((ch) => ch.emission_nm);
  const transmitted = only.map((ch, i) => ch.kind === "transmitted" || isTransmittedName(names[i]!));
  const colors = assignColors(names, emissions, transmitted);
  const folder = (files[0]!.webkitRelativePath ?? "").split("/").slice(-2, -1)[0] || "Combined channels";
  return {
    spec: { files, width: first.width, height: first.height, bits: members[0]!.spec.bits, planes: members.map((m) => m.spec.planes[0]!) },
    info: {
      name: `${folder} · ${files.length} files`,
      scanKey: files.map((f) => f.name).join("+"),
      files: files.map((f) => f.name),
      width: first.width,
      height: first.height,
      dtype: first.dtype,
      channels: only.map((ch, c) => ({
        index: c,
        name: names[c]!,
        color: colors[c]!,
        excitation_nm: ch.excitation_nm,
        emission_nm: emissions[c]!,
        kind: transmitted[c] ? "transmitted" : "fluorescence",
      })),
      pixel_size_um: members.find((m) => m.info.pixel_size_um)?.info.pixel_size_um ?? null,
      saturation: members.find((m) => m.info.saturation)?.info.saturation ?? null,
      layout: members.every((m) => m.info.layout === "contiguous") ? "contiguous" : "chunked",
      vendor: "multi-file",
      acquisition: first.acquisition,
    },
  };
}

/** A TIFF scan, or several single-channel TIFF files of the same size combined as channels. */
export async function openSource(files: File[]): Promise<Source> {
  if (!files.length) throw new TiffError("Choose a file to open.");
  if (!files.every((f) => OPENABLE.test(f.name))) {
    throw new TiffError("FluoroView opens TIFF files (.tif, .tiff, .ome.tif, .qptiff, .btf).");
  }
  return files.length === 1 ? single(files[0]!, 0) : combined(files);
}

// -- pixels -------------------------------------------------------------------------------------------

function samples(bytes: Uint8Array, bits: 8 | 16, littleEndian: boolean): Pixels {
  if (bits === 8) return bytes;
  const n = bytes.length >> 1;
  if (littleEndian && bytes.byteOffset % 2 === 0) return new Uint16Array(bytes.buffer, bytes.byteOffset, n);
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = littleEndian ? bytes[2 * i]! | (bytes[2 * i + 1]! << 8) : (bytes[2 * i]! << 8) | bytes[2 * i + 1]!;
  }
  return out;
}

/** One strip or tile, decoded: `rows` rows of `width` pixels with `spp` samples each. */
async function chunk(file: Blob, page: TiffPage, index: number, width: number, rows: number, spp: number,
  bits: 8 | 16, littleEndian: boolean): Promise<Pixels> {
  const size = width * rows * spp * (bits / 8);
  const count = page.byteCounts[index] ?? 0;
  let data = new Uint8Array(size);
  if (count) {
    if (page.fillOrder !== 1) throw new TiffError("This TIFF's bit order is not supported in the browser version yet.");
    const raw = await readBytes(file, page.offsets[index]!, count);
    const out = await decompress(page.compression, raw, size);
    if (out.length >= size) data = out.subarray(0, size);
    else data.set(out);
  }
  const values = samples(data, bits, littleEndian);
  if (page.predictor === 2) undoPredictor(values, width * spp, rows, spp);
  else if (page.predictor !== 1) throw new TiffError("This TIFF's floating-point predictor is not supported.");
  return values;
}

/** Full-width rows `[y0, y1)` of channel `c`. */
export async function readRows(spec: SourceSpec, c: number, y0: number, y1: number): Promise<Pixels> {
  const plane = spec.planes[c]!;
  const file = spec.files[plane.file]!;
  const w = spec.width;
  const bytes = spec.bits / 8;
  if (plane.contiguous !== null) {
    const raw = await readBytes(file, plane.contiguous + y0 * w * bytes, (y1 - y0) * w * bytes);
    return samples(raw, spec.bits, plane.littleEndian);
  }
  const page = plane.page;
  const out = spec.bits === 16 ? new Uint16Array((y1 - y0) * w) : new Uint8Array((y1 - y0) * w);
  const separate = page.planar === 2;
  const spp = separate ? 1 : page.samplesPerPixel;
  const sample = separate ? 0 : plane.sample;
  const tiled = page.tileWidth !== null && page.tileHeight !== null;
  const cw = tiled ? page.tileWidth! : w;
  const ch = tiled ? page.tileHeight! : page.rowsPerStrip;
  const across = Math.ceil(w / cw);
  const down = Math.ceil(spec.height / ch);
  const base = separate ? plane.sample * across * down : 0;
  const jobs: Promise<void>[] = [];
  for (let cy = Math.floor(y0 / ch); cy * ch < y1; cy++) {
    const top = cy * ch;
    const rows = tiled ? ch : Math.min(ch, spec.height - top);
    for (let cx = 0; cx < across; cx++) {
      jobs.push(chunk(file, page, base + cy * across + cx, cw, rows, spp, spec.bits, plane.littleEndian).then((data) => {
        const x0 = cx * cw;
        const n = Math.min(cw, w - x0);
        for (let y = Math.max(y0, top); y < Math.min(y1, top + rows); y++) {
          const src = (y - top) * cw * spp;
          const dst = (y - y0) * w + x0;
          if (spp === 1) out.set(data.subarray(src, src + n), dst);
          else for (let x = 0; x < n; x++) out[dst + x] = data[src + x * spp + sample]!;
        }
      }));
    }
  }
  await Promise.all(jobs);
  return out;
}

import type { BoundaryCell, Cell, ChannelDef, ChannelHistogram, ScanChannelMeta, ScanMeta } from "../types";
import type { ChannelMaps } from "../synth";
import type { DatasetDef } from "../datasets";
import type { LoadedDataset } from "../loadReal";
import { binHistogram } from "../histogram";
import { loadVivImage, loadVivOmeZarrFiles, loadVivOmeZarrUrl, type LoadedVivImage, type VivLoader } from "../vivSource";
import { createArrayLoader } from "./arraySource";
import { assignChannelColors, guessChannelKind } from "./names";
import { bytesPerSample, measureDomain, type NumArray } from "./pyramid";
import type { Detected, MaskResult, StagedFile, UploadDtype, UploadProgress } from "./types";
import { buildDatasetInWorker, buildMaskInWorker } from "./workerClient";

export interface UploadedDataset {
  def: DatasetDef;
  loaded: LoadedDataset;
  notes: string[];
}

type Progress = (p: UploadProgress) => void;

let uploadSeq = 0;

function datasetLabel(detected: Detected, override?: string): string {
  if (override?.trim()) return override.trim();
  if (detected.kind === "ome-zarr-dir") return detected.zarrRoot?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "OME-Zarr upload";
  const first = detected.files[0];
  if (!first) return "Upload";
  if (detected.files.length === 1) return first.name || first.relPath;
  const folder = first.relPath.includes("/") ? first.relPath.split("/")[0] : "";
  return folder || `${detected.files.length}-channel upload`;
}

function toChannelDefs(names: string[], colors: string[]): ChannelDef[] {
  return names.map((name, i) => ({
    name,
    color: colors[i],
    kind: guessChannelKind(name),
    // With more channels than Viv can composite at once, only the first 10 start on.
    defaultOn: i < 10,
  }));
}

function scanMetaFor(args: {
  width: number;
  height: number;
  levels: number;
  bits: number;
  tile: number;
  pixelSizeUm: number | null;
  preview: { width: number; height: number; scale: number };
  channels: ScanChannelMeta[];
  image: string;
}): ScanMeta {
  return {
    width: args.width,
    height: args.height,
    levels: args.levels,
    bits: args.bits,
    tile: args.tile,
    pixelSizeUm: args.pixelSizeUm,
    previewWidth: args.preview.width,
    previewHeight: args.preview.height,
    previewScale: args.preview.scale,
    channels: args.channels,
    image: args.image,
    boundaries: "(in memory)",
  };
}

function maskToOverlays(mask: MaskResult, nChannels: number): { cells: Cell[]; polys: BoundaryCell[] } {
  const cells: Cell[] = mask.cells.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    r: Math.max(1, Math.sqrt(Math.max(c.area, 1) / Math.PI)),
    typeIndex: 0,
    markers: c.markers.length === nChannels ? c.markers : new Array(nChannels).fill(0),
  }));
  const polys: BoundaryCell[] = [];
  mask.rings.forEach((ring, i) => {
    if (ring.length < 6) return;
    const path: [number, number][] = new Array(ring.length / 2);
    for (let p = 0; p < path.length; p++) path[p] = [ring[p * 2], ring[p * 2 + 1]];
    polys.push({ id: mask.cells[i].id, path });
  });
  return { cells, polys };
}

/** Build a dataset from decoded arrays (plain TIFF/PNG/JPEG, single or merged). */
async function fromImageFiles(detected: Detected, opts: BuildOptions, onProgress?: Progress): Promise<UploadedDataset> {
  const specs = detected.files.map((f) => ({ file: f.file, relPath: f.relPath, name: f.name }));
  const built = await buildDatasetInWorker(
    { channels: specs, mask: detected.mask ? { file: detected.mask.file, relPath: detected.mask.relPath } : null, budgetBytes: opts.budgetBytes },
    onProgress
  );
  const image = built.image;
  const names = image.channels.map((c) => c.name);
  // A file's own LUT hint (RGB split) wins; otherwise use what the user picked
  // in the review step, then fall back to inferred palette colors.
  const userColors = detected.files.flatMap((f) => [f.color]);
  const colors = names.map((name, i) => built.suggestedColors[i] ?? (names.length === detected.files.length ? userColors[i] : undefined) ?? assignChannelColors(names)[i]);
  const defs = toChannelDefs(names, colors);

  const loader = createArrayLoader(image.levels, image.dtype, names.length, image.tileSize, opts.pixelSizeUm ?? built.pixelSizeUm);
  const maps: ChannelMaps = {
    width: image.preview.width,
    height: image.preview.height,
    scale: image.preview.scale,
    maps: image.preview.planes.map((p) => new Uint8ClampedArray(p.buffer, p.byteOffset, p.length)),
  };
  const channelStats: ChannelHistogram[] = image.channels.map((c) => ({ bins: c.bins, domain: c.domain, auto: c.auto, peak: c.peak }));
  const scanChannels: ScanChannelMeta[] = image.channels.map((c, i) => ({
    name: c.name,
    color: colors[i],
    domain: c.domain,
    contrastLimits: c.auto,
  }));

  const overlays = built.mask ? maskToOverlays(built.mask, names.length) : null;
  const pixelSizeUm = opts.pixelSizeUm ?? built.pixelSizeUm ?? null;
  const notes = [...detected.warnings, ...image.notes, ...(built.mask?.notes ?? [])];
  if (!built.pixelSizeUm && !opts.pixelSizeUm) notes.push("No physical pixel size in the file — the scale bar shows pixels until you calibrate it (Calibrate button in the viewer).");

  return {
    def: makeDef(detected, opts, defs, pixelSizeUm, overlays?.cells.length ?? 0, `${image.levels.length}-level in-browser pyramid · ${image.dtype}`),
    loaded: {
      tissue: { width: image.width, height: image.height, cells: overlays?.cells ?? [], seed: 0 },
      maps,
      channels: defs,
      boundaries: null,
      boundaryPolys: overlays?.polys ?? null,
      imageSource: loader,
      scanMeta: scanMetaFor({
        width: image.width,
        height: image.height,
        levels: image.levels.length,
        bits: bytesPerSample(image.dtype) * 8,
        tile: image.tileSize,
        pixelSizeUm,
        preview: image.preview,
        channels: scanChannels,
        image: detected.files.map((f) => f.relPath).join(", "),
      }),
      channelStats,
      segmented: !!overlays,
      segMethod: overlays ? `Uploaded mask (${detected.mask?.relPath ?? "label image"})` : "",
      notes,
    },
    notes,
  };
}

function makeDef(
  detected: Detected,
  opts: BuildOptions,
  channels: ChannelDef[],
  pixelSizeUm: number | null,
  nCells: number,
  detail: string
): DatasetDef {
  uploadSeq += 1;
  const label = datasetLabel(detected, opts.label);
  return {
    id: `upload-${Date.now().toString(36)}-${uploadSeq}`,
    label: `Uploaded · ${label}`,
    short: label.length > 26 ? `${label.slice(0, 24)}…` : label,
    kind: "upload",
    channels,
    pixelSizeUm,
    nCells: nCells || undefined,
    description: `Your upload — ${channels.length} channel${channels.length > 1 ? "s" : ""}, ${detail}${nCells ? `, ${nCells.toLocaleString()} cells from the uploaded mask` : ""}.`,
  };
}

/** Preview planes + per-channel stats read straight from a streaming pyramid. */
async function previewFromLoader(
  loader: VivLoader,
  nChannels: number,
  onProgress?: Progress,
  maxWidth = 2048
): Promise<{ maps: ChannelMaps; stats: ChannelHistogram[]; domains: [number, number][] }> {
  const base = loader[0];
  const xi = base.labels.indexOf("x");
  const yi = base.labels.indexOf("y");
  const fullW = base.shape[xi >= 0 ? xi : base.shape.length - 1];
  let level = loader.length - 1;
  for (let i = 0; i < loader.length; i++) {
    const w = loader[i].shape[xi >= 0 ? xi : loader[i].shape.length - 1];
    if (w <= maxWidth) {
      level = i;
      break;
    }
  }
  const src = loader[level];
  const width = src.shape[xi >= 0 ? xi : src.shape.length - 1];
  const height = src.shape[yi >= 0 ? yi : src.shape.length - 2];
  const planes: Uint8ClampedArray[] = [];
  const stats: ChannelHistogram[] = [];
  const domains: [number, number][] = [];
  for (let c = 0; c < nChannels; c++) {
    onProgress?.({ phase: "Reading channels", detail: `channel ${c + 1}/${nChannels}`, ratio: 0.3 + (0.6 * c) / nChannels });
    const { data } = await src.getRaster({ selection: { c, z: 0, t: 0 } });
    const arr = data as unknown as NumArray;
    const domain = measureDomain(arr, (src.dtype as UploadDtype) ?? "Uint16");
    const hist = binHistogram(arr, 128, domain);
    domains.push(domain);
    stats.push(hist);
    const out = new Uint8ClampedArray(width * height);
    const range = domain[1] - domain[0] || 1;
    for (let i = 0; i < out.length; i++) out[i] = ((arr[i] - domain[0]) / range) * 255;
    planes.push(out);
  }
  return { maps: { width, height, scale: width / fullW, maps: planes }, stats, domains };
}

/** Build a dataset from a Viv loader we did not decode ourselves (OME-TIFF/Zarr). */
async function fromVivLoader(
  detected: Detected,
  opts: BuildOptions,
  viv: LoadedVivImage,
  sourceLabel: string,
  onProgress?: Progress
): Promise<UploadedDataset> {
  const nChannels = Math.max(1, viv.channels.length);
  const { maps, stats, domains } = await previewFromLoader(viv.loader, nChannels, onProgress);
  const names = viv.channels.map((c, i) => c.name || `Channel ${i + 1}`);
  const fallbackColors = assignChannelColors(names);
  const colors = viv.channels.map((c, i) => c.color ?? fallbackColors[i]);
  const defs = toChannelDefs(names, colors);
  const pixelSizeUm = opts.pixelSizeUm ?? viv.pixelSizeUm ?? null;

  let mask: MaskResult | null = null;
  if (detected.mask) {
    onProgress?.({ phase: "Segmentation", detail: detected.mask.relPath, ratio: 0.9 });
    mask = await buildMaskInWorker(
      {
        file: detected.mask.file,
        relPath: detected.mask.relPath,
        worldWidth: viv.width,
        worldHeight: viv.height,
        intensity: {
          planes: maps.maps as unknown as NumArray[],
          width: maps.width,
          height: maps.height,
          domains,
        },
      },
      onProgress
    );
  }
  const overlays = mask ? maskToOverlays(mask, nChannels) : null;

  const notes = [...detected.warnings, ...(mask?.notes ?? [])];
  if (viv.levels === 1) notes.push("This file has a single resolution level, so the whole plane is uploaded to the GPU at once. Very large flat images should be converted to a tiled pyramid.");
  if (!pixelSizeUm) notes.push("No physical pixel size in the metadata — the scale bar shows pixels until you calibrate it.");
  if (mask) notes.push("Per-cell intensities for an uploaded mask on a streamed pyramid are sampled from the bounded preview level, not full resolution.");

  return {
    def: makeDef(detected, opts, defs, pixelSizeUm, overlays?.cells.length ?? 0, `${viv.levels}-level ${sourceLabel} · ${viv.dtype}`),
    loaded: {
      tissue: { width: viv.width, height: viv.height, cells: overlays?.cells ?? [], seed: 0 },
      maps,
      channels: defs,
      boundaries: null,
      boundaryPolys: overlays?.polys ?? null,
      imageSource: viv.loader,
      scanMeta: scanMetaFor({
        width: viv.width,
        height: viv.height,
        levels: viv.levels,
        bits: /8$/.test(viv.dtype) ? 8 : /16$/.test(viv.dtype) ? 16 : 32,
        tile: viv.loader[0].tileSize ?? 512,
        pixelSizeUm,
        preview: maps,
        channels: names.map((name, i) => ({
          name,
          color: colors[i],
          domain: domains[i],
          contrastLimits: viv.channels[i]?.window ?? stats[i].auto,
        })),
        image: sourceLabel,
      }),
      channelStats: stats,
      segmented: !!overlays,
      segMethod: overlays ? `Uploaded mask (${detected.mask?.relPath ?? "label image"})` : "",
      notes,
    },
    notes,
  };
}

export interface BuildOptions {
  label?: string;
  /** user-entered µm/px; overrides file metadata when set */
  pixelSizeUm?: number | null;
  budgetBytes?: number;
}

/** Turn a reviewed drop into a loadable dataset. */
export async function buildUploadedDataset(detected: Detected, opts: BuildOptions = {}, onProgress?: Progress): Promise<UploadedDataset> {
  if (detected.kind === "ome-zarr-dir") {
    if (!detected.zarrMembers?.size) throw new Error("That folder has zarr metadata but no chunk files.");
    onProgress?.({ phase: "Opening OME-Zarr", detail: `${detected.zarrMembers.size} members`, ratio: 0.15 });
    const viv = await loadVivOmeZarrFiles(detected.zarrMembers);
    return fromVivLoader(detected, opts, viv, "OME-Zarr", onProgress);
  }
  if (detected.kind === "ome-tiff" && detected.files.length === 1) {
    const staged = detected.files[0];
    onProgress?.({ phase: "Opening OME-TIFF", detail: staged.relPath, ratio: 0.1 });
    try {
      const viv = await loadVivImage(staged.file);
      if (viv.levels > 1) return await fromVivLoader(detected, opts, viv, "OME-TIFF pyramid", onProgress);
      // Flat OME-TIFF: decode it ourselves and build a pyramid so panning stays
      // cheap, keeping the OME channel names/colors we just read.
      onProgress?.({ phase: "No pyramid in file", detail: "building one in the browser", ratio: 0.15 });
      const named = withOmeNames(detected, viv);
      const out = await fromImageFiles(named, opts, onProgress);
      out.notes.push("This OME-TIFF has no sub-resolutions; FluoroView built a pyramid in the browser.");
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onProgress?.({ phase: "Retrying as plain TIFF", detail: msg, ratio: 0.15 });
      const out = await fromImageFiles(detected, opts, onProgress);
      out.notes.push(`OME-TIFF metadata could not be used (${msg}); loaded as a plain TIFF.`);
      return out;
    }
  }
  if (detected.kind === "images" || detected.kind === "ome-tiff") return fromImageFiles(detected, opts, onProgress);
  throw new Error(detected.message ?? "Nothing loadable in that drop.");
}

/** Carry OME channel names/colors onto the staged files for the decode path. */
function withOmeNames(detected: Detected, viv: LoadedVivImage): Detected {
  if (detected.files.length !== 1 || viv.channels.length === 0) return detected;
  const first = detected.files[0];
  const staged: StagedFile = { ...first, name: viv.channels[0].name || first.name };
  return { ...detected, files: [staged] };
}

/** Open a remote OME-TIFF / OME-Zarr by URL (no upload, streams over HTTP). */
export async function buildUrlDataset(url: string, opts: BuildOptions = {}, onProgress?: Progress): Promise<UploadedDataset> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("Enter an http(s) URL to an OME-TIFF file or an OME-Zarr group.");
  const isZarr = /\.zarr\/?$/.test(trimmed) || /\.zarr\//.test(trimmed);
  onProgress?.({ phase: isZarr ? "Opening OME-Zarr" : "Opening OME-TIFF", detail: trimmed, ratio: 0.1 });
  const viv = isZarr ? await loadVivOmeZarrUrl(trimmed.replace(/\/$/, "")) : await loadVivImage(trimmed);
  const name = trimmed.replace(/\/$/, "").split("/").pop() || trimmed;
  const detected: Detected = { kind: isZarr ? "ome-zarr-dir" : "ome-tiff", files: [], mask: null, warnings: [] };
  return fromVivLoader({ ...detected }, { ...opts, label: opts.label ?? name }, viv, isZarr ? "remote OME-Zarr" : "remote OME-TIFF", onProgress);
}

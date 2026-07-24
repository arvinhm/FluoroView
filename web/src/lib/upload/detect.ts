import type { Detected, StagedFile, UploadFileKind } from "./types";
import { assignChannelColors, cleanChannelName, guessChannelKind, looksLikeMask } from "./names";

/** Files carried by a drop or a file input, with their folder-relative paths. */
export interface RawFile {
  file: File;
  relPath: string;
}

const ZARR_MARKERS = [".zattrs", ".zgroup", ".zarray", "zarr.json"];

export function classifyFile(relPath: string): UploadFileKind {
  const name = relPath.replace(/^.*[\\/]/, "").toLowerCase();
  if (/\.ome\.tiff?$/.test(name)) return "ome-tiff";
  if (/\.tiff?$/.test(name)) return "tiff";
  if (/\.png$/.test(name)) return "png";
  if (/\.jpe?g$/.test(name)) return "jpeg";
  if (ZARR_MARKERS.includes(name) || /\.zarr(\.zip)?$/.test(name)) return "zarr";
  // Chunk files inside a zarr array have no extension (0.0.0 / c/0/0).
  if (/(^|[\\/])c([\\/]\d+)+$/.test(relPath) || /(^|[\\/])\d+(\.\d+)*$/.test(relPath)) return "zarr";
  return "unsupported";
}

let seq = 0;
function stage(raw: RawFile, kind: UploadFileKind): StagedFile {
  seq += 1;
  const name = cleanChannelName(raw.relPath);
  return {
    id: `f${seq}`,
    file: raw.file,
    relPath: raw.relPath,
    kind,
    role: looksLikeMask(raw.relPath) ? "mask" : "channel",
    name,
    color: "#ffffff",
    markerKind: guessChannelKind(name),
    sizeBytes: raw.file.size,
  };
}

/**
 * Classify a drop into one loadable dataset.
 *
 * Heuristics (mirrors UPLOAD_AND_FORMATS §6): an OME-TIFF opens directly as a
 * pyramid; several plain images become one multi-channel merge; a folder
 * containing zarr metadata is an OME-Zarr group; 10x bundles are recognised
 * only to say (honestly) that their ingest lands in a later milestone.
 */
export function detectUpload(raws: RawFile[]): Detected {
  const warnings: string[] = [];
  const files = raws.filter((r) => r.file.size > 0 || classifyFile(r.relPath) === "zarr");
  if (!files.length) return { kind: "empty", files: [], mask: null, warnings };

  const lower = files.map((f) => f.relPath.toLowerCase());
  if (lower.some((p) => p.endsWith("experiment.xenium"))) {
    return {
      kind: "needs-ingest",
      files: [],
      mask: null,
      warnings,
      message:
        "This looks like a 10x Xenium bundle. Xenium ingestion (JPEG-2000 morphology transcode + Morton-tiled transcripts) is the next milestone — for now convert the morphology image to a pyramidal OME-TIFF/OME-Zarr and drop that.",
    };
  }
  if (lower.some((p) => p.includes("binned_outputs/") || p.includes("tissue_positions"))) {
    return {
      kind: "needs-ingest",
      files: [],
      mask: null,
      warnings,
      message:
        "This looks like a 10x Visium HD bundle. Visium HD ingestion (pyramid + bin rasterisation + chunked matrix) is the next milestone — for now drop a pyramidal OME-TIFF/OME-Zarr of the microscope image.",
    };
  }

  // OME-Zarr: a directory carrying zarr metadata. The group root is the deepest
  // directory that holds .zattrs/zarr.json with multiscales in it (we let the
  // loader decide, and just index every member relative to that root).
  const zarrMeta = files.find((f) => {
    const base = f.relPath.replace(/^.*[\\/]/, "").toLowerCase();
    return base === ".zattrs" || base === "zarr.json" || base === ".zgroup";
  });
  if (zarrMeta) {
    const root = zarrMeta.relPath.replace(/[^\\/]*$/, "").replace(/[\\/]+$/, "");
    const members = new Map<string, File>();
    for (const f of files) {
      if (root && !f.relPath.startsWith(root)) continue;
      const key = (root ? f.relPath.slice(root.length) : f.relPath).replace(/^[\\/]+/, "");
      members.set(key, f.file);
    }
    return { kind: "ome-zarr-dir", files: [], mask: null, zarrMembers: members, zarrRoot: root, warnings };
  }

  const staged = files.map((f) => stage(f, classifyFile(f.relPath)));
  const usable = staged.filter((s) => s.kind !== "unsupported" && s.kind !== "zarr");
  const rejected = staged.filter((s) => s.kind === "unsupported");
  if (rejected.length) {
    warnings.push(`Ignored ${rejected.length} unsupported file${rejected.length > 1 ? "s" : ""}: ${rejected.slice(0, 3).map((r) => r.relPath).join(", ")}${rejected.length > 3 ? "…" : ""}`);
  }
  if (!usable.length) {
    return {
      kind: "unsupported",
      files: [],
      mask: null,
      warnings,
      message:
        "No readable image found. FluoroView opens OME-TIFF (pyramidal or flat), plain TIFF, PNG and JPEG, plus OME-Zarr folders and URLs.",
    };
  }

  const masks = usable.filter((s) => s.role === "mask");
  const channels = usable.filter((s) => s.role === "channel");
  // A mask on its own is almost always meant for the dataset already open, so it
  // keeps the mask role; the review step lets the user switch it to a channel to
  // just look at the label image instead.
  if (!channels.length && masks.length) return finish("images", [], masks[0], warnings);
  if (masks.length > 1) warnings.push(`${masks.length} files look like masks; using ${masks[0].relPath}. Set the others to "channel" if that's wrong.`);
  const mask = masks[0] ?? null;

  const omeTiffs = channels.filter((s) => s.kind === "ome-tiff");
  if (omeTiffs.length === 1 && channels.length === 1) return finish("ome-tiff", omeTiffs, mask, warnings);
  if (omeTiffs.length >= 1 && channels.length > omeTiffs.length) {
    warnings.push("Mixed OME-TIFF and plain images — loading them all as single-plane channels.");
  }
  if (omeTiffs.length > 1) {
    warnings.push("Multiple OME-TIFFs dropped — merging their first planes as channels. Drop one OME-TIFF alone to stream its full pyramid.");
  }
  return finish("images", channels, mask, warnings);
}

function finish(kind: Detected["kind"], channels: StagedFile[], mask: StagedFile | null, warnings: string[]): Detected {
  const sorted = channels.slice().sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true }));
  const colors = assignChannelColors(sorted.map((s) => s.name));
  sorted.forEach((s, i) => (s.color = colors[i]));
  if (mask) mask.color = "#67e8f9";
  return { kind, files: sorted, mask, warnings };
}

/** Read files (including dropped folders) out of a DataTransfer. */
export async function readDataTransfer(dt: DataTransfer): Promise<RawFile[]> {
  const entries: FileSystemEntry[] = [];
  const items = Array.from(dt.items ?? []);
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  if (entries.length) {
    const out: RawFile[] = [];
    for (const e of entries) await walkEntry(e, "", out);
    if (out.length) return out;
  }
  return Array.from(dt.files ?? []).map((file) => ({ file, relPath: file.name }));
}

interface FileSystemEntryLike extends FileSystemEntry {
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (cb: (es: FileSystemEntry[]) => void, err: (e: unknown) => void) => void };
}

const MAX_ENTRIES = 20000;

async function walkEntry(entry: FileSystemEntry, prefix: string, out: RawFile[]): Promise<void> {
  if (out.length > MAX_ENTRIES) return;
  const e = entry as FileSystemEntryLike;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile && e.file) {
    const file = await new Promise<File | null>((res) => e.file!((f) => res(f), () => res(null)));
    if (file) out.push({ file, relPath: path });
    return;
  }
  if (entry.isDirectory && e.createReader) {
    const reader = e.createReader();
    // readEntries returns at most ~100 entries per call — drain it.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res) => reader.readEntries((es) => res(es), () => res([])));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, path, out);
    }
  }
}

/** Read files from an `<input type="file">` (supports `webkitdirectory`). */
export function readFileList(list: FileList | null): RawFile[] {
  if (!list) return [];
  return Array.from(list).map((file) => ({
    file,
    relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

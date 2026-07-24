import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, FileImage, FolderOpen, Grid2x2Check, Link2, Loader2, ShapesIcon, Upload, X } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";
import { detectUpload, readDataTransfer, readFileList, type RawFile } from "../../lib/upload/detect";
import { buildUploadedDataset, buildUrlDataset } from "../../lib/upload/buildDataset";
import { buildMaskInWorker } from "../../lib/upload/workerClient";
import { DEFAULT_BUDGET_BYTES } from "../../lib/upload/jobs";
import type { Detected, StagedFile, UploadProgress } from "../../lib/upload/types";
import type { NumArray } from "../../lib/upload/pyramid";
import { LUT_PALETTE } from "../../lib/upload/names";

const ACCEPT = ".tif,.tiff,.ome.tif,.ome.tiff,.png,.jpg,.jpeg,.zarr,.zattrs,.zgroup,.json";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function UploadDialog({ open, onClose, pending }: { open: boolean; onClose: () => void; pending?: RawFile[] | null }) {
  const addUpload = useStore((s) => s.addUpload);
  const applyMask = useStore((s) => s.applyMask);
  const tissue = useStore((s) => s.tissue);
  const maps = useStore((s) => s.maps);
  const channels = useStore((s) => s.channels);
  const datasetLabel = useStore((s) => s.datasetLabel);

  const [detected, setDetected] = useState<Detected | null>(null);
  const [label, setLabel] = useState("");
  const [pixelSize, setPixelSize] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setDetected(null);
    setLabel("");
    setPixelSize("");
    setUrl("");
    setBusy(false);
    setProgress(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const stage = useCallback((raws: RawFile[]) => {
    setError(null);
    const det = detectUpload(raws);
    if (det.kind === "empty") {
      setError("No files found in that drop.");
      return;
    }
    if (det.kind === "unsupported" || det.kind === "needs-ingest") {
      setError(det.message ?? "Unsupported input.");
      setDetected(null);
      return;
    }
    setDetected(det);
  }, []);

  // Files dropped anywhere in the Studio arrive here already read.
  useEffect(() => {
    if (open && pending && pending.length) stage(pending);
  }, [open, pending, stage]);

  const patchFile = (id: string, patch: Partial<StagedFile>) => {
    setDetected((cur) => {
      if (!cur) return cur;
      const all = [...cur.files, ...(cur.mask ? [cur.mask] : [])].map((f) => (f.id === id ? { ...f, ...patch } : f));
      const files = all.filter((f) => f.role === "channel");
      const mask = all.find((f) => f.role === "mask") ?? null;
      return { ...cur, files, mask };
    });
  };

  const maskOnly = !!detected && detected.files.length === 0 && !!detected.mask;
  const canAttachMask = maskOnly && !!tissue && !!maps;

  const load = async () => {
    if (!detected) return;
    setBusy(true);
    setError(null);
    setProgress({ phase: "Starting", ratio: 0 });
    const um = pixelSize.trim() ? Number(pixelSize.trim()) : null;
    if (pixelSize.trim() && (!Number.isFinite(um) || (um as number) <= 0)) {
      setError("Pixel size must be a positive number of microns, or left blank.");
      setBusy(false);
      return;
    }
    try {
      if (maskOnly && canAttachMask) {
        const mask = detected.mask!;
        const result = await buildMaskInWorker(
          {
            file: mask.file,
            relPath: mask.relPath,
            worldWidth: tissue!.width,
            worldHeight: tissue!.height,
            intensity: {
              planes: maps!.maps as unknown as NumArray[],
              width: maps!.width,
              height: maps!.height,
              domains: channels.map((c) => c.domain),
            },
          },
          setProgress
        );
        const cells = result.cells.map((c) => ({
          id: c.id,
          x: c.x,
          y: c.y,
          r: Math.max(1, Math.sqrt(Math.max(c.area, 1) / Math.PI)),
          typeIndex: 0,
          markers: c.markers,
        }));
        const polys = result.rings
          .map((ring, i) => {
            if (ring.length < 6) return null;
            const path: [number, number][] = [];
            for (let p = 0; p < ring.length; p += 2) path.push([ring[p], ring[p + 1]]);
            return { id: result.cells[i].id, path };
          })
          .filter((p): p is { id: number; path: [number, number][] } => !!p);
        applyMask(cells, polys, `Uploaded mask (${mask.relPath})`, [
          `Segmentation from ${mask.relPath}: ${result.labelCount.toLocaleString()} labels; per-cell intensities sampled from the preview level.`,
          ...result.notes,
        ]);
        toast.success("Mask applied", `${result.labelCount.toLocaleString()} cells on ${datasetLabel}`);
        onClose();
        return;
      }
      const built = await buildUploadedDataset(detected, { label, pixelSizeUm: um, budgetBytes: DEFAULT_BUDGET_BYTES }, setProgress);
      await addUpload(built);
      toast.success("Dataset opened", `${built.def.channels.length} channel(s)${built.def.nCells ? ` · ${built.def.nCells.toLocaleString()} cells` : ""}`);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setBusy(false);
      setProgress(null);
    }
  };

  const openUrl = async () => {
    setBusy(true);
    setError(null);
    setProgress({ phase: "Connecting", ratio: 0.05 });
    try {
      const built = await buildUrlDataset(url, { label }, setProgress);
      await addUpload(built);
      toast.success("Remote dataset opened", built.def.short);
      onClose();
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)} — remote files need CORS enabled on the host.`);
      setBusy(false);
      setProgress(null);
    }
  };

  const totalBytes = useMemo(() => {
    if (!detected) return 0;
    return [...detected.files, ...(detected.mask ? [detected.mask] : [])].reduce((a, f) => a + f.sizeBytes, 0);
  }, [detected]);

  if (!open) return null;

  const staged = detected ? [...detected.files, ...(detected.mask ? [detected.mask] : [])] : [];

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Upload data">
      <motion.div className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={() => !busy && onClose()} />
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-900/95 shadow-panel"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-cyan-400/15 text-cyan-300">
              <Upload className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-bold text-white">Upload your own sample</h2>
              <p className="text-[11px] text-white/45">Everything is processed in this browser tab — no server, no file leaves your machine.</p>
            </div>
          </div>
          <button onClick={() => !busy && onClose()} className="rounded-lg p-1.5 text-white/45 transition hover:bg-white/10 hover:text-white" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragging(false);
              stage(await readDataTransfer(e.dataTransfer));
            }}
            className={clsx(
              "rounded-2xl border-2 border-dashed px-5 py-7 text-center transition",
              dragging ? "border-cyan-400/70 bg-cyan-400/[0.07]" : "border-white/15 bg-white/[0.02]"
            )}
          >
            <FileImage className="mx-auto h-7 w-7 text-white/35" />
            <p className="mt-2.5 text-sm font-semibold text-white/85">Drag &amp; drop your images here</p>
            <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-white/45">
              Pyramidal <b className="text-white/70">OME-TIFF</b> streams tile-by-tile. Plain <b className="text-white/70">TIFF / PNG / JPEG</b> load directly — drop several
              single-channel files at once to merge them into one multi-channel dataset. Add a <b className="text-white/70">label mask</b> (uint8/16/32) to get cell
              outlines, ROI stats and clustering on your own segmentation.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button onClick={() => filesRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-400/20 px-3.5 py-2 text-xs font-semibold text-cyan-100 ring-1 ring-cyan-300/40 transition hover:bg-cyan-400/30">
                <FileImage className="h-3.5 w-3.5" /> Choose files
              </button>
              <button onClick={() => folderRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-xl bg-white/[0.06] px-3.5 py-2 text-xs font-semibold text-white/75 transition hover:bg-white/[0.12] hover:text-white">
                <FolderOpen className="h-3.5 w-3.5" /> Choose folder (OME-Zarr)
              </button>
            </div>
            <input ref={filesRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { stage(readFileList(e.target.files)); e.currentTarget.value = ""; }} />
            <input
              ref={folderRef}
              type="file"
              multiple
              className="hidden"
              // @ts-expect-error non-standard but supported in Chromium/WebKit
              webkitdirectory="true"
              directory="true"
              onChange={(e) => { stage(readFileList(e.target.files)); e.currentTarget.value = ""; }}
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-white/35" />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="…or paste a URL to a remote OME-TIFF / OME-Zarr (CORS required)"
              className="min-w-0 flex-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-xs text-white/85 outline-none placeholder:text-white/30 focus:bg-white/[0.09]"
            />
            <button
              onClick={() => void openUrl()}
              disabled={!url.trim() || busy}
              className="rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-xs font-semibold text-white/75 transition hover:bg-white/[0.13] hover:text-white disabled:opacity-40"
            >
              Open
            </button>
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-100">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-rose-300" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {detected && detected.warnings.length > 0 && (
            <ul className="mt-3 space-y-1">
              {detected.warnings.map((w) => (
                <li key={w} className="flex items-start gap-2 rounded-lg bg-amber-400/[0.08] px-3 py-2 text-[11px] leading-relaxed text-amber-100/90">
                  <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-300" /> {w}
                </li>
              ))}
            </ul>
          )}

          {detected?.kind === "ome-zarr-dir" && (
            <p className="mt-3 rounded-xl bg-white/[0.04] px-3 py-2.5 text-[11px] leading-relaxed text-white/60">
              OME-Zarr group detected ({detected.zarrMembers?.size.toLocaleString()} member files). Channel names, colors and pixel size come from its <code>omero</code> /
              <code> multiscales</code> metadata.
            </p>
          )}

          {staged.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">
                  Review before loading · {staged.length} file{staged.length > 1 ? "s" : ""} · {formatBytes(totalBytes)}
                </h3>
                <button onClick={() => setDetected(null)} className="text-[11px] text-white/40 transition hover:text-white/80">
                  clear
                </button>
              </div>
              <div className="overflow-hidden rounded-xl border border-white/10">
                <table className="w-full text-left text-xs">
                  <thead className="bg-white/[0.04] text-[10px] uppercase tracking-wider text-white/45">
                    <tr>
                      <th className="px-2.5 py-2 font-semibold">File</th>
                      <th className="px-2.5 py-2 font-semibold">Use as</th>
                      <th className="px-2.5 py-2 font-semibold">Channel name</th>
                      <th className="px-2.5 py-2 font-semibold">LUT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staged.map((f) => (
                      <tr key={f.id} className="border-t border-white/[0.06]">
                        <td className="max-w-[190px] px-2.5 py-1.5">
                          <div className="truncate text-white/80" title={f.relPath}>
                            {f.relPath}
                          </div>
                          <div className="text-[10px] text-white/35">
                            {f.kind} · {formatBytes(f.sizeBytes)}
                          </div>
                        </td>
                        <td className="px-2.5 py-1.5">
                          <select
                            value={f.role}
                            onChange={(e) => patchFile(f.id, { role: e.target.value as StagedFile["role"] })}
                            className="cursor-pointer rounded-md bg-white/[0.06] px-1.5 py-1 text-[11px] text-white/80 outline-none"
                            aria-label={`Role for ${f.relPath}`}
                          >
                            <option className="bg-ink-800" value="channel">
                              channel
                            </option>
                            <option className="bg-ink-800" value="mask">
                              label mask
                            </option>
                          </select>
                        </td>
                        <td className="px-2.5 py-1.5">
                          {f.role === "channel" ? (
                            <input
                              value={f.name}
                              onChange={(e) => patchFile(f.id, { name: e.target.value })}
                              className="w-full min-w-0 rounded-md bg-white/[0.06] px-1.5 py-1 text-[11px] text-white/85 outline-none focus:bg-white/[0.1]"
                              aria-label={`Name for ${f.relPath}`}
                            />
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-cyan-200/80">
                              <ShapesIcon className="h-3 w-3" /> cells + outlines
                            </span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5">
                          {f.role === "channel" && (
                            <div className="flex items-center gap-1">
                              <label className="relative h-5 w-7 cursor-pointer overflow-hidden rounded ring-1 ring-white/20" style={{ background: f.color }} title="Channel color">
                                <input type="color" value={f.color} onChange={(e) => patchFile(f.id, { color: e.target.value })} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
                              </label>
                              {LUT_PALETTE.slice(0, 5).map((c) => (
                                <button key={c} onClick={() => patchFile(f.id, { color: c })} className="h-3.5 w-3.5 rounded-full ring-1 ring-white/20 transition hover:scale-110" style={{ background: c }} aria-label={`Set ${c}`} />
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold text-white/50">Dataset name</span>
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="optional"
                    className="w-full rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-xs text-white/85 outline-none placeholder:text-white/25 focus:bg-white/[0.09]"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold text-white/50">Pixel size (µm/px)</span>
                  <input
                    value={pixelSize}
                    onChange={(e) => setPixelSize(e.target.value)}
                    placeholder="read from metadata; blank = unknown"
                    className="w-full rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-xs text-white/85 outline-none placeholder:text-white/25 focus:bg-white/[0.09]"
                  />
                </label>
              </div>
              {maskOnly && (
                <p className="mt-3 flex items-start gap-2 rounded-xl bg-cyan-400/[0.08] px-3 py-2.5 text-[11px] leading-relaxed text-cyan-100/90">
                  <Grid2x2Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  {canAttachMask
                    ? `Only a label mask was dropped — it will be applied to the active dataset (${datasetLabel}), giving it your cell outlines and per-cell stats.`
                    : "Only a label mask was dropped, but there's no active image to attach it to. Load or upload an image first."}
                </p>
              )}
            </div>
          )}

          <details className="mt-4 rounded-xl bg-white/[0.03] px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-semibold text-white/55">What loads, and what needs converting first</summary>
            <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-white/50">
              <p>
                <b className="text-white/75">Best:</b> pyramidal, tiled OME-TIFF or OME-Zarr — any size, because only the visible tiles are read.
              </p>
              <p>
                <b className="text-white/75">Direct:</b> plain TIFF (8/16/32-bit, multi-page = channels), PNG and JPEG (8-bit). FluoroView builds a pyramid for them in a
                background worker.
              </p>
              <p>
                <b className="text-white/75">Bounded:</b> decoded pixels are capped at {Math.round(DEFAULT_BUDGET_BYTES / (1024 * 1024))} MB. A larger flat image is
                displayed downsampled (you'll be told by how much) — convert it to a pyramidal OME-TIFF/OME-Zarr for full resolution.
              </p>
              <p>
                <b className="text-white/75">Not yet:</b> raw 10x Xenium / Visium HD bundles, JPEG-2000-compressed OME-TIFF, and HDF5 matrices. Those need the one-time
                ingest step and land in a later release.
              </p>
              <p>Uploads live in this tab's memory for the session only, and at most 10 channels can be composited at once (GPU limit).</p>
            </div>
          </details>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3">
          <div className="min-w-0 flex-1">
            <AnimatePresence>
              {progress && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <div className="flex items-center gap-2 text-[11px] text-white/60">
                    <Loader2 className="h-3 w-3 animate-spin text-cyan-300" />
                    <span className="truncate">
                      {progress.phase}
                      {progress.detail ? ` — ${progress.detail}` : ""}
                    </span>
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-[width] duration-200" style={{ width: `${Math.round(Math.max(0.03, Math.min(1, progress.ratio)) * 100)}%` }} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => !busy && onClose()} className="rounded-xl px-3 py-2 text-xs font-semibold text-white/55 transition hover:text-white disabled:opacity-40" disabled={busy}>
              Cancel
            </button>
            <button
              onClick={() => void load()}
              disabled={busy || !detected || (maskOnly && !canAttachMask)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-400/25 px-4 py-2 text-xs font-bold text-cyan-50 ring-1 ring-cyan-300/45 transition hover:bg-cyan-400/35 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {maskOnly ? "Apply mask" : "Open dataset"}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

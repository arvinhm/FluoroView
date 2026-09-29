/**
 * FluoroView's engine, in the browser: it opens the scans the user picks, builds their zoom levels and exact
 * histograms in workers on this computer, and answers the studio's viewing requests the way the engine's
 * HTTP API does. Regions, notes, measurements, exports and sessions are not in the browser version yet.
 */

import pkg from "../../package.json";
import { ApiError } from "../api/errors";
import type {
  BuildInfo, BuildState, DatasetInfo, EngineEvent, Histogram, LevelInfo, Patch, Project, SavedDisplay, TileResult,
} from "../api/types";
import { TILE, histogramSummary, planLevels } from "./pyramid";
import { type Pixels, type Source, openSource } from "./source";
import type { WorkerReply, WorkerRequest } from "./worker";

export const NOT_IN_BROWSER = "This is not in the browser version yet.";
const VERSION = `${pkg.version} (browser)`;
/** part of every dataset id, so a change to the cache layout never reads an older cache */
const CACHE_FORMAT = 1;
const BAND_BYTES = 256 * 2 ** 20;
const PUBLISH_MS = 100;
const DISPLAY_KEY = "fluoroview.web.display.";

interface Group {
  worker: Worker;
  channels: number[];
  rowsDone: number;
  done: boolean;
  cached: boolean;
}

/** A chunk or rows asked of a worker: the data, null when it is not there (yet), or an error. */
interface Waiting {
  resolve: (data: ArrayBuffer | null) => void;
  reject: (error: Error) => void;
}

class LocalDataset {
  readonly levels: LevelInfo[];
  /** compressed or scattered sources keep full resolution in the cache; plain planes are read from the file */
  readonly level0Cached: boolean;
  readonly ready: number[][];
  readonly histograms: (Float64Array | null)[];
  state: BuildState = "building";
  progress = 0;
  seconds: number | null = null;
  error: string | null = null;
  readonly started = performance.now();
  publishedAt = 0;
  readonly groups: Group[] = [];
  readonly owner: number[] = [];
  readonly bands = new Map<string, Pixels>();
  bandBytes = 0;
  readonly inflight = new Map<string, Promise<Pixels>>();

  constructor(readonly id: string, readonly source: Source) {
    const { width, height, channels, layout } = source.info;
    this.levels = planLevels(width, height);
    this.level0Cached = layout !== "contiguous";
    this.ready = channels.map(() => this.levels.map((lv, k) => (k === 0 && !this.level0Cached ? lv.height : 0)));
    this.histograms = channels.map(() => null);
  }
}

async function datasetId(files: File[]): Promise<string> {
  const parts: BlobPart[] = [`fluoroview-web ${CACHE_FORMAT}\n`];
  for (const f of files) {
    parts.push(`${f.name}\0${f.size}\0${f.lastModified}\n`, await f.slice(0, 65536).arrayBuffer());
  }
  const digest = await crypto.subtle.digest("SHA-256", await new Blob(parts).arrayBuffer());
  return [...new Uint8Array(digest).subarray(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function crop(band: Pixels, width: number, x0: number, cols: number, rows: number): Pixels {
  const out = band instanceof Uint16Array ? new Uint16Array(rows * cols) : new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) out.set(band.subarray(r * width + x0, r * width + x0 + cols), r * cols);
  return out;
}

function integer(value: string | null | undefined, name: string, fallback?: number): number {
  if ((value === null || value === undefined) && fallback !== undefined) return fallback;
  const n = Number(value);
  if (value === null || value === undefined || !Number.isInteger(n)) throw new ApiError(422, `${name} must be an integer`);
  return n;
}

export class LocalEngine {
  private readonly datasets = new Map<string, LocalDataset>();
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly waiting = new Map<number, Waiting>();
  private seq = 0;

  /** Open a TIFF scan, or single-channel files of the same size as the channels of one image. */
  async open(files: File[]): Promise<DatasetInfo> {
    let source: Source;
    try {
      source = await openSource(files);
    } catch (e) {
      throw new ApiError(422, e instanceof Error ? e.message : String(e));
    }
    const id = await datasetId(files);
    const existing = this.datasets.get(id);
    if (existing) return this.info(existing);
    const ds = new LocalDataset(id, source);
    this.datasets.set(id, ds);
    this.start(ds);
    return this.info(ds);
  }

  subscribe(onEvent: (e: EngineEvent) => void): () => void {
    this.listeners.add(onEvent);
    onEvent({ type: "hello", version: VERSION });
    return () => void this.listeners.delete(onEvent);
  }

  /** The studio's API requests (paths under /api/v1), answered here. */
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = new URL(path, "https://studio.invalid");
    const [head, id, what, arg, ...rest] = url.pathname.split("/").filter(Boolean);
    const method = (init.method ?? "GET").toUpperCase();
    const query = (name: string, fallback?: number) => integer(url.searchParams.get(name), name, fallback);
    if (head === "health" && method === "GET" && !id) return { version: VERSION, datasets: this.datasets.size };
    if (head === "datasets" && !id) {
      if (method === "GET") return [...this.datasets.values()].map((d) => this.info(d));
      throw new ApiError(422, "Choose the files to open with Open image.");
    }
    if (head === "datasets" && id && !rest.length) {
      const ds = this.dataset(id);
      if (method === "GET" && !what) return this.info(ds);
      if (method === "GET" && what === "histogram" && arg) return this.histogram(ds, integer(arg, "c"), query("bins", 256));
      if (method === "GET" && what === "pixel" && !arg) return this.pixel(ds, query("x"), query("y"));
      if (method === "GET" && what === "patch" && !arg) return this.patch(ds, query("x"), query("y"), query("r", 5));
      if (method === "GET" && what === "project" && !arg) return this.project(ds);
      if (method === "PUT" && what === "display" && !arg) return this.saveDisplay(ds, String(init.body ?? "[]"));
    }
    throw new ApiError(501, NOT_IN_BROWSER);
  }

  async tile(id: string, level: number, c: number, ty: number, tx: number, signal?: AbortSignal): Promise<TileResult> {
    const ds = this.dataset(id);
    if (!(level >= 0 && level < ds.levels.length) || !(c >= 0 && c < ds.ready.length)) {
      throw new ApiError(404, "level or channel out of range");
    }
    const lvl = ds.levels[level]!;
    if (!(ty >= 0 && ty * TILE < lvl.height && tx >= 0 && tx * TILE < lvl.width)) throw new ApiError(404, "tile out of range");
    signal?.throwIfAborted();
    const cols = Math.min(TILE, lvl.width - tx * TILE);
    const rows = Math.min(TILE, lvl.height - ty * TILE);
    if (level === 0 && !ds.level0Cached) {
      const band = await this.band(ds, c, ty);
      return { kind: "data", data: crop(band, lvl.width, tx * TILE, cols, rows), width: cols, height: rows, final: true };
    }
    const ready = ds.ready[c]![level]!;
    if (ready <= ty * TILE) return { kind: "pending" };
    const buffer = await this.chunk(ds, level, c, ty, tx, rows);
    if (!buffer) return { kind: "pending" };
    const data = ds.source.spec.bits === 16 ? new Uint16Array(buffer) : new Uint8Array(buffer);
    return { kind: "data", data, width: cols, height: rows, final: ready >= ty * TILE + rows };
  }

  // -- endpoints --------------------------------------------------------------------------------------

  private dataset(id: string): LocalDataset {
    const ds = this.datasets.get(id);
    if (!ds) throw new ApiError(404, "unknown dataset");
    return ds;
  }

  private info(ds: LocalDataset): DatasetInfo {
    const i = ds.source.info;
    return {
      id: ds.id,
      name: i.name,
      path: i.scanKey,
      folder: "Opened in this browser",
      files: [...i.files],
      width: i.width,
      height: i.height,
      dtype: i.dtype,
      channels: i.channels.map((ch) => ({ ...ch })),
      pixel_size_um: i.pixel_size_um,
      file_pixel_size_um: i.pixel_size_um,
      pixel_size_source: i.pixel_size_um ? "file" : null,
      saturation: i.saturation,
      layout: i.layout,
      vendor: i.vendor,
      acquisition: { ...i.acquisition },
      tile_size: TILE,
      levels: ds.levels.map((lv) => ({ ...lv })),
      build: this.build(ds),
    };
  }

  private build(ds: LocalDataset): BuildInfo {
    return {
      state: ds.state,
      progress: Math.round(ds.progress * 1e4) / 1e4,
      rows_ready: ds.levels.map((_, k) => Math.min(...ds.ready.map((r) => r[k]!))),
      seconds: ds.seconds === null ? null : Math.round(ds.seconds * 1e3) / 1e3,
      error: ds.error,
    };
  }

  private histogram(ds: LocalDataset, c: number, bins: number): Histogram {
    if (!(c >= 0 && c < ds.histograms.length)) throw new ApiError(404, "channel out of range");
    if (!(bins >= 16 && bins <= 65536)) throw new ApiError(422, "bins must be between 16 and 65536");
    const counts = ds.histograms[c];
    if (!counts) throw new ApiError(409, "histogram not available yet");
    return histogramSummary(counts, ds.source.info.saturation, bins, ds.state === "ready");
  }

  private async pixel(ds: LocalDataset, x: number, y: number): Promise<{ x: number; y: number; values: number[] }> {
    const { width, height, channels } = ds.source.info;
    if (!(x >= 0 && x < width && y >= 0 && y < height)) throw new ApiError(404, "pixel out of range");
    const values: number[] = [];
    for (let c = 0; c < channels.length; c++) {
      const region = await this.region(ds, c, x, y, x + 1, y + 1);
      values.push(region[0]!);
    }
    return { x, y, values };
  }

  /** Raw full-resolution values of the (2r+1)² pixels around (x, y), shifted to stay inside the image. */
  private async patch(ds: LocalDataset, x: number, y: number, r: number): Promise<Patch> {
    const { width: w, height: h, channels } = ds.source.info;
    if (!(r >= 1 && r <= 16)) throw new ApiError(422, "r must be between 1 and 16");
    if (!(x >= 0 && x < w && y >= 0 && y < h)) throw new ApiError(404, "pixel out of range");
    const size = Math.min(2 * r + 1, w, h);
    const x0 = Math.min(Math.max(0, x - r), w - size);
    const y0 = Math.min(Math.max(0, y - r), h - size);
    const planes = await Promise.all(channels.map((_, c) => this.region(ds, c, x0, y0, x0 + size, y0 + size)));
    return { x0, y0, size, channels: planes.map((p) => Array.from(p)) };
  }

  /** Full-resolution values of `[x0, x1) × [y0, y1)`, assembled from tiles. */
  private async region(ds: LocalDataset, c: number, x0: number, y0: number, x1: number, y1: number): Promise<Pixels> {
    const w = x1 - x0;
    const out = ds.source.spec.bits === 16 ? new Uint16Array((y1 - y0) * w) : new Uint8Array((y1 - y0) * w);
    for (let ty = Math.floor(y0 / TILE); ty * TILE < y1; ty++) {
      for (let tx = Math.floor(x0 / TILE); tx * TILE < x1; tx++) {
        const t = await this.tile(ds.id, 0, c, ty, tx);
        if (t.kind === "pending" || !t.final) throw new ApiError(409, "pixels not available yet");
        const tx0 = tx * TILE;
        const ty0 = ty * TILE;
        const xa = Math.max(x0, tx0);
        const xb = Math.min(x1, tx0 + t.width);
        for (let y = Math.max(y0, ty0); y < Math.min(y1, ty0 + t.height); y++) {
          const src = (y - ty0) * t.width;
          out.set(t.data.subarray(src + xa - tx0, src + xb - tx0), (y - y0) * w + xa - x0);
        }
      }
    }
    return out;
  }

  private project(ds: LocalDataset): Project {
    let display: SavedDisplay[] | null = null;
    try {
      display = JSON.parse(localStorage.getItem(DISPLAY_KEY + ds.id) ?? "null") as SavedDisplay[] | null;
    } catch {
      display = null;
    }
    return { regions: [], annotations: [], background_region: null, display, counters: [], points: [] };
  }

  private saveDisplay(ds: LocalDataset, body: string): { saved: number } {
    const display = JSON.parse(body) as SavedDisplay[];
    localStorage.setItem(DISPLAY_KEY + ds.id, JSON.stringify(display));
    return { saved: display.length };
  }

  // -- building ---------------------------------------------------------------------------------------

  private start(ds: LocalDataset): void {
    const n = ds.source.info.channels.length;
    const count = Math.max(1, Math.min(n, (navigator.hardwareConcurrency || 4) - 1));
    for (let g = 0; g < count; g++) {
      const channels = Array.from({ length: n }, (_, c) => c).filter((c) => c % count === g);
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      const group: Group = { worker, channels, rowsDone: 0, done: false, cached: false };
      for (const c of channels) ds.owner[c] = g;
      worker.onmessage = (e: MessageEvent<WorkerReply>) => this.onReply(ds, group, e.data);
      worker.onerror = (e) => this.fail(ds, e.message || "A build worker stopped.");
      const start: WorkerRequest = {
        type: "start", key: ds.id, spec: ds.source.spec, channels, levels: ds.levels, level0: ds.level0Cached,
      };
      worker.postMessage(start);
      ds.groups.push(group);
    }
    this.publish(ds, true);
  }

  private onReply(ds: LocalDataset, group: Group, msg: WorkerReply): void {
    switch (msg.type) {
      case "progress":
        this.apply(ds, msg.ready, msg.histograms);
        group.rowsDone = msg.rowsDone;
        this.updateProgress(ds);
        this.publish(ds, false);
        return;
      case "done":
        this.apply(ds, msg.ready, msg.histograms);
        group.done = true;
        group.cached = msg.cached;
        this.updateProgress(ds);
        if (ds.groups.every((g) => g.done)) {
          ds.state = "ready";
          ds.progress = 1;
          ds.seconds = ds.groups.every((g) => g.cached) ? null : (performance.now() - ds.started) / 1000;
        }
        this.publish(ds, true);
        return;
      case "chunk":
        this.settle(msg.id, msg.data, null);
        return;
      case "rows":
        this.settle(msg.id, msg.data, msg.error);
        return;
      case "error":
        this.fail(ds, msg.message);
        return;
      default: {
        const unreachable: never = msg;
        return unreachable;
      }
    }
  }

  private apply(ds: LocalDataset, ready: Record<number, number[]>, histograms: Record<number, Float64Array> | null): void {
    for (const [c, rows] of Object.entries(ready)) ds.ready[Number(c)] = rows;
    if (histograms) for (const [c, h] of Object.entries(histograms)) ds.histograms[Number(c)] = h;
  }

  private updateProgress(ds: LocalDataset): void {
    const height = ds.source.info.height;
    ds.progress = Math.min(...ds.groups.map((g) => (g.done ? height : g.rowsDone))) / height;
  }

  private fail(ds: LocalDataset, message: string): void {
    if (ds.state === "failed") return;
    ds.state = "failed";
    ds.error = message;
    for (const g of ds.groups) g.worker.terminate();
    for (const w of this.waiting.values()) w.resolve(null);
    this.waiting.clear();
    this.publish(ds, true);
  }

  private publish(ds: LocalDataset, always: boolean): void {
    const now = performance.now();
    if (!always && now - ds.publishedAt < PUBLISH_MS) return;
    ds.publishedAt = now;
    const build = { ...this.build(ds), elapsed_s: Math.round(now - ds.started) / 1000 };
    for (const listener of this.listeners) listener({ type: "build", id: ds.id, build });
  }

  // -- reading ----------------------------------------------------------------------------------------

  /** Full-width 512-row band of the source, shared by all tiles in that row (kept in memory, least recently used out). */
  private band(ds: LocalDataset, c: number, ty: number): Promise<Pixels> {
    const key = `${c}/${ty}`;
    const hit = ds.bands.get(key);
    if (hit) {
      ds.bands.delete(key);
      ds.bands.set(key, hit);
      return Promise.resolve(hit);
    }
    let pending = ds.inflight.get(key);
    if (!pending) {
      const y0 = ty * TILE;
      const request: WorkerRequest = { type: "rows", id: 0, c, y0, y1: Math.min(y0 + TILE, ds.source.info.height) };
      pending = this.ask(ds, c, request)
        .then((buffer) => {
          if (!buffer) throw new ApiError(409, "pixels not available yet");
          const band = ds.source.spec.bits === 16 ? new Uint16Array(buffer) : new Uint8Array(buffer);
          ds.bands.set(key, band);
          ds.bandBytes += band.byteLength;
          for (const [k, old] of ds.bands) {
            if (ds.bandBytes <= BAND_BYTES || ds.bands.size <= 1) break;
            ds.bands.delete(k);
            ds.bandBytes -= old.byteLength;
          }
          return band;
        })
        .finally(() => ds.inflight.delete(key));
      ds.inflight.set(key, pending);
    }
    return pending;
  }

  private chunk(ds: LocalDataset, level: number, c: number, ty: number, tx: number, rows: number): Promise<ArrayBuffer | null> {
    return this.ask(ds, c, { type: "chunk", id: 0, level, c, ty, tx, rows });
  }

  /** Ask the worker that owns channel `c` for a chunk or rows. */
  private ask(ds: LocalDataset, c: number, request: Extract<WorkerRequest, { type: "chunk" | "rows" }>): Promise<ArrayBuffer | null> {
    const group = ds.groups[ds.owner[c]!];
    if (!group || ds.state === "failed") return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      group.worker.postMessage({ ...request, id });
    });
  }

  private settle(id: number, data: ArrayBuffer | null, error: string | null): void {
    const w = this.waiting.get(id);
    this.waiting.delete(id);
    if (error) w?.reject(new ApiError(500, error));
    else w?.resolve(data);
  }
}

export const local = new LocalEngine();

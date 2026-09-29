/**
 * A build worker: reads its channels band by band, adds up their exact histograms, writes the zoom levels
 * to the browser's private storage on this computer (OPFS) and serves chunks while and after it builds.
 *
 * Files, per scan: L{level}-C{channel}.bin holds 512 × 512 chunks, padded, in row-major chunk order;
 * hist-C{channel}.bin the full histogram (float64 per value); done-C{channel} marks a finished channel.
 */

import type { LevelInfo } from "../api/types";
import { TILE, accumulate, bandRowsFor, downsample2 } from "./pyramid";
import { type Pixels, type SourceSpec, readRows } from "./source";

export type WorkerRequest =
  | { type: "start"; key: string; spec: SourceSpec; channels: number[]; levels: LevelInfo[]; level0: boolean }
  | { type: "chunk"; id: number; level: number; c: number; ty: number; tx: number; rows: number }
  /** full-resolution rows read from the file, for sources whose planes are not cached */
  | { type: "rows"; id: number; c: number; y0: number; y1: number };

export type WorkerReply =
  | { type: "progress"; rowsDone: number; ready: Record<number, number[]>; histograms: Record<number, Float64Array> | null }
  | { type: "done"; ready: Record<number, number[]>; histograms: Record<number, Float64Array>; cached: boolean }
  | { type: "chunk"; id: number; data: ArrayBuffer | null }
  | { type: "rows"; id: number; data: ArrayBuffer | null; error: string | null }
  | { type: "error"; message: string };

/** OPFS types that TypeScript declares only for worker scopes. */
interface SyncHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

interface Scope {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as Scope;
const FLUSH_MS = 400;
const HISTOGRAM_MS = 250;

let source: SourceSpec | null = null;
let levels: LevelInfo[] = [];
let bytes = 2;
/** open while this worker builds; a sync handle locks its file, so other tabs cannot open it meanwhile */
const handles = new Map<string, SyncHandle>();
/** a finished cache is read through file snapshots, which do not lock, so several tabs can show the scan */
const snapshots = new Map<string, File>();
let chunkBuffer: Pixels = new Uint16Array(0);

async function syncHandle(dir: FileSystemDirectoryHandle, name: string): Promise<SyncHandle> {
  const file = await dir.getFileHandle(name, { create: true });
  return (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  return dir.getFileHandle(name).then(() => true, () => false);
}

function chunkOffset(level: number, ty: number, tx: number): number {
  return (ty * Math.ceil(levels[level]!.width / TILE) + tx) * TILE * TILE * bytes;
}

/** Write `nrows` rows (full level width) as chunk row `ty`, padding each chunk to 512 × 512. */
function writeChunkRow(level: number, c: number, ty: number, rows: Pixels, nrows: number): void {
  const width = levels[level]!.width;
  const handle = handles.get(`${level}/${c}`)!;
  for (let tx = 0; tx * TILE < width; tx++) {
    const x0 = tx * TILE;
    const n = Math.min(TILE, width - x0);
    chunkBuffer.fill(0);
    for (let r = 0; r < nrows; r++) chunkBuffer.set(rows.subarray(r * width + x0, r * width + x0 + n), r * TILE);
    handle.write(chunkBuffer, { at: chunkOffset(level, ty, tx) });
  }
}

interface LevelBuffer {
  rows: Pixels;
  filled: number;
  ty: number;
  flushedAt: number;
}

async function build(dir: FileSystemDirectoryHandle, spec: SourceSpec, channels: number[], level0: boolean): Promise<void> {
  const { width, height } = spec;
  const bandRows = bandRowsFor(levels.length);
  const alloc = (n: number): Pixels => (spec.bits === 16 ? new Uint16Array(n) : new Uint8Array(n));
  const hist: Record<number, Float64Array> = {};
  const ready: Record<number, number[]> = {};
  const buffers: Record<number, LevelBuffer[]> = {};
  for (const c of channels) {
    hist[c] = new Float64Array(spec.bits === 16 ? 65536 : 256);
    ready[c] = levels.map((_, k) => (k === 0 && !level0 ? height : 0));
    buffers[c] = levels.map((lv, k) => ({ rows: alloc(k ? TILE * lv.width : 0), filled: 0, ty: 0, flushedAt: 0 }));
  }
  let histogramAt = 0;
  for (let y0 = 0; y0 < height; y0 += bandRows) {
    const y1 = Math.min(height, y0 + bandRows);
    const last = y1 >= height;
    for (const c of channels) {
      const plane = await readRows(spec, c, y0, y1);
      accumulate(plane, hist[c]!);
      if (level0) {
        for (let r = 0; r < y1 - y0; r += TILE) {
          const n = Math.min(TILE, y1 - y0 - r);
          writeChunkRow(0, c, (y0 + r) / TILE, plane.subarray(r * width, (r + n) * width), n);
        }
        ready[c]![0] = y1;
      }
      const now = performance.now();
      let a = plane;
      let aw = width;
      let ah = y1 - y0;
      for (let k = 1; k < levels.length; k++) {
        ({ data: a, width: aw, height: ah } = downsample2(a, aw, ah));
        const b = buffers[c]![k]!;
        for (let at = 0; at < ah;) {
          const take = Math.min(TILE - b.filled, ah - at);
          b.rows.set(a.subarray(at * aw, (at + take) * aw), b.filled * aw);
          b.filled += take;
          at += take;
          if (b.filled === TILE) {
            writeChunkRow(k, c, b.ty, b.rows, TILE);
            ready[c]![k] = (b.ty + 1) * TILE;
            b.ty++;
            b.filled = 0;
            b.flushedAt = now;
          }
        }
        if (b.filled && (last || now - b.flushedAt >= FLUSH_MS)) {
          writeChunkRow(k, c, b.ty, b.rows, b.filled);
          ready[c]![k] = b.ty * TILE + b.filled;
          b.flushedAt = now;
        }
      }
    }
    const now = performance.now();
    let histograms: Record<number, Float64Array> | null = null;
    if (!last && now - histogramAt >= HISTOGRAM_MS) {
      histogramAt = now;
      histograms = Object.fromEntries(channels.map((c) => [c, hist[c]!.slice()]));
    }
    const transfer = histograms ? Object.values(histograms).map((h) => h.buffer) : [];
    scope.postMessage({ type: "progress", rowsDone: y1, ready, histograms }, transfer);
  }
  for (const handle of handles.values()) handle.flush();
  for (const c of channels) {
    const h = await syncHandle(dir, `hist-C${c}.bin`);
    h.truncate(0);
    h.write(hist[c]!, { at: 0 });
    h.flush();
    h.close();
    const done = await syncHandle(dir, `done-C${c}`);
    done.write(new Uint8Array([1]), { at: 0 });
    done.flush();
    done.close();
  }
  scope.postMessage({ type: "done", ready, histograms: hist, cached: false }, Object.values(hist).map((h) => h.buffer));
}

async function start(msg: Extract<WorkerRequest, { type: "start" }>): Promise<void> {
  source = msg.spec;
  levels = msg.levels;
  bytes = msg.spec.bits / 8;
  chunkBuffer = msg.spec.bits === 16 ? new Uint16Array(TILE * TILE) : new Uint8Array(TILE * TILE);
  let dir = await navigator.storage.getDirectory();
  for (const name of ["fluoroview", "pyramids", msg.key]) dir = await dir.getDirectoryHandle(name, { create: true });
  const cached = (await Promise.all(msg.channels.map((c) => exists(dir, `done-C${c}`)))).every(Boolean);
  const first = msg.level0 ? 0 : 1;
  if (!cached) {
    try {
      for (const c of msg.channels) {
        await dir.removeEntry(`done-C${c}`).catch(() => undefined);
        for (let k = first; k < levels.length; k++) handles.set(`${k}/${c}`, await syncHandle(dir, `L${k}-C${c}.bin`));
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "NoModificationAllowedError") {
        throw new Error("This scan is being read in another FluoroView tab. Wait until it is ready there, then open it again.");
      }
      throw err;
    }
    await build(dir, msg.spec, msg.channels, msg.level0);
    return;
  }
  const histograms: Record<number, Float64Array> = {};
  const ready: Record<number, number[]> = {};
  for (const c of msg.channels) {
    for (let k = first; k < levels.length; k++) {
      snapshots.set(`${k}/${c}`, await (await dir.getFileHandle(`L${k}-C${c}.bin`)).getFile());
    }
    const file = await (await dir.getFileHandle(`hist-C${c}.bin`)).getFile();
    histograms[c] = new Float64Array(await file.arrayBuffer());
    ready[c] = levels.map((lv) => lv.height);
  }
  scope.postMessage({ type: "done", ready, histograms, cached: true }, Object.values(histograms).map((h) => h.buffer));
}

async function serve(msg: Extract<WorkerRequest, { type: "chunk" }>): Promise<void> {
  const key = `${msg.level}/${msg.c}`;
  const at = chunkOffset(msg.level, msg.ty, msg.tx);
  const raw = new Uint8Array(TILE * TILE * bytes);
  const handle = handles.get(key);
  const snapshot = snapshots.get(key);
  if (handle) {
    handle.read(raw, { at });
  } else if (snapshot) {
    raw.set(new Uint8Array(await snapshot.slice(at, at + raw.length).arrayBuffer()));
  } else {
    scope.postMessage({ type: "chunk", id: msg.id, data: null });
    return;
  }
  const cols = Math.min(TILE, levels[msg.level]!.width - msg.tx * TILE);
  const full = bytes === 2 ? new Uint16Array(raw.buffer) : raw;
  const out = bytes === 2 ? new Uint16Array(msg.rows * cols) : new Uint8Array(msg.rows * cols);
  for (let r = 0; r < msg.rows; r++) out.set(full.subarray(r * TILE, r * TILE + cols), r * cols);
  scope.postMessage({ type: "chunk", id: msg.id, data: out.buffer as ArrayBuffer }, [out.buffer as ArrayBuffer]);
}

async function rows(msg: Extract<WorkerRequest, { type: "rows" }>): Promise<void> {
  if (!source) throw new Error("rows requested before the scan was opened");
  const data = await readRows(source, msg.c, msg.y0, msg.y1);
  const own = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
  const buffer = own.buffer as ArrayBuffer;
  scope.postMessage({ type: "rows", id: msg.id, data: buffer, error: null }, [buffer]);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

scope.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "start":
      start(msg).catch((err: unknown) => scope.postMessage({ type: "error", message: message(err) }));
      return;
    case "chunk":
      serve(msg).catch(() => scope.postMessage({ type: "chunk", id: msg.id, data: null }));
      return;
    case "rows":
      rows(msg).catch((err: unknown) => scope.postMessage({ type: "rows", id: msg.id, data: null, error: message(err) }));
      return;
    default: {
      const unreachable: never = msg;
      return unreachable;
    }
  }
};

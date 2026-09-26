import { fetchTile, type TileResult } from "../api/client";
import type { DatasetInfo } from "../api/types";
import { type Camera, chooseLevel, type TileRange, type Viewport, visibleTiles } from "./camera";
import type { DrawCall } from "./renderer";

const MAX_INFLIGHT = 8;
const GPU_BUDGET_BYTES = 384 * 1024 * 1024;
const CPU_TILES = 48;

/** 0 = missing, 1 = partial (pyramid still building), 2 = final */
type LayerState = 0 | 1 | 2;

interface Tile {
  key: string;
  level: number;
  ty: number;
  tx: number;
  width: number;
  height: number;
  texture: WebGLTexture | null;
  layers: LayerState[];
  pending: boolean[];
  stale: boolean[];
  used: number;
  bytes: number;
}

interface Want {
  tile: Tile;
  c: number;
  priority: number;
}

export interface Plan {
  draws: DrawCall[];
  level: number;
  loading: number;
}

export function tileKey(level: number, ty: number, tx: number): string {
  return `${level}/${ty}/${tx}`;
}

function* each(range: TileRange | null): Generator<[number, number]> {
  if (!range) return;
  for (let ty = range.ty0; ty <= range.ty1; ty++) for (let tx = range.tx0; tx <= range.tx1; tx++) yield [ty, tx];
}

export class TileManager {
  private readonly tiles = new Map<string, Tile>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly cpu = new Map<string, Uint16Array | Uint8Array>();
  private readonly T: number;
  private readonly is8: boolean;
  private gpuBytes = 0;
  private frame = 0;
  private disposed = false;

  constructor(private readonly gl: WebGL2RenderingContext, private readonly ds: DatasetInfo,
    private readonly onChange: () => void) {
    this.T = ds.tile_size;
    this.is8 = ds.dtype.endsWith("u1");
  }

  get topLevel(): number {
    return this.ds.levels.length - 1;
  }

  /** Draw list for this frame; also requests missing tiles, nearest to the centre first. */
  plan(cam: Camera, vp: Viewport, channels: number[], smoothMagnify: boolean): Plan {
    this.frame++;
    const top = this.topLevel;
    const level = chooseLevel(cam.scale, this.ds.levels.length);
    const wants: Want[] = [];
    const draws: DrawCall[] = [];
    const [cxT, cyT] = [cam.cx / 2 ** level / this.T, cam.cy / 2 ** level / this.T];

    for (const lvl of level === top ? [top] : [top, level]) {
      const info = this.ds.levels[lvl]!;
      const range = visibleTiles(cam, vp, lvl, info.width, info.height, this.T, lvl === level ? 1 : 0);
      for (const [ty, tx] of each(range)) {
        const t = this.tile(lvl, ty, tx);
        t.used = this.frame;
        const priority = lvl === top ? -1 : Math.hypot(tx + 0.5 - cxT, ty + 0.5 - cyT);
        for (const c of channels) {
          if ((t.layers[c] === 0 && !t.pending[c]) || t.stale[c]) wants.push({ tile: t, c, priority });
        }
      }
    }

    const info = this.ds.levels[level]!;
    for (const [ty, tx] of each(visibleTiles(cam, vp, level, info.width, info.height, this.T))) {
      const t = this.tiles.get(tileKey(level, ty, tx));
      const rect = this.worldRect(level, ty, tx);
      if (t && this.complete(t, channels)) {
        const texelPx = cam.scale * 2 ** level;
        draws.push({ texture: t.texture!, texSize: [t.width, t.height], rect, uv: [0, 0, t.width, t.height],
          smooth: texelPx < 1 || smoothMagnify });
        continue;
      }
      for (let k = 1; level + k <= top; k++) {
        const f = 2 ** k;
        const [aty, atx] = [Math.floor(ty / f), Math.floor(tx / f)];
        const a = this.tiles.get(tileKey(level + k, aty, atx));
        if (!a || !this.complete(a, channels)) continue;
        const w = Math.min(this.T, info.width - tx * this.T);
        const h = Math.min(this.T, info.height - ty * this.T);
        draws.push({ texture: a.texture!, texSize: [a.width, a.height], rect,
          uv: [(tx * this.T) / f - atx * this.T, (ty * this.T) / f - aty * this.T, w / f, h / f], smooth: true });
        break;
      }
    }

    this.schedule(wants);
    this.evict();
    return { draws, level, loading: this.inflight.size + wants.length };
  }

  /** Coarsest-level draws covering the whole image (for the minimap). */
  overview(channels: number[]): DrawCall[] {
    const top = this.topLevel;
    const info = this.ds.levels[top]!;
    const out: DrawCall[] = [];
    for (const [ty, tx] of each({ tx0: 0, tx1: Math.ceil(info.width / this.T) - 1, ty0: 0,
      ty1: Math.ceil(info.height / this.T) - 1 })) {
      const t = this.tiles.get(tileKey(top, ty, tx));
      if (t && this.complete(t, channels)) {
        out.push({ texture: t.texture!, texSize: [t.width, t.height], rect: this.worldRect(top, ty, tx),
          uv: [0, 0, t.width, t.height], smooth: true });
      }
    }
    return out;
  }

  /** Raw value at a full-resolution pixel, if that tile is held on the CPU. */
  valueAt(x: number, y: number, c: number): number | null {
    const [ty, tx] = [Math.floor(y / this.T), Math.floor(x / this.T)];
    const data = this.cpu.get(`${tileKey(0, ty, tx)}:${c}`);
    const t = this.tiles.get(tileKey(0, ty, tx));
    if (!data || !t) return null;
    return data[(y - ty * this.T) * t.width + (x - tx * this.T)] ?? null;
  }

  /** Build progress: re-request tiles whose rows have since been written. */
  onBuild(rowsReady: number[]): void {
    for (const t of this.tiles.values()) {
      if ((rowsReady[t.level] ?? 0) <= t.ty * this.T) continue;
      for (let c = 0; c < t.layers.length; c++) {
        t.pending[c] = false;
        if (t.layers[c] === 1) t.stale[c] = true;
      }
    }
    this.onChange();
  }

  dispose(): void {
    this.disposed = true;
    for (const ctl of this.inflight.values()) ctl.abort();
    this.inflight.clear();
    for (const t of this.tiles.values()) if (t.texture) this.gl.deleteTexture(t.texture);
    this.tiles.clear();
    this.cpu.clear();
  }

  // -- internals ---------------------------------------------------------------------------

  private tile(level: number, ty: number, tx: number): Tile {
    const key = tileKey(level, ty, tx);
    let t = this.tiles.get(key);
    if (!t) {
      const info = this.ds.levels[level]!;
      const n = this.ds.channels.length;
      t = {
        key, level, ty, tx,
        width: Math.min(this.T, info.width - tx * this.T),
        height: Math.min(this.T, info.height - ty * this.T),
        texture: null,
        layers: new Array<LayerState>(n).fill(0),
        pending: new Array<boolean>(n).fill(false),
        stale: new Array<boolean>(n).fill(false),
        used: this.frame,
        bytes: 0,
      };
      this.tiles.set(key, t);
    }
    return t;
  }

  private worldRect(level: number, ty: number, tx: number): [number, number, number, number] {
    const info = this.ds.levels[level]!;
    const f = 2 ** level;
    const w = Math.min(this.T, info.width - tx * this.T);
    const h = Math.min(this.T, info.height - ty * this.T);
    return [tx * this.T * f, ty * this.T * f, w * f, h * f];
  }

  private complete(t: Tile, channels: number[]): boolean {
    return t.texture !== null && channels.every((c) => t.layers[c]! > 0);
  }

  private schedule(wants: Want[]): void {
    const wanted = new Set(wants.map((w) => `${w.tile.key}:${w.c}`));
    for (const [k, ctl] of this.inflight) {
      if (!wanted.has(k)) {
        ctl.abort();
        this.inflight.delete(k);
      }
    }
    wants.sort((a, b) => a.priority - b.priority);
    for (const w of wants) {
      if (this.inflight.size >= MAX_INFLIGHT) break;
      const k = `${w.tile.key}:${w.c}`;
      if (!this.inflight.has(k)) void this.load(w.tile, w.c, k);
    }
  }

  private async load(t: Tile, c: number, k: string): Promise<void> {
    const ctl = new AbortController();
    this.inflight.set(k, ctl);
    let result: TileResult | null = null;
    try {
      result = await fetchTile(this.ds.id, t.level, c, t.ty, t.tx, ctl.signal);
    } catch (err) {
      if (!ctl.signal.aborted) {
        t.pending[c] = true;
        console.warn("tile failed", k, err);
      }
    } finally {
      if (this.inflight.get(k) === ctl) this.inflight.delete(k);
    }
    if (this.disposed || !result || !this.tiles.has(t.key)) return;
    if (result.kind === "pending") {
      t.pending[c] = true;
    } else {
      this.upload(t, c, result.data);
      t.layers[c] = result.final ? 2 : 1;
      t.stale[c] = false;
      if (t.level === 0) this.keepCpu(`${t.key}:${c}`, result.data);
    }
    this.onChange();
  }

  private upload(t: Tile, c: number, data: Uint16Array | Uint8Array): void {
    const gl = this.gl;
    if (!t.texture) {
      t.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t.texture);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, this.is8 ? gl.R8UI : gl.R16UI, t.width, t.height, t.layers.length);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t.bytes = t.width * t.height * t.layers.length * (this.is8 ? 1 : 2);
      this.gpuBytes += t.bytes;
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t.texture);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, c, t.width, t.height, 1, gl.RED_INTEGER,
      this.is8 ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT, data);
  }

  private keepCpu(key: string, data: Uint16Array | Uint8Array): void {
    this.cpu.delete(key);
    this.cpu.set(key, data);
    while (this.cpu.size > CPU_TILES) this.cpu.delete(this.cpu.keys().next().value!);
  }

  private evict(): void {
    if (this.gpuBytes <= GPU_BUDGET_BYTES) return;
    const top = this.topLevel;
    const candidates = [...this.tiles.values()]
      .filter((t) => t.used < this.frame && t.level !== top)
      .sort((a, b) => a.used - b.used);
    for (const t of candidates) {
      if (this.gpuBytes <= GPU_BUDGET_BYTES * 0.85) break;
      if (t.texture) this.gl.deleteTexture(t.texture);
      this.gpuBytes -= t.bytes;
      this.tiles.delete(t.key);
      for (let c = 0; c < t.layers.length; c++) {
        this.inflight.get(`${t.key}:${c}`)?.abort();
        this.cpu.delete(`${t.key}:${c}`);
      }
    }
  }
}

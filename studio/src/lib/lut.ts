/**
 * How a channel's values become colour, step for step as the engine's luts.py computes it for figures:
 * after the window (min to max) and gamma come the tone curve, optional inversion, the tint or colour
 * map, then the intensity. The colour maps are the engine's own table, so the screen and exported
 * figures agree.
 */

import stops from "../../../engine/src/fluoroview/luts.json";
import { hexToRgb } from "./format";

export type ColorMap = keyof typeof stops;
export type Lut = "color" | ColorMap;
export type Blend = "add" | "max";
export type CurvePoint = [number, number];

export const LUT_SIZE = 1024;
export const MAX_CURVE_POINTS = 16;
export const IDENTITY_CURVE: readonly CurvePoint[] = [[0, 0], [1, 1]];
export const COLORMAPS: [ColorMap, string][] = [
  ["grays", "Grays"], ["fire", "Fire"], ["ice", "Ice"], ["viridis", "Viridis"], ["magma", "Magma"], ["inferno", "Inferno"],
];

export interface ChannelLook {
  color: string;
  lut: Lut;
  invert: boolean;
  curve: readonly CurvePoint[];
  intensity: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function isIdentity(curve: readonly CurvePoint[]): boolean {
  return curve.length === 2 && curve[0]![0] === 0 && curve[0]![1] === 0 && curve[1]![0] === 1 && curve[1]![1] === 1;
}

/** Fritsch–Carlson tangents: the cubic through the points is monotone wherever the points are. */
function tangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const d = Array.from({ length: n - 1 }, (_, k) => (ys[k + 1]! - ys[k]!) / (xs[k + 1]! - xs[k]!));
  const m = new Array<number>(n).fill(0);
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1]! * d[k]! <= 0 ? 0 : (d[k - 1]! + d[k]!) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
    }
  }
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) continue;
    const a = m[k]! / d[k]!;
    const b = m[k + 1]! / d[k]!;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[k] = tau * a * d[k]!;
      m[k + 1] = tau * b * d[k]!;
    }
  }
  return m;
}

/** The tone curve through `points` (x increasing from 0 to 1): it passes through every point and never
 * overshoots them. */
export function toneCurve(points: readonly CurvePoint[]): (t: number) => number {
  if (isIdentity(points)) return clamp01;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const m = tangents(xs, ys);
  return (t) => {
    let k = 0;
    while (k < xs.length - 2 && xs[k + 1]! <= t) k++;
    const h = xs[k + 1]! - xs[k]!;
    const s = (t - xs[k]!) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    return clamp01((2 * s3 - 3 * s2 + 1) * ys[k]! + (s3 - 2 * s2 + s) * h * m[k]!
      + (-2 * s3 + 3 * s2) * ys[k + 1]! + (s3 - s2) * h * m[k + 1]!);
  };
}

export function colormapAt(name: ColorMap, y: number): [number, number, number] {
  const rows = stops[name];
  const pos = clamp01(y) * (rows.length - 1);
  const i = Math.min(Math.floor(pos), rows.length - 2);
  const f = pos - i;
  const a = rows[i]!;
  const b = rows[i + 1]!;
  return [(a[0]! + (b[0]! - a[0]!) * f) / 255, (a[1]! + (b[1]! - a[1]!) * f) / 255, (a[2]! + (b[2]! - a[2]!) * f) / 255];
}

/** RGB (0 to 1) for `size` evenly spaced values after the window and gamma, as the engine's channel_lut. */
export function channelLut(look: ChannelLook, size = LUT_SIZE): Float32Array {
  const out = new Float32Array(size * 3);
  const curve = toneCurve(look.curve);
  const [tr, tg, tb] = hexToRgb(look.color);
  for (let i = 0; i < size; i++) {
    let y = curve(i / (size - 1));
    if (look.invert) y = 1 - y;
    const [r, g, b] = look.lut === "color" ? [tr * y, tg * y, tb * y] : colormapAt(look.lut, y);
    out[3 * i] = r * look.intensity;
    out[3 * i + 1] = g * look.intensity;
    out[3 * i + 2] = b * look.intensity;
  }
  return out;
}

export function lookKey(look: ChannelLook): string {
  return JSON.stringify([look.color, look.lut, look.invert, look.curve, look.intensity]);
}

const tables = new Map<string, Float32Array>();

/** The channel's table, computed once per look, with the key that identifies it. */
export function lutFor(look: ChannelLook): { key: string; table: Float32Array } {
  const key = lookKey(look);
  let table = tables.get(key);
  if (!table) {
    if (tables.size >= 128) tables.delete(tables.keys().next().value!);
    table = channelLut(look);
    tables.set(key, table);
  }
  return { key, table };
}

/** Colour of a value `t` (0 to 1, after the window and gamma), interpolated in `table` as the GPU does. */
export function lookup(table: Float32Array, t: number): [number, number, number] {
  const n = table.length / 3;
  const pos = clamp01(t) * (n - 1);
  const i = Math.min(Math.floor(pos), n - 2);
  const f = pos - i;
  const at = (c: number) => table[3 * i + c]! + (table[3 * (i + 1) + c]! - table[3 * i + c]!) * f;
  return [at(0), at(1), at(2)];
}

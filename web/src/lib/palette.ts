// Distinct, vivid cluster palette (color-blind-aware-ish, high contrast on dark)
export const CLUSTER_COLORS = [
  "#22d3ee",
  "#f43f5e",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#fb923c",
  "#f0abfc",
  "#60a5fa",
  "#4ade80",
  "#e879f9",
  "#94a3b8",
  "#facc15",
];

export function clusterColor(i: number): string {
  return CLUSTER_COLORS[i % CLUSTER_COLORS.length];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * LUT color (0–255 RGB) scaled by a per-channel opacity/blend weight. Because
 * multi-channel fluorescence blending is additive/linear, scaling the color is
 * equivalent to scaling that channel's contribution — the zero-risk way to get
 * per-channel opacity through Viv's `colors` prop (no extra shader needed).
 */
export function scaleRgb(hex: string, opacity: number): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  const o = Math.max(0, Math.min(1, opacity));
  return [r * o, g * o, b * o];
}

// True viridis (Smith & van der Walt), sampled at 10 anchors — perceptually
// uniform and safe for red–green colour blindness, which is why it is the
// default for per-cell scalar maps.
const VIRIDIS_ANCHORS: [number, number, number][] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
];

function interp(anchors: [number, number, number][], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (anchors.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = anchors[i];
  const b = anchors[Math.min(anchors.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function viridis(t: number): [number, number, number] {
  return interp(VIRIDIS_ANCHORS, t);
}

export function viridisCss(t: number): string {
  const [r, g, b] = viridis(t);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** CSS gradient stops for a viridis colour-bar legend. */
export function viridisGradient(stops = 8): string {
  const parts: string[] = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    parts.push(`${viridisCss(t)} ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

// Plasma-like ramp kept for the existing marker heatmaps (named `ramp` since v3.0).
const VIRIDIS: [number, number, number][] = [
  [13, 8, 135],
  [84, 2, 163],
  [139, 10, 165],
  [185, 50, 137],
  [219, 92, 104],
  [244, 136, 73],
  [254, 188, 43],
  [240, 249, 33],
];

export function ramp(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[Math.min(VIRIDIS.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function rampCss(t: number): string {
  const [r, g, b] = ramp(t);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

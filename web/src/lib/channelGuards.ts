import type { ChannelState } from "./types";

/** Viv's XRLayer composites at most this many channels in one layer (GPU limit). */
export const MAX_COMPOSITED_CHANNELS = 10;

/**
 * A finite, strictly increasing contrast window.
 *
 * Uploads bring arbitrary bit depths, flat/empty channels and (for 32-bit float
 * data) domains that can collapse. A non-finite or zero-width window divides by
 * zero in the shader, and a single NaN poisons the additive composite — which is
 * exactly how the whole canvas once went black. Every window handed to Viv goes
 * through here.
 */
export function safeContrastLimits(c: Pick<ChannelState, "contrastLimits" | "domain">): [number, number] {
  const [dlo, dhi] = c.domain ?? [0, 1];
  let lo = Number.isFinite(c.contrastLimits?.[0]) ? c.contrastLimits[0] : dlo;
  let hi = Number.isFinite(c.contrastLimits?.[1]) ? c.contrastLimits[1] : dhi;
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = lo + 1;
  if (hi <= lo) hi = lo + Math.max(1e-6, Math.abs(lo) * 1e-3, 1);
  return [lo, hi];
}

/** Per-channel gamma, guarded against 0/NaN (`pow(0, 0)` is NaN on the GPU). */
export function safeGamma(gamma: number): number {
  return Number.isFinite(gamma) && gamma > 0 ? gamma : 1;
}

/**
 * Which channel indices to composite.
 *
 * At or below the GPU limit we send every channel, so toggling visibility is a
 * uniform change and never refetches tiles. Above it we send the visible ones in
 * order (the panel says so), and never an empty selection — that would leave the
 * layer with nothing to draw.
 */
export function pickCompositedChannels(channels: ChannelState[], max = MAX_COMPOSITED_CHANNELS): number[] {
  const n = channels.length;
  if (n === 0) return [];
  if (n <= max) return channels.map((c) => c.index);
  const picked = channels.filter((c) => c.visible).slice(0, max).map((c) => c.index);
  return picked.length ? picked : [channels[0].index];
}

import type { Camera, Viewport } from "./camera";

/**
 * Smooth zoom-and-pan between two views (van Wijk & Nuij, "Smooth and efficient zooming and
 * panning", 2003): the path zooms out while travelling so the eye can follow, then zooms back in.
 * Widths are in world pixels (viewport width / scale).
 */
const RHO = Math.SQRT2;
const EPS = 1e-6;

export interface Flight {
  /** length of the optimal path in its own units; used to pick a duration */
  length: number;
  at: (s: number) => Camera;
}

export function flight(a: Camera, b: Camera, vp: Viewport): Flight {
  const w0 = vp.width / a.scale;
  const w1 = vp.width / b.scale;
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const u1 = Math.hypot(dx, dy);
  const rho2 = RHO * RHO;

  if (u1 < EPS * Math.max(w0, w1)) {
    const k = w1 < w0 ? -1 : 1;
    const length = Math.abs(Math.log(w1 / w0)) / RHO;
    return {
      length,
      at: (t) => {
        const w = w0 * Math.exp(k * RHO * length * t);
        return { cx: a.cx + dx * t, cy: a.cy + dy * t, scale: vp.width / w };
      },
    };
  }

  const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * u1 * u1) / (2 * w0 * rho2 * u1);
  const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * u1 * u1) / (2 * w1 * rho2 * u1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const length = (r1 - r0) / RHO;
  return {
    length,
    at: (t) => {
      const s = t * length;
      const coshR0 = Math.cosh(r0);
      const u = (w0 / rho2) * (coshR0 * Math.tanh(RHO * s + r0) - Math.sinh(r0));
      const w = (w0 * coshR0) / Math.cosh(RHO * s + r0);
      return { cx: a.cx + (dx * u) / u1, cy: a.cy + (dy * u) / u1, scale: vp.width / w };
    },
  };
}

/** Duration for a flight: longer paths take longer, within limits that keep motion brief. */
export function flightDuration(f: Flight, min = 250, max = 700): number {
  return Math.min(max, Math.max(min, f.length * 230));
}

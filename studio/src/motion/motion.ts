/** Motion primitives. Every animation is short, interruptible and skipped under Reduce Motion. */

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export const ease = {
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
};

/**
 * Run `frame(progress)` on animation frames for `duration` ms. Returns a cancel function.
 * Under Reduce Motion the final frame is applied immediately.
 */
export function tween(duration: number, frame: (t: number) => void, curve = ease.outCubic, done?: () => void): () => void {
  if (duration <= 0 || reducedMotion()) {
    frame(1);
    done?.();
    return () => undefined;
  }
  const start = performance.now();
  let id = 0;
  let live = true;
  const step = (now: number) => {
    if (!live) return;
    const t = Math.min(1, (now - start) / duration);
    frame(curve(t));
    if (t < 1) id = requestAnimationFrame(step);
    else done?.();
  };
  id = requestAnimationFrame(step);
  return () => {
    live = false;
    cancelAnimationFrame(id);
  };
}

/** Exponential approach toward a target, frame-rate independent: `tau` ms is the 63% time. */
export function approach(current: number, target: number, dtMs: number, tau: number): number {
  return target + (current - target) * Math.exp(-dtMs / tau);
}

import { useEffect, useRef } from "react";

/**
 * Ambient background: drifting fluorescent "cell" particles on a dark field
 * rendered to a canvas, layered under an aurora gradient + grid + noise.
 * Pure decoration — respects prefers-reduced-motion.
 */
export default function Background() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const colors = ["#22d3ee", "#8b5cf6", "#ec4899", "#34d399", "#60a5fa"];
    type P = { x: number; y: number; r: number; vx: number; vy: number; c: string; a: number };
    let parts: P[] = [];

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(70, Math.floor((w * h) / 26000));
      parts = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 1 + Math.random() * 3.2,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        c: colors[(Math.random() * colors.length) | 0],
        a: 0.15 + Math.random() * 0.4,
      }));
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        if (!reduce) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < -20) p.x = w + 20;
          if (p.x > w + 20) p.x = -20;
          if (p.y < -20) p.y = h + 20;
          if (p.y > h + 20) p.y = -20;
        }
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 7);
        g.addColorStop(0, hexA(p.c, p.a));
        g.addColorStop(1, hexA(p.c, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 7, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-ink-950" />
      <div
        className="absolute -top-1/3 left-1/2 h-[900px] w-[1400px] -translate-x-1/2 rounded-full opacity-[0.22] blur-3xl"
        style={{ background: "radial-gradient(closest-side, #8b5cf6, transparent)" }}
      />
      <div
        className="absolute top-1/4 right-0 h-[600px] w-[600px] rounded-full opacity-[0.16] blur-3xl"
        style={{ background: "radial-gradient(closest-side, #22d3ee, transparent)" }}
      />
      <div
        className="absolute bottom-0 left-0 h-[600px] w-[700px] rounded-full opacity-[0.13] blur-3xl"
        style={{ background: "radial-gradient(closest-side, #ec4899, transparent)" }}
      />
      <canvas ref={ref} className="absolute inset-0 h-full w-full" />
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(circle at 50% 30%, #000 0%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 30%, #000 0%, transparent 75%)",
        }}
      />
      <div className="absolute inset-0 bg-noise" />
    </div>
  );
}

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

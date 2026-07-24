import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { generateTissue, MARKERS } from "../../lib/synth";
import { CELL_TYPES } from "../../lib/synth";

export default function HeroVisual() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 620;
    const H = 500;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const tissue = generateTissue(1500, 11);
    const sx = W / tissue.width;
    const sy = H / tissue.height;

    // Render composite once to an offscreen canvas
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const octx = off.getContext("2d")!;
    octx.fillStyle = "#04060c";
    octx.fillRect(0, 0, W, H);
    octx.globalCompositeOperation = "lighter";
    for (const c of tissue.cells) {
      const x = c.x * sx;
      const y = c.y * sy;
      // DAPI base
      blob(octx, x, y, c.r * sx * 1.1, MARKERS[0].color, c.markers[0] * 0.5);
      // strongest 2 markers
      const top = c.markers
        .map((v, i) => ({ v, i }))
        .filter((o) => o.i !== 0)
        .sort((a, b) => b.v - a.v)
        .slice(0, 2);
      for (const o of top) {
        if (o.v < 0.25) continue;
        blob(octx, x, y, c.r * sx * 1.5, MARKERS[o.i].color, o.v * 0.8);
      }
    }
    octx.globalCompositeOperation = "source-over";

    let raf = 0;
    let t = 0;
    const draw = () => {
      t += 1;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(off, 0, 0);
      // scanning line
      const scanY = ((t * 1.6) % (H + 80)) - 40;
      const grad = ctx.createLinearGradient(0, scanY - 26, 0, scanY + 26);
      grad.addColorStop(0, "rgba(34,211,238,0)");
      grad.addColorStop(0.5, "rgba(103,232,249,0.22)");
      grad.addColorStop(1, "rgba(34,211,238,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, scanY - 26, W, 52);
      ctx.strokeStyle = "rgba(103,232,249,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, scanY);
      ctx.lineTo(W, scanY);
      ctx.stroke();
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative">
      <div className="relative overflow-hidden rounded-[26px] glass-strong p-2 shadow-panel">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          </div>
          <span className="font-mono text-[11px] text-white/50">tumor_margin_ROI · 12-plex</span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-cyan-300">
            <span className="h-1.5 w-1.5 animate-pulseglow rounded-full bg-cyan-300" /> 61 FPS
          </span>
        </div>
        <div className="relative overflow-hidden rounded-2xl">
          <canvas ref={ref} className="block h-auto w-full" style={{ aspectRatio: "620 / 500" }} />
          <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/10" />
        </div>
        <div className="flex flex-wrap gap-1.5 px-2 py-2">
          {["DAPI", "PanCK", "CD3", "CD8", "CD68"].map((m) => {
            const mk = MARKERS.find((x) => x.name === m)!;
            return (
              <span key={m} className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-white/70">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: mk.color, boxShadow: `0 0 6px ${mk.color}` }} />
                {m}
              </span>
            );
          })}
        </div>
      </div>

      <motion.div
        className="absolute -left-6 top-16 hidden rounded-2xl glass-strong px-3.5 py-2.5 shadow-panel sm:block"
        animate={{ y: [0, -10, 0] }}
        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
      >
        <div className="text-[10px] uppercase tracking-wider text-white/45">Cells detected</div>
        <div className="font-mono text-xl font-bold text-white">18,204</div>
      </motion.div>

      <motion.div
        className="absolute -right-5 bottom-16 hidden rounded-2xl glass-strong px-3.5 py-2.5 shadow-panel sm:block"
        animate={{ y: [0, 10, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut", delay: 0.6 }}
      >
        <div className="mb-1 text-[10px] uppercase tracking-wider text-white/45">Phenotypes</div>
        <div className="flex items-center gap-1">
          {CELL_TYPES.slice(0, 6).map((c) => (
            <span key={c.short} className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} title={c.name} />
          ))}
        </div>
      </motion.div>
    </div>
  );
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hexA(color, Math.min(1, a)));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

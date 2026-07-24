import { useEffect, useRef, useState } from "react";
import { useInView } from "framer-motion";
import { Reveal } from "../ui";

const STATS = [
  { label: "Fluorescence channels", value: 12, suffix: "-plex" },
  { label: "Cells per slide", value: 2, suffix: "M+" },
  { label: "Composite framerate", value: 60, suffix: " FPS" },
  { label: "Open source", value: 100, suffix: "%" },
];

export default function StatsBand() {
  return (
    <section className="relative mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <Reveal>
        <div className="grid grid-cols-2 gap-4 rounded-3xl glass p-6 sm:p-8 lg:grid-cols-4">
          {STATS.map((s) => (
            <Counter key={s.label} {...s} />
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function Counter({ label, value, suffix }: { label: string; value: number; suffix: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!inView) return;
    let raf = 0;
    const start = performance.now();
    const dur = 1400;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(value * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value]);

  const display = value >= 10 ? Math.round(n) : n.toFixed(0);
  return (
    <div ref={ref} className="text-center sm:text-left">
      <div className="font-mono text-4xl font-black tracking-tight sm:text-5xl">
        <span className="brand-text">{display}</span>
        <span className="text-2xl text-white/70">{suffix}</span>
      </div>
      <div className="mt-1 text-sm text-white/50">{label}</div>
    </div>
  );
}

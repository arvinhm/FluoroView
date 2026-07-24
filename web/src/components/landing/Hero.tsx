import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { motion } from "framer-motion";
import { ArrowRight, Github, Sparkles, Activity, Layers, Braces } from "lucide-react";
import { useStore } from "../../lib/store";
import HeroVisual from "./HeroVisual";

gsap.registerPlugin(useGSAP);

export default function Hero() {
  const scope = useRef<HTMLDivElement>(null);
  const setView = useStore((s) => s.setView);

  useGSAP(
    () => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      tl.from(".hero-eyebrow", { y: 20, opacity: 0, duration: 0.6 })
        .from(".hero-line", { yPercent: 118, opacity: 0, duration: 0.9, stagger: 0.12 }, "-=0.2")
        .from(".hero-sub", { y: 18, opacity: 0, duration: 0.7 }, "-=0.5")
        .from(".hero-cta", { y: 18, opacity: 0, duration: 0.6, stagger: 0.08 }, "-=0.45")
        .from(".hero-trust", { y: 16, opacity: 0, duration: 0.6 }, "-=0.4")
        .from(".hero-visual", { scale: 0.94, opacity: 0, duration: 1.0, ease: "power2.out" }, "-=0.9");
    },
    { scope }
  );

  return (
    <section ref={scope} className="relative mx-auto max-w-7xl px-4 pb-16 pt-32 sm:px-6 sm:pt-40 lg:pt-44">
      <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <div className="hero-eyebrow mb-5 inline-flex items-center gap-2 rounded-full glass px-3 py-1.5 text-xs font-medium text-white/75">
            <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
            FluoroView v3 · GPU-accelerated spatial biology
          </div>

          <h1 className="text-5xl font-black leading-[1.04] tracking-tight sm:text-6xl lg:text-7xl">
            <span className="block overflow-hidden pb-[0.16em]">
              <span className="hero-line block">Spatial biology,</span>
            </span>
            <span className="block overflow-hidden pb-[0.16em]">
              <span className="hero-line block brand-text">reimagined.</span>
            </span>
          </h1>

          <p className="hero-sub mt-6 max-w-xl text-lg leading-relaxed text-white/65">
            A cinematic web platform for multiplex fluorescence <span className="text-white/90">and</span> H&amp;E.
            Composite 12-plex images on the GPU, run AI cell segmentation, cluster phenotypes, and
            predict <span className="text-white/90">single-cell gene expression directly from H&amp;E</span>.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              onClick={() => setView("viewer")}
              className="hero-cta btn-primary group inline-flex items-center gap-2 rounded-2xl px-6 py-3.5 text-[15px]"
            >
              Launch the Studio
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
            </button>
            <a
              href="https://github.com/arvinhm/FluoroView"
              target="_blank"
              rel="noreferrer"
              className="hero-cta inline-flex items-center gap-2 rounded-2xl glass px-6 py-3.5 text-[15px] font-semibold text-white/85 transition hover:text-white"
            >
              <Github className="h-4 w-4" />
              Star on GitHub
            </a>
          </div>

          <div className="hero-trust mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs text-white/45">
            <Trust icon={<Layers className="h-3.5 w-3.5" />} label="12-plex GPU compositing" />
            <Trust icon={<Activity className="h-3.5 w-3.5" />} label="AI segmentation & clustering" />
            <Trust icon={<Braces className="h-3.5 w-3.5" />} label="Open-source · BSD-3" />
          </div>
        </div>

        <motion.div className="hero-visual">
          <HeroVisual />
        </motion.div>
      </div>
    </section>
  );
}

function Trust({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-cyan-300/80">{icon}</span>
      {label}
    </span>
  );
}

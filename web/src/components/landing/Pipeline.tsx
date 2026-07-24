import { motion } from "framer-motion";
import { ArrowRight, Dna } from "lucide-react";
import { Reveal, SectionLabel, Badge } from "../ui";

const STEPS = [
  { k: "01", t: "H&E slide", d: "Standard brightfield histology — the most abundant data in pathology.", c: "#e879a6" },
  { k: "02", t: "Nuclei segmentation", d: "Detect and delineate every nucleus with a histology-tuned model.", c: "#8b5cf6" },
  { k: "03", t: "Morphology embedding", d: "A vision encoder turns each cell's context into a feature vector.", c: "#22d3ee" },
  { k: "04", t: "Expression prediction", d: "A regression head maps morphology → per-cell transcript levels.", c: "#fbbf24" },
];

export default function Pipeline() {
  return (
    <section className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6">
      <div className="overflow-hidden rounded-[32px] glass-strong p-8 sm:p-12">
        <Reveal>
          <div className="flex flex-wrap items-center gap-3">
            <SectionLabel>Frontier capability</SectionLabel>
            <Badge tone="amber">Experimental</Badge>
          </div>
          <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div>
              <h2 className="text-4xl font-black tracking-tight sm:text-5xl">
                From <span style={{ color: "#e879a6" }}>H&amp;E</span> to{" "}
                <span className="brand-text">single-cell gene expression</span>.
              </h2>
              <p className="mt-5 max-w-xl text-white/60">
                FluoroView v3 ships an experimental pipeline that infers per-cell transcript
                abundance from H&amp;E morphology, letting you paint spatial expression maps for genes
                you never stained for. Predictions are clearly labeled and meant for exploration and
                hypothesis generation — not diagnosis.
              </p>
              <div className="mt-6 flex items-center gap-2 rounded-2xl bg-white/[0.03] px-4 py-3 text-sm text-white/55 ring-1 ring-white/10">
                <Dna className="h-4 w-4 text-amber-300" />
                Inference runs locally in demo mode; connect the backend for model-backed predictions.
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {STEPS.map((s, i) => (
                <motion.div
                  key={s.k}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.12, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  className="relative rounded-2xl bg-white/[0.03] p-5 ring-1 ring-white/10"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="font-mono text-xs text-white/40">{s.k}</span>
                    <span className="h-6 w-6 rounded-lg" style={{ background: `${s.c}22`, boxShadow: `inset 0 0 0 1px ${s.c}55` }} />
                  </div>
                  <div className="text-sm font-bold" style={{ color: s.c }}>{s.t}</div>
                  <div className="mt-1 text-xs leading-relaxed text-white/50">{s.d}</div>
                  {i < STEPS.length - 1 && (
                    <ArrowRight className="absolute -right-2.5 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-white/20 sm:block" />
                  )}
                </motion.div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

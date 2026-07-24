import { motion } from "framer-motion";
import {
  Layers,
  ScanSearch,
  Microscope,
  Network,
  Dna,
  SquareDashedMousePointer,
} from "lucide-react";
import { Reveal, SectionLabel, Badge } from "../ui";

const FEATURES = [
  {
    icon: Layers,
    title: "GPU multiplex compositing",
    body: "Blend up to 12 fluorescence channels in a WebGL2 shader with per-marker LUT color, gain, and gamma — buttery pan/zoom at 60 FPS on whole-slide images.",
    accent: "#22d3ee",
  },
  {
    icon: ScanSearch,
    title: "Modern AI segmentation",
    body: "One-click nuclei & whole-cell segmentation with Cellpose-SAM, StarDist and InstanSeg backends. Tiled inference scales to gigapixel slides.",
    accent: "#8b5cf6",
  },
  {
    icon: Microscope,
    title: "H&E cell segmentation",
    body: "Bring brightfield histology into the same workspace. Detect nuclei on H&E, then quantify morphology and density side-by-side with fluorescence.",
    accent: "#ec4899",
  },
  {
    icon: Network,
    title: "Phenotyping & clustering",
    body: "Standardize, embed (UMAP), and cluster (Leiden / k-means) millions of cells. Threshold-gated phenotypes with Otsu suggestions and spatial neighborhoods.",
    accent: "#34d399",
  },
  {
    icon: Dna,
    title: "H&E → single-cell expression",
    body: "Predict per-cell gene expression directly from H&E morphology and paint spatial expression maps — an experimental deep-learning pipeline.",
    accent: "#fbbf24",
    badge: true,
  },
  {
    icon: SquareDashedMousePointer,
    title: "ROIs, annotations & export",
    body: "Draw regions, drop author-tracked notes, and export publication-ready composites, masks, and per-cell CSVs with embedded scale bars.",
    accent: "#60a5fa",
  },
];

export default function Features() {
  return (
    <section className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6">
      <Reveal>
        <SectionLabel>Everything included</SectionLabel>
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <h2 className="max-w-2xl text-4xl font-black tracking-tight sm:text-5xl">
            One workspace for the entire{" "}
            <span className="brand-text">spatial pipeline</span>.
          </h2>
          <p className="max-w-md text-white/55">
            From raw multiplex TIFFs and H&amp;E slides to phenotyped, clustered, spatially-resolved
            single cells — without leaving the browser.
          </p>
        </div>
      </Reveal>

      <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={i * 0.06}>
            <motion.div
              whileHover={{ y: -6 }}
              transition={{ type: "spring", stiffness: 300, damping: 22 }}
              className="group relative h-full overflow-hidden rounded-3xl glass p-6 card-hover"
            >
              <div
                className="absolute -right-10 -top-10 h-32 w-32 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-40"
                style={{ background: f.accent }}
              />
              <div className="relative">
                <div
                  className="mb-5 grid h-12 w-12 place-items-center rounded-2xl"
                  style={{ background: `${f.accent}1f`, boxShadow: `inset 0 0 0 1px ${f.accent}44` }}
                >
                  <f.icon className="h-6 w-6" style={{ color: f.accent }} strokeWidth={1.9} />
                </div>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-lg font-bold">{f.title}</h3>
                  {f.badge && <Badge tone="amber">Beta</Badge>}
                </div>
                <p className="text-sm leading-relaxed text-white/55">{f.body}</p>
              </div>
            </motion.div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

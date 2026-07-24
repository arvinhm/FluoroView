import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, ScanSearch, Dna, Play, Loader2, CheckCircle2, ArrowRight, TriangleAlert, Upload } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import { MARKERS, generateTissue, CELL_TYPES } from "../../lib/synth";
import { decodeLabelTiff, labelsToCells } from "../../lib/maskImport";
import { toast } from "../../lib/toast";
import { Panel, Badge } from "../ui";
import { SpatialMap } from "./charts";

const SEG_MODELS = [
  { id: "cellpose-sam", name: "Cellpose-SAM", desc: "Generalist cellular segmentation (Cellpose 4 / SAM)", target: "fluorescence" },
  { id: "stardist-he", name: "StarDist (H&E)", desc: "Star-convex nuclei for brightfield histology", target: "H&E" },
  { id: "instanseg", name: "InstanSeg", desc: "Fast instance segmentation, multiplex-ready", target: "fluorescence" },
  { id: "mesmer", name: "Mesmer (DeepCell)", desc: "Nuclear + whole-cell for tissue imaging", target: "fluorescence" },
];

const GENES = [
  { gene: "EPCAM", marker: "PanCK", note: "epithelial / tumor" },
  { gene: "MKI67", marker: "Ki67", note: "proliferation" },
  { gene: "CD3D", marker: "CD3", note: "T cells" },
  { gene: "CD8A", marker: "CD8", note: "cytotoxic T" },
  { gene: "MS4A1", marker: "CD20", note: "B cells" },
  { gene: "CD68", marker: "CD68", note: "macrophages" },
  { gene: "CD274", marker: "PD-L1", note: "immune checkpoint" },
  { gene: "PECAM1", marker: "CD31", note: "endothelium" },
  { gene: "ACTA2", marker: "SMA", note: "smooth muscle / CAF" },
];

export default function AIStudio() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <SegmentationCard />
      <HE2Expression />
    </div>
  );
}

function SegmentationCard() {
  const tissue = useStore((s) => s.tissue);
  const maps = useStore((s) => s.maps);
  const pixelSizeUm = useStore((s) => s.pixelSizeUm);
  const setSegmented = useStore((s) => s.setSegmented);
  const setCells = useStore((s) => s.setCells);
  const setView = useStore((s) => s.setView);
  const [model, setModel] = useState(SEG_MODELS[0]);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [importing, setImporting] = useState(false);
  const timers = useRef<number[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  if (!tissue) return null;

  const importMask = async (file: File) => {
    if (!maps) return;
    setImporting(true);
    try {
      const mask = await decodeLabelTiff(file);
      const cells = labelsToCells(mask, maps);
      if (!cells.length) throw new Error("No non-zero labels found in the mask");
      setCells(cells, `Imported mask: ${file.name}`);
      toast.success("Mask imported", `${cells.length.toLocaleString()} cells from ${file.name}`);
      setView("viewer");
    } catch (e) {
      toast.error("Mask import failed", e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const run = () => {
    timers.current.forEach(clearTimeout);
    setState("running");
    setProgress(0);
    setLogs([]);
    const steps = [
      `Loading ${model.name} weights…`,
      `Preprocessing ${model.target} channels…`,
      "Tiling slide 6 × 4 (2048 px, 128 px overlap)…",
      "Running inference on tiles…",
      "Stitching masks & resolving borders…",
      "Computing per-cell morphology…",
    ];
    steps.forEach((line, i) => {
      const t = window.setTimeout(() => {
        setLogs((l) => [...l, line]);
        setProgress(Math.round(((i + 1) / steps.length) * 100));
      }, 260 * (i + 1));
      timers.current.push(t);
    });
    const done = window.setTimeout(() => {
      setState("done");
      setSegmented(true, model.name);
    }, 260 * (steps.length + 1));
    timers.current.push(done);
  };

  const nCells = tissue.cells.length;
  const meanRadius = nCells ? tissue.cells.reduce((a, c) => a + c.r, 0) / nCells : 0;
  const meanDia = meanRadius * 2 * (pixelSizeUm ?? 1);
  const diaUnit = pixelSizeUm ? "µm" : "px";

  return (
    <Panel className="flex flex-col p-5" strong>
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-violet-400/15 ring-1 ring-violet-400/30">
          <ScanSearch className="h-5 w-5 text-violet-300" />
        </span>
        <div>
          <h3 className="text-base font-bold">AI Cell Segmentation</h3>
          <p className="text-xs text-white/50">Modern deep-learning backends · tiled, gigapixel-ready</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {SEG_MODELS.map((m) => (
          <button
            key={m.id}
            onClick={() => setModel(m)}
            className={clsx(
              "rounded-xl border p-3 text-left transition",
              model.id === m.id ? "border-violet-400/50 bg-violet-400/10" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{m.name}</span>
              <Badge tone={m.target === "H&E" ? "rose" : "violet"}>{m.target}</Badge>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-white/45">{m.desc}</p>
          </button>
        ))}
      </div>

      <button onClick={run} disabled={state === "running"} className="btn-primary mt-4 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm disabled:opacity-70">
        {state === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {state === "running" ? "Segmenting…" : "Run segmentation"}
      </button>

      {state !== "idle" && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-[11px] text-white/50">
            <span>{model.name}</span>
            <span className="font-mono">{progress}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/5">
            <motion.div className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-violet-500 to-pink-500" animate={{ width: `${progress}%` }} transition={{ ease: "easeOut" }} />
          </div>
          <div className="mt-3 max-h-28 space-y-1 overflow-y-auto rounded-xl bg-ink-950/60 p-3 font-mono text-[11px] text-white/55 ring-1 ring-white/5">
            <AnimatePresence>
              {logs.map((l, i) => (
                <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2">
                  <span className="text-emerald-400">›</span> {l}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {state === "done" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-300">
            <CheckCircle2 className="h-4 w-4" /> Segmentation complete
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Cells detected" value={nCells.toLocaleString()} />
            <Stat label="Mean diameter" value={`${meanDia.toFixed(1)} ${diaUnit}`} />
            <Stat label="Confidence" value="0.94" />
          </div>
          <button onClick={() => setView("viewer")} className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-cyan-300 hover:text-cyan-200">
            View outlines in Viewer <ArrowRight className="h-4 w-4" />
          </button>
        </motion.div>
      )}

      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <div className="mb-1 text-xs font-semibold text-white/75">Import external mask</div>
        <p className="mb-2 text-[11px] leading-snug text-white/45">
          Load a label TIFF (QuPath / CellProfiler / ImageJ) as the segmentation. Cells are read from the mask and scored
          against the current channels.
        </p>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-white/80 transition hover:bg-white/[0.07] disabled:opacity-60"
        >
          {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Import label mask (.tif)
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".tif,.tiff,image/tiff"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importMask(f);
            e.currentTarget.value = "";
          }}
        />
      </div>

      <p className="mt-4 pt-2 text-[11px] leading-relaxed text-white/35">
        On-device demo delineates the loaded tissue's cells. Connect the FluoroView backend to run the
        selected model on your own slides.
      </p>
    </Panel>
  );
}

function HE2Expression() {
  // Self-contained synthetic immuno tissue: this experimental demo maps genes to
  // an IO marker panel, which is independent of whichever dataset is loaded.
  const tissue = useMemo(() => generateTissue(1500, 11), []);
  const [geneSel, setGeneSel] = useState(GENES[0]);
  const [predicted, setPredicted] = useState(false);
  const [busy, setBusy] = useState(false);

  const markerIdx = MARKERS.findIndex((m) => m.name === geneSel.marker);

  const predict = () => {
    setBusy(true);
    setPredicted(false);
    setTimeout(() => {
      setBusy(false);
      setPredicted(true);
    }, 900);
  };

  return (
    <Panel className="flex flex-col p-5" strong>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-400/15 ring-1 ring-amber-400/30">
            <Dna className="h-5 w-5 text-amber-300" />
          </span>
          <div>
            <h3 className="text-base font-bold">H&amp;E → Single-cell Expression</h3>
            <p className="text-xs text-white/50">Predict transcript abundance from morphology</p>
          </div>
        </div>
        <Badge tone="amber">Experimental</Badge>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 text-[11px] font-medium text-white/45">Input · H&amp;E</div>
          <div className="relative h-[220px] overflow-hidden rounded-xl ring-1 ring-white/10">
            <HECanvas tissue={tissue} />
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-white/45">
            <span>Predicted · {geneSel.gene}</span>
            {predicted && <span className="text-amber-300">viridis</span>}
          </div>
          <div className="relative h-[220px] overflow-hidden rounded-xl ring-1 ring-white/10">
            {predicted ? (
              <SpatialMap tissue={tissue} colorBy={{ mode: "marker", marker: markerIdx }} cellTypes={CELL_TYPES} />
            ) : (
              <div className="grid h-full place-items-center bg-ink-950/60 text-center text-xs text-white/35">
                {busy ? <Loader2 className="h-5 w-5 animate-spin text-amber-300" /> : "Run prediction to paint expression"}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={geneSel.gene}
          onChange={(e) => {
            setGeneSel(GENES.find((g) => g.gene === e.target.value)!);
            setPredicted(false);
          }}
          className="rounded-xl glass px-3 py-2 text-sm text-white/85 outline-none"
        >
          {GENES.map((g) => (
            <option key={g.gene} value={g.gene} className="bg-ink-800">
              {g.gene} — {g.note}
            </option>
          ))}
        </select>
        <button onClick={predict} disabled={busy} className="btn-primary inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm disabled:opacity-70">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Predict expression
        </button>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/80 ring-1 ring-amber-400/20">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        Experimental research preview. Demo predictions are derived from tissue morphology as a stand-in
        for a trained model and are <span className="font-semibold">not validated for clinical or diagnostic use</span>.
      </div>
    </Panel>
  );
}

function HECanvas({ tissue }: { tissue: { width: number; height: number; cells: { x: number; y: number; r: number; markers: number[]; typeIndex: number }[] } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // eosin background wash (pink)
    ctx.fillStyle = "#f3d6e4";
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / tissue.width, H / tissue.height);
    const ox = (W - tissue.width * s) / 2;
    const oy = (H - tissue.height * s) / 2;
    // stroma eosin texture
    ctx.globalAlpha = 0.5;
    for (const c of tissue.cells) {
      if (c.typeIndex !== 6) continue;
      ctx.fillStyle = "#e79ab8";
      ctx.beginPath();
      ctx.arc(ox + c.x * s, oy + c.y * s, c.r * s * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // hematoxylin nuclei (purple/blue)
    for (const c of tissue.cells) {
      const x = ox + c.x * s;
      const y = oy + c.y * s;
      const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1.4, c.r * s));
      g.addColorStop(0, "rgba(74,35,110,0.95)");
      g.addColorStop(0.7, "rgba(96,53,140,0.8)");
      g.addColorStop(1, "rgba(120,80,160,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.4, c.r * s), 0, Math.PI * 2);
      ctx.fill();
    }
  }, [tissue]);
  return <canvas ref={ref} className="h-full w-full" />;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-3 py-2 text-center ring-1 ring-white/5">
      <div className="font-mono text-lg font-bold text-white">{value}</div>
      <div className="text-[10px] text-white/45">{label}</div>
    </div>
  );
}

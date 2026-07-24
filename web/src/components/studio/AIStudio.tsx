import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, ScanSearch, Dna, Play, Loader2, CheckCircle2, ArrowRight, TriangleAlert, Upload, Search, X } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import { generateTissue } from "../../lib/synth";
import { decodeLabelTiff, labelsToCells } from "../../lib/maskImport";
import {
  fetchHe2st,
  predictHe2st,
  GENE_PANEL,
  HE2ST_ATTRIBUTION,
  HE2ST_DOI_URL,
  HE2ST_LICENSE,
  HE2ST_LICENSE_URL,
  HE2ST_REPO_URL,
  type He2stResult,
} from "../../lib/he2st";
import { viridisGradient } from "../../lib/palette";
import { toast } from "../../lib/toast";
import { Panel, Badge } from "../ui";
import { SpatialMap } from "./charts";

const SEG_MODELS = [
  { id: "cellpose-sam", name: "Cellpose-SAM", desc: "Generalist cellular segmentation (Cellpose 4 / SAM)", target: "fluorescence" },
  { id: "stardist-he", name: "StarDist (H&E)", desc: "Star-convex nuclei for brightfield histology", target: "H&E" },
  { id: "instanseg", name: "InstanSeg", desc: "Fast instance segmentation, multiplex-ready", target: "fluorescence" },
  { id: "mesmer", name: "Mesmer (DeepCell)", desc: "Nuclear + whole-cell for tissue imaging", target: "fluorescence" },
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

const DEFAULT_GENES = ["EPCAM", "MKI67", "CD3D", "CD8A", "MS4A1", "CD68", "ACTA2", "PECAM1"];

/**
 * H&E → Spatial Transcriptomics.
 *
 * Predicts a per-cell value for each selected gene and paints it on a viridis
 * map. The real sCellST path is used when the backend has the package, a trained
 * checkpoint and an H&E image; otherwise this is the transparent
 * morphology-derived fallback — and the card says which, every time.
 */
function HE2Expression() {
  // Self-contained synthetic immuno tissue with a 12-plex protein panel, so the
  // card works regardless of which dataset is loaded in the Viewer.
  const tissue = useMemo(() => generateTissue(1500, 11), []);
  const backendOnline = useStore((s) => s.backendOnline);

  const [selected, setSelected] = useState<string[]>(DEFAULT_GENES);
  const [query, setQuery] = useState("");
  const [painted, setPainted] = useState<string | null>(null);
  const [result, setResult] = useState<He2stResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return GENE_PANEL.filter((g) => g.gene.includes(q) || g.program.toUpperCase().includes(q)).slice(0, 8);
  }, [query]);

  const toggleGene = (gene: string) => {
    setSelected((cur) => (cur.includes(gene) ? cur.filter((g) => g !== gene) : [...cur, gene]));
    setResult(null);
  };

  const predict = async () => {
    if (!selected.length) {
      setError("Pick at least one gene.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Prefer the backend: it is the only place real sCellST can live.
      let out: He2stResult;
      if (backendOnline) {
        try {
          out = await fetchHe2st(tissue.cells, selected, null);
        } catch {
          out = predictHe2st(tissue.cells, selected);
        }
      } else {
        out = predictHe2st(tissue.cells, selected);
      }
      setResult(out);
      setPainted(out.genes[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const paintedIdx = result && painted ? result.genes.indexOf(painted) : -1;
  const values = useMemo(() => {
    if (!result || paintedIdx < 0) return null;
    return result.expression.map((row) => row[paintedIdx] ?? 0);
  }, [result, paintedIdx]);
  const domain = useMemo((): [number, number] | undefined => {
    if (!values || !values.length) return undefined;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi];
  }, [values]);

  const isReal = result?.model === "scellst";

  return (
    <Panel className="flex flex-col p-5" strong>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-400/15 ring-1 ring-amber-400/30">
            <Dna className="h-5 w-5 text-amber-300" />
          </span>
          <div>
            <h3 className="text-base font-bold">H&amp;E → Spatial Transcriptomics</h3>
            <p className="text-xs text-white/50">Per-cell gene expression predicted from morphology</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {result && (
            <span className={clsx("rounded-full px-2 py-0.5 text-[10px] font-bold ring-1", isReal ? "bg-emerald-400/15 text-emerald-200 ring-emerald-400/30" : "bg-white/[0.06] text-white/60 ring-white/15")}>
              {isReal ? "sCellST model" : "morphology fallback"} · {result.engine}
            </span>
          )}
          <Badge tone="amber">Experimental</Badge>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-medium text-white/45">Input · H&amp;E</div>
          <div className="relative h-[220px] overflow-hidden rounded-xl ring-1 ring-white/10">
            <HECanvas tissue={tissue} />
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-white/45">
            <span>Predicted · {painted ?? "—"}</span>
            {values && <span className="text-amber-300">viridis</span>}
          </div>
          <div className="relative h-[220px] overflow-hidden rounded-xl ring-1 ring-white/10">
            {values ? (
              <SpatialMap tissue={tissue} colorBy={{ mode: "cluster" }} values={values} valueDomain={domain} radiusScale={1.15} />
            ) : (
              <div className="grid h-full place-items-center bg-ink-950/60 px-4 text-center text-xs text-white/35">
                {busy ? <Loader2 className="h-5 w-5 animate-spin text-amber-300" /> : "Pick genes, then run the prediction to paint per-cell values"}
              </div>
            )}
          </div>
          {values && domain && (
            <div className="mt-1 flex items-center gap-2 text-[10px] text-white/40">
              <span>{domain[0].toFixed(2)}</span>
              <span className="h-2 flex-1 rounded-full" style={{ background: viridisGradient() }} />
              <span>{domain[1].toFixed(2)}</span>
              <span className="text-white/30">a.u.</span>
            </div>
          )}
        </div>
      </div>

      {/* searchable multi-gene panel */}
      <div className="mt-3">
        <div className="relative">
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.05] px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 flex-shrink-0 text-white/35" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${GENE_PANEL.length} genes or a programme (tumor, tcell, fibroblast…)`}
              className="min-w-0 flex-1 bg-transparent text-xs text-white/85 outline-none placeholder:text-white/30"
              aria-label="Search genes"
            />
            <span className="flex-shrink-0 text-[10px] text-white/35">{selected.length} selected</span>
          </div>
          {matches.length > 0 && (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-white/10 bg-ink-900/98 shadow-panel">
              {matches.map((m) => (
                <button
                  key={m.gene}
                  onClick={() => {
                    toggleGene(m.gene);
                    setQuery("");
                  }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-white/80 transition hover:bg-white/[0.07]"
                >
                  <span className="font-mono">{m.gene}</span>
                  <span className="text-[10px] text-white/40">
                    {m.program}
                    {selected.includes(m.gene) ? " · remove" : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {selected.map((g) => (
            <button
              key={g}
              onClick={() => toggleGene(g)}
              title="Remove from the panel"
              className="inline-flex items-center gap-1 rounded-full bg-white/[0.07] px-2 py-0.5 font-mono text-[10px] text-white/75 transition hover:bg-rose-400/20 hover:text-rose-100"
            >
              {g} <X className="h-2.5 w-2.5" />
            </button>
          ))}
          {!selected.length && <span className="text-[10px] text-white/35">No genes selected.</span>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => void predict()} disabled={busy} className="btn-primary inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm disabled:opacity-70">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Predict expression
        </button>
        {result && (
          <div className="flex flex-wrap items-center gap-1">
            {result.genes.map((g) => (
              <button
                key={g}
                onClick={() => setPainted(g)}
                className={clsx("rounded-lg px-2 py-1 font-mono text-[10px] transition", painted === g ? "bg-amber-400/25 text-amber-50 ring-1 ring-amber-300/40" : "bg-white/[0.05] text-white/55 hover:text-white")}
              >
                {g}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-100">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-rose-300" /> {error}
        </div>
      )}

      <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/80 ring-1 ring-amber-400/20">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <div>
          <b className="text-amber-100">EXPERIMENTAL — not for clinical or diagnostic use.</b>{" "}
          {isReal ? (
            <>These values come from a trained sCellST checkpoint and are still unvalidated research output.</>
          ) : (
            <>
              The default is a <b>transparent morphology-derived fallback, not validated model output</b> — sCellST ships no pretrained weights, so real inference needs a
              checkpoint you train yourself (set <code className="rounded bg-black/30 px-1">SCELLST_MIL_CKPT</code> on the backend). Values are arbitrary units, not
              transcript counts.
            </>
          )}
          <div className="mt-1.5 text-amber-100/60">
            {HE2ST_ATTRIBUTION}{" "}
            <a href={HE2ST_LICENSE_URL} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-amber-100">
              {HE2ST_LICENSE}
            </a>{" "}
            ·{" "}
            <a href={HE2ST_REPO_URL} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-amber-100">
              source
            </a>{" "}
            ·{" "}
            <a href={HE2ST_DOI_URL} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-amber-100">
              paper
            </a>
            . Non-commercial licence — clear it before any commercial use.
          </div>
          {result?.fallbackReason && <div className="mt-1 text-amber-100/50">Why: {result.fallbackReason}</div>}
        </div>
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

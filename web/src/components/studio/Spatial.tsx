import { useMemo, useState } from "react";
import { AlertTriangle, Download, FlaskConical, Layers, Loader2, Network, Play, Shuffle, Sparkles } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";
import { clusterColor } from "../../lib/palette";
import { CLIENT_CELL_LIMIT } from "../../lib/spatial/cosmos";
import { chooseEngine, runContrast, runEnrichment, runNiches, type Engine } from "../../lib/spatial/run";
import { deriveCompartments, compartmentsFromClusters, withCompartments, type CompartmentAssignment } from "../../lib/spatial/compartments";
import type { EnrichmentResult, MarkMode, NicheResult, NullMode, PairEnrichment } from "../../lib/spatial/types";
import { Panel, EmptyState, SectionLabel } from "../ui";
import { SpatialMap } from "./charts";

type CompartmentSource = "markers" | "clusters" | "single";

const DEFAULT_RADII = [10, 20, 30, 40, 60];

/** Diverging blue↔red for signed z-scores (0 = neutral slate). */
function zColor(z: number, cap = 8): string {
  const t = Math.max(-1, Math.min(1, z / cap));
  if (t >= 0) {
    const a = 0.12 + 0.78 * t;
    return `rgba(244,63,94,${a.toFixed(3)})`;
  }
  const a = 0.12 + 0.78 * -t;
  return `rgba(56,189,248,${a.toFixed(3)})`;
}

function fmtP(p: number): string {
  if (p >= 0.001) return p.toFixed(3);
  return p.toExponential(1);
}

export default function Spatial() {
  const tissue = useStore((s) => s.tissue);
  const activeChannels = useStore((s) => s.activeChannels);
  const cellTypes = useStore((s) => s.cellTypes);
  const pixelSizeUm = useStore((s) => s.pixelSizeUm);
  const analysis = useStore((s) => s.analysis);
  const clusterAnnotations = useStore((s) => s.clusterAnnotations);
  const backendOnline = useStore((s) => s.backendOnline);

  const [radiiText, setRadiiText] = useState(DEFAULT_RADII.join(", "));
  const [mode, setMode] = useState<NullMode>("annulus");
  const [marks, setMarks] = useState<MarkMode>("hard");
  const [permutations, setPermutations] = useState(199);
  const [numNiches, setNumNiches] = useState(6);
  const [compSource, setCompSource] = useState<CompartmentSource>("markers");
  const [prefer, setPrefer] = useState<Engine | "auto">("auto");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ ratio: number; detail: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrichmentResult | null>(null);
  const [globalResult, setGlobalResult] = useState<EnrichmentResult | null>(null);
  const [niches, setNiches] = useState<NicheResult | null>(null);
  const [selected, setSelected] = useState<{ a: number; b: number } | null>(null);
  const [minEffect, setMinEffect] = useState(0);
  const [sortKey, setSortKey] = useState<"z" | "q" | "effect" | "r">("z");
  const [showGlobal, setShowGlobal] = useState(false);

  const cells = tissue?.cells ?? [];
  const nCells = cells.length;

  // µm/px is only known when the file said so (or the user calibrated). Falling
  // back to 1 keeps the maths honest: radii are then in PIXELS, and the UI says so.
  const umPerUnit = pixelSizeUm ?? 1;
  const unitLabel = pixelSizeUm ? "µm" : "px";

  const typeNames = useMemo(() => {
    if (cellTypes?.length) return cellTypes.map((t) => t.short || t.name);
    const k = analysis?.k ?? 0;
    if (k > 0) return Array.from({ length: k }, (_, i) => clusterAnnotations[i] || `C${i}`);
    return [];
  }, [cellTypes, analysis, clusterAnnotations]);

  // Types come from the cell-type taxonomy (synthetic) or from clustering
  // (real/uploaded data), which is why clustering is a prerequisite there.
  const numTypes = typeNames.length;
  const typedCells = useMemo(() => {
    if (!cells.length) return [];
    if (cellTypes?.length) return cells;
    if (analysis) return cells.map((c) => ({ ...c, typeIndex: Math.max(0, Math.min(numTypes - 1, c.cluster ?? 0)) }));
    return [];
  }, [cells, cellTypes, analysis, numTypes]);

  const compartments: CompartmentAssignment = useMemo(() => {
    if (!typedCells.length) return { index: [], names: [], rationale: [], sizes: [] };
    if (compSource === "single") {
      return { index: new Array(typedCells.length).fill(0), names: ["whole region"], rationale: ["Single compartment — the null is global, not architecture-aware."], sizes: [typedCells.length] };
    }
    if (compSource === "clusters" && analysis) return compartmentsFromClusters(typedCells, analysis.k);
    return deriveCompartments(typedCells, activeChannels);
  }, [typedCells, compSource, analysis, activeChannels]);

  const preparedCells = useMemo(() => withCompartments(typedCells, compartments.index), [typedCells, compartments]);

  const radii = useMemo(
    () =>
      radiiText
        .split(/[,\s]+/)
        .map((s) => Number(s.trim()))
        .filter((v) => Number.isFinite(v) && v > 0),
    [radiiText]
  );

  const engine = chooseEngine(nCells, prefer, !!backendOnline);
  const tooBigForClient = engine === "client" && nCells > CLIENT_CELL_LIMIT;

  const opts = {
    numTypes,
    radiiUm: radii,
    umPerUnit,
    mode,
    compartmentAware: compSource !== "single",
    marks,
    numPermutations: permutations,
    alpha: 0.05,
    seed: 1,
    typeNames,
  };

  const guard = (): string | null => {
    if (!numTypes) return "Cell types are needed first — run clustering in the Analysis tab (or load the synthetic demo, which ships a cell-type taxonomy).";
    if (radii.length < 1) return "Enter at least one scale radius.";
    for (let i = 1; i < radii.length; i++) if (radii[i] <= radii[i - 1]) return "Scale radii must be strictly increasing.";
    if (tooBigForClient) return `${nCells.toLocaleString()} cells is above the ${CLIENT_CELL_LIMIT.toLocaleString()}-cell client limit. Start the optional backend, or draw a smaller ROI.`;
    return null;
  };

  const run = async (what: "enrichment" | "contrast" | "niches" | "all") => {
    const problem = guard();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(what);
    setProgress({ ratio: 0.02, detail: "starting" });
    const onProgress = (ratio: number, detail: string) => setProgress({ ratio, detail });
    try {
      if (what === "contrast") {
        const out = await runContrast(preparedCells, opts, engine, onProgress);
        setResult(out.compartmentAware);
        setGlobalResult(out.global);
        setShowGlobal(true);
        toast.success("Both nulls computed", "Compare the compartment-aware and global columns.");
      } else {
        if (what === "enrichment" || what === "all") {
          const out = await runEnrichment(preparedCells, opts, engine, onProgress);
          setResult(out);
          setGlobalResult(null);
          setShowGlobal(false);
          if (!out.pairs.some((p) => p.significant)) toast.info("No pair survived FDR", "That is a real (negative) result at this α and B.");
        }
        if (what === "niches" || what === "all") {
          const out = await runNiches(
            preparedCells,
            // 19 null draws make α = 0.05 reachable at all (min p = 1/(19+1));
            // fewer would guarantee a non-significant answer regardless of data.
            { numTypes, radiiUm: radii, umPerUnit, numNiches, compartmentAware: compSource !== "single", marks, nBoot: 5, nNull: 19, seed: 3 },
            engine,
            onProgress
          );
          setNiches(out);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(engine === "server" ? `${msg} — is the optional backend running on :8010?` : msg);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const shown = showGlobal && globalResult ? globalResult : result;
  const visiblePairs = useMemo(() => {
    if (!shown) return [];
    const filtered = shown.pairs.filter((p) => Math.abs(p.log2eAtPeak) >= minEffect);
    const sorted = [...filtered];
    if (sortKey === "z") sorted.sort((a, b) => Math.abs(b.zAtPeak) - Math.abs(a.zAtPeak));
    if (sortKey === "q") sorted.sort((a, b) => a.qMax - b.qMax);
    if (sortKey === "effect") sorted.sort((a, b) => Math.abs(b.log2eAtPeak) - Math.abs(a.log2eAtPeak));
    if (sortKey === "r") sorted.sort((a, b) => a.peakR - b.peakR);
    return sorted;
  }, [shown, minEffect, sortKey]);

  const selectedPair = useMemo(() => {
    if (!shown) return null;
    if (selected) return shown.pairs.find((p) => p.a === selected.a && p.b === selected.b) ?? null;
    return visiblePairs[0] ?? null;
  }, [shown, selected, visiblePairs]);

  const exportCsv = () => {
    if (!shown) return;
    const head = ["typeA", "typeB", `peakR_${unitLabel}`, "z_at_peak", "log2_effect", "max_abs_z", "p_max", "q_max", "direction", "significant"];
    const rows = visiblePairs.map((p) =>
      [p.aName, p.bName, p.peakR, p.zAtPeak.toFixed(4), p.log2eAtPeak.toFixed(4), p.maxAbsZ.toFixed(4), p.pMax, p.qMax.toFixed(6), p.direction, p.significant].join(",")
    );
    const meta = [
      `# FluoroView CoSMoS / CAMSE — research use only, not for diagnostic use`,
      `# null=${shown.stratified ? "compartment-stratified" : "global"} mode=${shown.mode} B=${shown.numPermutations} alpha=${shown.alpha} engine=${shown.engine}`,
      `# scales_${unitLabel}=${shown.radiiUm.join("|")} marks=${marks} cells=${nCells}`,
    ];
    const blob = new Blob([[...meta, head.join(","), ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cosmos-enrichment.csv";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV exported", `${rows.length} pairs with their null and FDR settings`);
  };

  if (!tissue) return null;

  return (
    <div className="space-y-4">
      <ResearchBanner />

      {!numTypes ? (
        <Panel className="p-8" strong>
          <EmptyState
            icon={<Network className="h-6 w-6" />}
            title="CoSMoS needs cell types"
            hint="Spatial statistics compare labelled cell populations. Open the Analysis tab and run clustering — the clusters become the cell types here — or switch to the synthetic demo, which ships a full cell-type taxonomy."
          />
        </Panel>
      ) : (
        <>
          <Controls
            radiiText={radiiText}
            setRadiiText={setRadiiText}
            unitLabel={unitLabel}
            mode={mode}
            setMode={setMode}
            marks={marks}
            setMarks={setMarks}
            permutations={permutations}
            setPermutations={setPermutations}
            numNiches={numNiches}
            setNumNiches={setNumNiches}
            compSource={compSource}
            setCompSource={setCompSource}
            hasClusters={!!analysis}
            compartments={compartments}
            prefer={prefer}
            setPrefer={setPrefer}
            engine={engine}
            backendOnline={!!backendOnline}
            nCells={nCells}
            numTypes={numTypes}
            busy={busy}
            progress={progress}
            onRun={run}
          />

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-300" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {!pixelSizeUm && (
            <p className="rounded-xl bg-amber-400/[0.07] px-4 py-2.5 text-[11px] leading-relaxed text-amber-100/85">
              This dataset has no physical pixel size, so the scale radii below are in <b>image pixels</b>, not microns. Calibrate in the Viewer to get true µm distances.
            </p>
          )}

          {shown ? (
            <>
              {globalResult && <NullToggle showGlobal={showGlobal} setShowGlobal={setShowGlobal} aware={result} global={globalResult} alpha={shown.alpha} />}
              <RunSummary res={shown} nCells={nCells} compartments={compartments} unitLabel={unitLabel} />
              <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
                <Heatmap res={shown} pairs={visiblePairs} selected={selectedPair} onSelect={(a, b) => setSelected({ a, b })} unitLabel={unitLabel} />
                <ScaleProfile pair={selectedPair} res={shown} unitLabel={unitLabel} />
              </div>
              <SignificanceTable
                pairs={visiblePairs}
                total={shown.pairs.length}
                alpha={shown.alpha}
                minEffect={minEffect}
                setMinEffect={setMinEffect}
                sortKey={sortKey}
                setSortKey={setSortKey}
                onSelect={(a, b) => setSelected({ a, b })}
                selected={selectedPair}
                unitLabel={unitLabel}
                onExport={exportCsv}
              />
            </>
          ) : (
            <Panel className="p-8" strong>
              <EmptyState
                icon={<Sparkles className="h-6 w-6" />}
                title="No spatial statistics yet"
                hint='Press "Run enrichment" to test every cell-type pair at each scale against a compartment-stratified label-permutation null, or "Compare nulls" to see which associations are explained by tissue architecture alone.'
              />
            </Panel>
          )}

          {niches && <NichePanel niches={niches} tissue={tissue} compartments={compartments} typeNames={typeNames} />}
        </>
      )}
    </div>
  );
}

function ResearchBanner() {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-violet-300/25 bg-violet-400/[0.07] px-4 py-3">
      <FlaskConical className="mt-0.5 h-4 w-4 flex-shrink-0 text-violet-300" />
      <div className="min-w-0 text-[11px] leading-relaxed text-violet-50/85">
        <b className="text-violet-100">CoSMoS — research use only.</b> Compartment-conditioned multi-scale spatial statistics. Results are exploratory and{" "}
        <b>not validated for clinical or diagnostic use</b>. p-values are Monte-Carlo estimates bounded below by 1/(B+1); significance is reported as
        Benjamini–Hochberg FDR (q) across cell-type pairs, after an exact within-pair multiscale max-|z| correction.
      </div>
    </div>
  );
}

interface ControlProps {
  radiiText: string;
  setRadiiText: (v: string) => void;
  unitLabel: string;
  mode: NullMode;
  setMode: (v: NullMode) => void;
  marks: MarkMode;
  setMarks: (v: MarkMode) => void;
  permutations: number;
  setPermutations: (v: number) => void;
  numNiches: number;
  setNumNiches: (v: number) => void;
  compSource: CompartmentSource;
  setCompSource: (v: CompartmentSource) => void;
  hasClusters: boolean;
  compartments: CompartmentAssignment;
  prefer: Engine | "auto";
  setPrefer: (v: Engine | "auto") => void;
  engine: Engine;
  backendOnline: boolean;
  nCells: number;
  numTypes: number;
  busy: string | null;
  progress: { ratio: number; detail: string } | null;
  onRun: (what: "enrichment" | "contrast" | "niches" | "all") => void;
}

function Controls(p: ControlProps) {
  const stratified = p.compartments.names.length > 1;
  return (
    <Panel className="p-5" strong>
      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr_1fr]">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-white/50">Scale radii ({p.unitLabel})</span>
          <input
            value={p.radiiText}
            onChange={(e) => p.setRadiiText(e.target.value)}
            className="w-full rounded-lg bg-white/[0.05] px-2.5 py-1.5 font-mono text-xs text-white/85 outline-none focus:bg-white/[0.09]"
            aria-label="Scale radii"
          />
          <span className="mt-1 block text-[10px] text-white/35">Increasing. Annulus rings decorrelate the scales.</span>
        </label>

        <div>
          <span className="mb-1 block text-[11px] font-semibold text-white/50">Neighbourhood</span>
          <Segmented
            value={p.mode}
            onChange={(v) => p.setMode(v as NullMode)}
            options={[
              { value: "annulus", label: "annulus" },
              { value: "disk", label: "disk (cumulative)" },
            ]}
          />
        </div>

        <div>
          <span className="mb-1 block text-[11px] font-semibold text-white/50">Marks</span>
          <Segmented
            value={p.marks}
            onChange={(v) => p.setMarks(v as MarkMode)}
            options={[
              { value: "hard", label: "hard labels" },
              { value: "confWeighted", label: "confidence-weighted" },
            ]}
          />
        </div>

        <div>
          <span className="mb-1 block text-[11px] font-semibold text-white/50">
            Compartments — the null is stratified within these
          </span>
          <Segmented
            value={p.compSource}
            onChange={(v) => p.setCompSource(v as CompartmentSource)}
            options={[
              { value: "markers", label: "marker gating" },
              { value: "clusters", label: "clusters", disabled: !p.hasClusters },
              { value: "single", label: "single (global null)" },
            ]}
          />
          <div className="mt-1.5 space-y-0.5">
            {p.compartments.names.map((n, i) => (
              <div key={n} className="flex items-center gap-1.5 text-[10px] text-white/45">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: clusterColor(i) }} />
                {n} · {(p.compartments.sizes[i] ?? 0).toLocaleString()} cells
              </div>
            ))}
            {!stratified && <div className="text-[10px] text-amber-200/70">Not architecture-aware: only one compartment.</div>}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-white/50">Permutations (B) — {p.permutations}</span>
          <input
            type="range"
            min={49}
            max={999}
            step={50}
            value={p.permutations}
            onChange={(e) => p.setPermutations(Number(e.target.value))}
            className="fv-slider w-full"
            aria-label="Permutations"
          />
          <span className="mt-1 block text-[10px] text-white/35">
            Smallest possible p is 1/(B+1) = {(1 / (p.permutations + 1)).toExponential(1)}. 999 for reporting.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-white/50">Niches (G) — {p.numNiches}</span>
          <input
            type="range"
            min={2}
            max={12}
            step={1}
            value={p.numNiches}
            onChange={(e) => p.setNumNiches(Number(e.target.value))}
            className="fv-slider w-full"
            aria-label="Number of niches"
          />
          <span className="mt-1 block text-[10px] text-white/35">
            Compute: <b className="text-white/60">{p.engine}</b>
            {p.engine === "client" ? " (Web Worker, no backend)" : " (FastAPI)"} · {p.nCells.toLocaleString()} cells · {p.numTypes} types
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => p.onRun("enrichment")}
          disabled={!!p.busy}
          className="btn-primary inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm disabled:opacity-60"
        >
          {p.busy === "enrichment" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run enrichment
        </button>
        <button
          onClick={() => p.onRun("contrast")}
          disabled={!!p.busy}
          className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-white/80 transition hover:bg-white/[0.09] disabled:opacity-60"
          title="Run the same statistic against the compartment-stratified and the global null, side by side"
        >
          {p.busy === "contrast" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
          Compare nulls
        </button>
        <button
          onClick={() => p.onRun("niches")}
          disabled={!!p.busy}
          className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-white/80 transition hover:bg-white/[0.09] disabled:opacity-60"
        >
          {p.busy === "niches" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
          Discover niches
        </button>
        <Segmented
          value={p.prefer}
          onChange={(v) => p.setPrefer(v as Engine | "auto")}
          options={[
            { value: "auto", label: "auto" },
            { value: "client", label: "client" },
            { value: "server", label: "backend", disabled: !p.backendOnline },
          ]}
        />
      </div>

      {p.progress && (
        <div className="mt-3">
          <div className="flex items-center gap-2 text-[11px] text-white/60">
            <Loader2 className="h-3 w-3 animate-spin text-cyan-300" />
            <span className="truncate">{p.progress.detail}</span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-[width] duration-200" style={{ width: `${Math.round(Math.max(0.03, Math.min(1, p.progress.ratio)) * 100)}%` }} />
          </div>
        </div>
      )}
    </Panel>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-xl glass p-1">
      {options.map((o) => (
        <button
          key={o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          title={o.disabled ? "Not available for this dataset" : undefined}
          className={clsx(
            "rounded-lg px-2.5 py-1 text-[11px] font-semibold transition",
            value === o.value ? "bg-white/12 text-white ring-1 ring-white/20" : "text-white/55 hover:text-white",
            o.disabled && "cursor-not-allowed opacity-35 hover:text-white/55"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RunSummary({ res, nCells, compartments, unitLabel }: { res: EnrichmentResult; nCells: number; compartments: CompartmentAssignment; unitLabel: string }) {
  const sig = res.pairs.filter((p) => p.significant).length;
  return (
    <Panel className="px-4 py-3" strong>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-white/55">
        <span>
          <b className="text-white/80">{sig}</b> of {res.pairs.length} pairs at FDR q ≤ {res.alpha}
        </span>
        <span>
          null:{" "}
          <b className={res.stratified ? "text-emerald-300" : "text-amber-300"}>
            {res.stratified ? `compartment-stratified (${compartments.names.length} compartments)` : "global — not architecture-aware"}
          </b>
        </span>
        <span>
          B = <b className="text-white/80">{res.numPermutations}</b> (min p {(1 / (res.numPermutations + 1)).toExponential(1)})
        </span>
        <span>
          scales: <b className="text-white/80">{res.radiiUm.join(", ")}</b> {unitLabel}
        </span>
        <span>
          {nCells.toLocaleString()} cells · {res.mode} · {res.engine}
          {res.elapsedMs != null ? ` · ${(res.elapsedMs / 1000).toFixed(1)}s` : ""}
        </span>
      </div>
      {compartments.rationale.length > 0 && (
        <div className="mt-1.5 text-[10px] leading-relaxed text-white/35">{compartments.rationale.join(" · ")}</div>
      )}
    </Panel>
  );
}

function NullToggle({
  showGlobal,
  setShowGlobal,
  aware,
  global,
  alpha,
}: {
  showGlobal: boolean;
  setShowGlobal: (v: boolean) => void;
  aware: EnrichmentResult | null;
  global: EnrichmentResult;
  alpha: number;
}) {
  const sigAware = aware?.pairs.filter((p) => p.significant).length ?? 0;
  const sigGlobal = global.pairs.filter((p) => p.significant).length;
  const onlyGlobal = aware
    ? global.pairs.filter((g) => g.significant && !aware.pairs.find((a) => a.a === g.a && a.b === g.b)?.significant)
    : [];
  return (
    <Panel className="p-4" strong>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Null model contrast</SectionLabel>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-white/55">
            The stratified null shuffles labels <b>within each compartment</b>, so it only credits associations that survive the tissue's own architecture. The global
            null shuffles everywhere and therefore also rewards pairs that merely share a compartment.
          </p>
        </div>
        <Segmented
          value={showGlobal ? "global" : "aware"}
          onChange={(v) => setShowGlobal(v === "global")}
          options={[
            { value: "aware", label: `compartment-aware (${sigAware} sig.)` },
            { value: "global", label: `global (${sigGlobal} sig.)` },
          ]}
        />
      </div>
      {onlyGlobal.length > 0 && (
        <p className="mt-2.5 rounded-lg bg-amber-400/[0.08] px-3 py-2 text-[11px] leading-relaxed text-amber-100/85">
          <b>{onlyGlobal.length}</b> pair{onlyGlobal.length > 1 ? "s" : ""} significant only under the global null — most likely explained by tissue compartments
          rather than by a local interaction: {onlyGlobal.slice(0, 4).map((p) => `${p.aName}×${p.bName}`).join(", ")}
          {onlyGlobal.length > 4 ? ", …" : ""}
        </p>
      )}
      {onlyGlobal.length === 0 && aware && (
        <p className="mt-2.5 text-[11px] text-white/45">
          No pair changed its verdict between the two nulls at q ≤ {alpha} — compartments do not explain away these associations.
        </p>
      )}
    </Panel>
  );
}

function Heatmap({
  res,
  pairs,
  selected,
  onSelect,
  unitLabel,
}: {
  res: EnrichmentResult;
  pairs: PairEnrichment[];
  selected: PairEnrichment | null;
  onSelect: (a: number, b: number) => void;
  unitLabel: string;
}) {
  const rows = pairs.slice(0, 26);
  const cap = Math.max(3, ...rows.flatMap((p) => p.perScale.map((s) => Math.abs(s.z))));
  return (
    <Panel className="p-5" strong>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Multiscale enrichment (z)</SectionLabel>
        <div className="flex items-center gap-2 text-[10px] text-white/40">
          <span>depletion</span>
          <span className="h-2.5 w-24 rounded-full" style={{ background: `linear-gradient(90deg, ${zColor(-cap, cap)}, rgba(148,163,184,0.15), ${zColor(cap, cap)})` }} />
          <span>enrichment</span>
          <span className="ml-1">★ = FDR q ≤ {res.alpha}</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[420px]">
          <div className="grid gap-px" style={{ gridTemplateColumns: `minmax(120px, 1.4fr) repeat(${res.radiiUm.length}, minmax(0, 1fr))` }}>
            <div />
            {res.radiiUm.map((r) => (
              <div key={r} className="pb-1 text-center text-[10px] font-semibold text-white/45">
                {r}
                <span className="text-white/25">{unitLabel}</span>
              </div>
            ))}
            {rows.map((p) => {
              const isSel = selected?.a === p.a && selected?.b === p.b;
              return (
                <div key={`${p.a}-${p.b}`} className="col-span-full grid gap-px" style={{ gridTemplateColumns: `minmax(120px, 1.4fr) repeat(${res.radiiUm.length}, minmax(0, 1fr))` }}>
                  <button
                    onClick={() => onSelect(p.a, p.b)}
                    className={clsx("truncate rounded-l-md px-1.5 py-1 text-left text-[11px] transition", isSel ? "bg-white/12 text-white" : "text-white/60 hover:bg-white/[0.06] hover:text-white")}
                    title={`${p.aName} × ${p.bName}`}
                  >
                    {p.aName} <span className="text-white/30">×</span> {p.bName}
                  </button>
                  {p.perScale.map((s) => (
                    <button
                      key={s.r}
                      onClick={() => onSelect(p.a, p.b)}
                      title={`${p.aName} × ${p.bName} @ ${s.r}${unitLabel}\nz = ${s.z.toFixed(2)}\nlog2 effect = ${s.log2e.toFixed(2)}\nper-scale q = ${fmtP(s.q)}\npair q (max-|z|) = ${fmtP(p.qMax)}\nNAR ${p.aName}→${p.bName} = ${s.narAtoB.toFixed(3)}\nNAR ${p.bName}→${p.aName} = ${s.narBtoA.toFixed(3)}`}
                      className={clsx("relative grid h-6 place-items-center text-[9px] font-bold transition hover:z-10 hover:ring-1 hover:ring-white/40", isSel && "ring-1 ring-white/25")}
                      style={{ background: zColor(s.z, cap) }}
                    >
                      {p.significant && Math.abs(s.z) === Math.max(...p.perScale.map((x) => Math.abs(x.z))) ? <span className="text-white">★</span> : null}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {pairs.length > rows.length && <p className="mt-2 text-[10px] text-white/35">Showing the {rows.length} strongest of {pairs.length} pairs — raise the effect filter to narrow it.</p>}
      {!pairs.length && <p className="py-6 text-center text-xs text-white/40">No pair passes the current effect-size filter.</p>}
    </Panel>
  );
}

function ScaleProfile({ pair, res, unitLabel }: { pair: PairEnrichment | null; res: EnrichmentResult; unitLabel: string }) {
  if (!pair) {
    return (
      <Panel className="p-5" strong>
        <SectionLabel>Scale profile</SectionLabel>
        <p className="mt-6 text-center text-xs text-white/40">Pick a pair in the heatmap to see how its association varies with distance.</p>
      </Panel>
    );
  }
  const W = 320;
  const H = 150;
  const pad = { l: 30, r: 8, t: 10, b: 22 };
  const zs = pair.perScale.map((s) => s.z);
  const bound = Math.max(3, ...zs.map(Math.abs)) * 1.15;
  const x = (i: number) => pad.l + (i / Math.max(1, pair.perScale.length - 1)) * (W - pad.l - pad.r);
  const y = (z: number) => pad.t + ((bound - z) / (2 * bound)) * (H - pad.t - pad.b);
  const line = pair.perScale.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.z).toFixed(1)}`).join(" ");
  return (
    <Panel className="p-5" strong>
      <div className="mb-1 flex items-center justify-between gap-2">
        <SectionLabel>Scale profile</SectionLabel>
        <span className="text-[10px] text-white/40">
          peak |z| at <b className="text-white/70">{pair.peakR} {unitLabel}</b>
        </span>
      </div>
      <p className="mb-2 truncate text-xs font-semibold text-white/85">
        {pair.aName} <span className="text-white/35">×</span> {pair.bName}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="z-score versus scale radius">
        {/* ±2σ null band: under the null z ~ N(0,1), so ±2 is the 95% envelope */}
        <rect x={pad.l} y={y(2)} width={W - pad.l - pad.r} height={Math.max(1, y(-2) - y(2))} fill="rgba(148,163,184,0.14)" />
        <line x1={pad.l} y1={y(0)} x2={W - pad.r} y2={y(0)} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
        {/* With a large |z| the band is only a few pixels tall, so two labels
            would collide — collapse them into one. */}
        {y(-2) - y(2) >= 14 ? (
          <>
            <text x={4} y={y(2) + 3} fill="rgba(255,255,255,0.35)" fontSize="8">+2σ</text>
            <text x={4} y={y(-2) + 3} fill="rgba(255,255,255,0.35)" fontSize="8">−2σ</text>
          </>
        ) : (
          <text x={4} y={y(0) + 3} fill="rgba(255,255,255,0.35)" fontSize="8">±2σ</text>
        )}
        <path d={line} fill="none" stroke="#22d3ee" strokeWidth="1.8" />
        {pair.perScale.map((s, i) => (
          <g key={s.r}>
            <circle cx={x(i)} cy={y(s.z)} r={s.q <= res.alpha ? 4 : 2.6} fill={s.q <= res.alpha ? "#f43f5e" : "#22d3ee"} stroke="#0b1020" strokeWidth="1" />
            <text x={x(i)} y={H - 8} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="8">
              {s.r}
            </text>
          </g>
        ))}
      </svg>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-white/50">
        <span>max |z| {pair.maxAbsZ.toFixed(2)}</span>
        <span>log2 effect {pair.log2eAtPeak.toFixed(2)}</span>
        <span>p (max-|z|) {fmtP(pair.pMax)}</span>
        <span>
          q (BH) <b className={pair.significant ? "text-emerald-300" : "text-white/60"}>{fmtP(pair.qMax)}</b>
        </span>
        <span className="col-span-2 text-white/35">
          NAR {pair.aName}→{pair.bName} {pair.perScale.find((s) => s.r === pair.peakR)?.narAtoB.toFixed(3)} · reverse{" "}
          {pair.perScale.find((s) => s.r === pair.peakR)?.narBtoA.toFixed(3)}
        </span>
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-white/35">
        Filled red points are FDR-significant at that scale. The grey band is the ±2σ permutation envelope; a curve inside it is indistinguishable from the null.
      </p>
    </Panel>
  );
}

function SignificanceTable({
  pairs,
  total,
  alpha,
  minEffect,
  setMinEffect,
  sortKey,
  setSortKey,
  onSelect,
  selected,
  unitLabel,
  onExport,
}: {
  pairs: PairEnrichment[];
  total: number;
  alpha: number;
  minEffect: number;
  setMinEffect: (v: number) => void;
  sortKey: "z" | "q" | "effect" | "r";
  setSortKey: (v: "z" | "q" | "effect" | "r") => void;
  onSelect: (a: number, b: number) => void;
  selected: PairEnrichment | null;
  unitLabel: string;
  onExport: () => void;
}) {
  return (
    <Panel className="p-5" strong>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SectionLabel>Significance table</SectionLabel>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[10px] text-white/45">
            min |log2 effect| {minEffect.toFixed(2)}
            <input type="range" min={0} max={2} step={0.05} value={minEffect} onChange={(e) => setMinEffect(Number(e.target.value))} className="fv-slider w-28" aria-label="Minimum absolute log2 effect size" />
          </label>
          <Segmented
            value={sortKey}
            onChange={(v) => setSortKey(v as "z" | "q" | "effect" | "r")}
            options={[
              { value: "z", label: "|z|" },
              { value: "q", label: "q" },
              { value: "effect", label: "effect" },
              { value: "r", label: "radius" },
            ]}
          />
          <button onClick={onExport} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-white/75 transition hover:bg-white/[0.08] hover:text-white">
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        </div>
      </div>
      <p className="mb-2 text-[10px] text-white/35">
        Effect size and significance are different questions: a tiny but consistent shift can pass FDR in a large sample. Filter by |log2 effect| to keep only
        associations big enough to matter.
      </p>
      <div className="max-h-[320px] overflow-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-ink-900/95 text-[10px] uppercase tracking-wider text-white/40">
            <tr>
              <th className="py-1.5 pr-2 font-semibold">Pair</th>
              <th className="py-1.5 pr-2 text-right font-semibold">peak {unitLabel}</th>
              <th className="py-1.5 pr-2 text-right font-semibold">z</th>
              <th className="py-1.5 pr-2 text-right font-semibold">log2 E</th>
              <th className="py-1.5 pr-2 text-right font-semibold">p</th>
              <th className="py-1.5 pr-2 text-right font-semibold">q</th>
              <th className="py-1.5 font-semibold">verdict</th>
            </tr>
          </thead>
          <tbody className="font-mono text-white/70">
            {pairs.map((p) => {
              const isSel = selected?.a === p.a && selected?.b === p.b;
              return (
                <tr
                  key={`${p.a}-${p.b}`}
                  onClick={() => onSelect(p.a, p.b)}
                  className={clsx("cursor-pointer border-t border-white/[0.06] transition", isSel ? "bg-white/[0.07]" : "hover:bg-white/[0.04]")}
                >
                  <td className="py-1 pr-2 font-sans">
                    {p.aName} <span className="text-white/30">×</span> {p.bName}
                  </td>
                  <td className="py-1 pr-2 text-right">{p.peakR}</td>
                  <td className={clsx("py-1 pr-2 text-right", p.zAtPeak > 0 ? "text-rose-300" : "text-sky-300")}>{p.zAtPeak.toFixed(2)}</td>
                  <td className="py-1 pr-2 text-right">{p.log2eAtPeak.toFixed(2)}</td>
                  <td className="py-1 pr-2 text-right">{fmtP(p.pMax)}</td>
                  <td className={clsx("py-1 pr-2 text-right", p.qMax <= alpha ? "text-emerald-300" : "")}>{fmtP(p.qMax)}</td>
                  <td className="py-1 font-sans">
                    {p.significant ? (
                      <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-bold", p.direction === "enrichment" ? "bg-rose-400/15 text-rose-200" : "bg-sky-400/15 text-sky-200")}>
                        {p.direction}
                      </span>
                    ) : (
                      <span className="text-[10px] text-white/30">not significant</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-white/35">
        {pairs.length} of {total} pairs shown. p is the within-pair multiscale max-|z| Monte-Carlo p-value; q is its BH-FDR across pairs.
      </p>
    </Panel>
  );
}

function NichePanel({
  niches,
  tissue,
  compartments,
  typeNames,
}: {
  niches: NicheResult;
  tissue: NonNullable<ReturnType<typeof useStore.getState>["tissue"]>;
  compartments: CompartmentAssignment;
  typeNames: string[];
}) {
  const total = niches.sizes.reduce((a, b) => a + b, 0) || 1;
  const minP = niches.nNull ? 1 / (niches.nNull + 1) : 0;
  const underpowered = minP > 0.05;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <Panel className="p-5" strong>
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel>Niche map</SectionLabel>
          <span className="text-[10px] text-white/40">
            stability ARI <b className="text-white/70">{niches.stabilityAri.toFixed(2)}</b> · silhouette {niches.silhouette.toFixed(2)}
          </span>
        </div>
        <div className="h-[300px] overflow-hidden rounded-xl">
          <SpatialMap tissue={tissue} labels={niches.nicheOfCell} colorBy={{ mode: "cluster" }} radiusScale={1.1} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {niches.sizes.map((n, g) => (
            <span key={g} className="inline-flex items-center gap-1.5 text-[10px] text-white/55">
              <span className="h-2 w-2 rounded-full" style={{ background: clusterColor(g) }} />N{g} · {n.toLocaleString()} ({((100 * n) / total).toFixed(1)}%)
            </span>
          ))}
        </div>
        <div className="mt-2 rounded-lg bg-white/[0.03] px-3 py-2 text-[10px] leading-relaxed text-white/50">
          <b className="text-white/70">Is the structure real?</b> vs a global null p = {fmtP(niches.pGlobal)} (is there any spatial composition structure at all) ·
          vs the compartment-stratified null p = {fmtP(niches.pStratified)} (does it exceed what compartments already explain).{" "}
          {underpowered ? (
            <span className="text-amber-200/80">
              These p-values come from only {niches.nNull} null draws, so the smallest value they can take is {fmtP(minP)} — this run cannot reach significance
              either way. Raise the null count (or run on the backend) before reading anything into them.
            </span>
          ) : (
            niches.pStratified > 0.05 && (
              <span className="text-amber-200/80">
                At α = 0.05 these niches are not distinguishable from the compartment structure — treat them as a description of architecture, not a discovery.
              </span>
            )
          )}
        </div>
      </Panel>

      <Panel className="p-5" strong>
        <SectionLabel>Niche signatures</SectionLabel>
        <p className="mt-1 mb-2 text-[10px] text-white/40">Cell-type fractions per niche, and how each niche is distributed over the compartments (observed / expected).</p>
        <div className="max-h-[340px] space-y-2.5 overflow-auto pr-1">
          {niches.signatures.map((sig, g) => {
            const top = sig
              .map((v, i) => ({ v, i }))
              .sort((a, b) => b.v - a.v)
              .filter((s) => s.v > 0.02)
              .slice(0, 4);
            return (
              <div key={g} className="rounded-lg bg-white/[0.03] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="grid h-5 w-5 place-items-center rounded text-[10px] font-bold text-ink-950" style={{ background: clusterColor(g) }}>
                    N{g}
                  </span>
                  <span className="text-[11px] text-white/70">{niches.sizes[g].toLocaleString()} cells</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {top.map((s) => (
                    <span key={s.i} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/70">
                      {typeNames[s.i] ?? `T${s.i}`} {(100 * s.v).toFixed(0)}%
                    </span>
                  ))}
                  {!top.length && <span className="text-[10px] text-white/35">no dominant type</span>}
                </div>
                {compartments.names.length > 1 && niches.compartmentEnrichment[g] && (
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {niches.compartmentEnrichment[g].map((e, m) => (
                      <span key={m} className={clsx("text-[10px]", e > 1.5 ? "text-emerald-300" : e < 0.5 ? "text-white/30" : "text-white/50")}>
                        {compartments.names[m] ?? `c${m}`} {e.toFixed(2)}×
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

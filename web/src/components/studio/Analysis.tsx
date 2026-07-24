import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Play, Network, Grid3x3, MapPin, Loader2 } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../../lib/store";
import { clusterSignature, panelIndices, type MarkerSign } from "../../lib/analysis";
import type { ChannelDef } from "../../lib/types";
import { clusterColor } from "../../lib/palette";
import { Panel, Slider, SectionLabel, EmptyState } from "../ui";
import { EmbeddingScatter, SpatialMap, MarkerHeatmap, ClusterLegend, type ColorBy } from "./charts";

export default function Analysis() {
  const tissue = useStore((s) => s.tissue);
  const analysis = useStore((s) => s.analysis);
  const runClustering = useStore((s) => s.runClustering);
  const activeChannels = useStore((s) => s.activeChannels);
  const cellTypes = useStore((s) => s.cellTypes);
  const clusterAnnotations = useStore((s) => s.clusterAnnotations);
  const renameCluster = useStore((s) => s.renameCluster);
  const [k, setK] = useState(8);
  const [busy, setBusy] = useState(false);
  const [colorBy, setColorBy] = useState<ColorBy>(cellTypes ? { mode: "type" } : { mode: "marker", marker: 1 });

  // Per-cluster +/- marker signature (z-scored vs. whole-image mean).
  const signatures = useMemo(() => {
    const out: Record<number, MarkerSign[]> = {};
    if (!analysis || !tissue) return out;
    const names = activeChannels.map((c) => c.name);
    for (const s of analysis.summaries) out[s.cluster] = clusterSignature(tissue.cells, analysis.labels, s.cluster, names);
    return out;
  }, [analysis, tissue, activeChannels]);

  const clustersPresent = useMemo(() => (analysis ? analysis.summaries.slice().sort((a, b) => a.cluster - b.cluster).map((s) => s.cluster) : []), [analysis]);

  if (!tissue) {
    return (
      <Panel className="p-8" strong>
        <EmptyState icon={<Network className="h-6 w-6" />} title="No dataset loaded" hint="Load a dataset from the Studio header to run analysis." />
      </Panel>
    );
  }

  const run = () => {
    setBusy(true);
    requestAnimationFrame(() =>
      setTimeout(() => {
        runClustering(k);
        setColorBy({ mode: "cluster" });
        setBusy(false);
      }, 30)
    );
  };

  return (
    <div className="space-y-4">
      <Panel className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between" strong>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-white/80">Clusters (k)</span>
            <div className="w-40">
              <Slider value={k} min={4} max={12} step={1} onChange={setK} accent="#8b5cf6" />
            </div>
            <span className="font-mono text-sm text-white/70">{k}</span>
          </div>
          <button onClick={run} disabled={busy} className="btn-primary inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {analysis ? "Re-run clustering" : "Run clustering + embedding"}
          </button>
        </div>

        <ColorControl colorBy={colorBy} setColorBy={setColorBy} hasClusters={!!analysis} channels={activeChannels} hasTypes={!!cellTypes} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="flex flex-col p-4">
          <SectionLabel>Neighbor embedding</SectionLabel>
          <div className="relative h-[360px] w-full overflow-hidden rounded-xl bg-ink-950/60 ring-1 ring-white/5">
            {analysis ? (
              <>
                <EmbeddingScatter tissue={tissue} embedding={analysis.embedding} sampleIdx={analysis.sampleIdx} labels={analysis.labels} colorBy={colorBy} cellTypes={cellTypes} />
                <ClusterLegend colorBy={colorBy} clusters={clustersPresent} cellTypes={cellTypes} annotations={clusterAnnotations} />
                <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-ink-950/70 px-1.5 py-0.5 text-[10px] text-white/45">{analysis.embedding.length.toLocaleString()} cells</span>
              </>
            ) : (
              <Empty icon={<Network className="h-6 w-6" />} text="Run clustering to compute a neighbor embedding" />
            )}
          </div>
        </Panel>

        <Panel className="flex flex-col p-4">
          <SectionLabel>Spatial cell map</SectionLabel>
          <div className="relative h-[360px] w-full overflow-hidden rounded-xl ring-1 ring-white/5">
            <SpatialMap tissue={tissue} labels={analysis?.labels} colorBy={analysis ? colorBy : cellTypes ? { mode: "type" } : { mode: "marker", marker: 1 }} cellTypes={cellTypes} />
            <ClusterLegend colorBy={analysis ? colorBy : cellTypes ? { mode: "type" } : { mode: "marker", marker: 1 }} clusters={clustersPresent} cellTypes={cellTypes} annotations={clusterAnnotations} />
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Panel className="flex flex-col p-4">
          <SectionLabel>Cluster composition</SectionLabel>
          {analysis ? (
            <div className="space-y-1.5">
              <p className="mb-1 text-[11px] leading-relaxed text-white/40">Rename a cluster to its cell type (e.g. "CD8 T cell"). Names appear in the legends and persist in the session.</p>
              {analysis.summaries.slice().sort((a, b) => b.count - a.count).map((s) => (
                <ClusterRow
                  key={s.cluster}
                  cluster={s.cluster}
                  count={s.count}
                  pct={s.pct}
                  signature={signatures[s.cluster] ?? []}
                  name={clusterAnnotations[s.cluster] ?? ""}
                  onRename={(v) => renameCluster(s.cluster, v)}
                />
              ))}
            </div>
          ) : (
            <Empty icon={<Grid3x3 className="h-6 w-6" />} text="Cluster summary appears here after you run clustering" />
          )}
        </Panel>

        <Panel className="flex flex-col p-4">
          <SectionLabel>Cluster × channel heatmap</SectionLabel>
          {analysis ? (
            <div className="flex-1">
              <MarkerHeatmap tissue={tissue} labels={analysis.labels} k={analysis.k} channels={activeChannels} annotations={clusterAnnotations} />
              <div className="mt-3 flex items-center gap-2 text-[10px] text-white/40">
                low
                <span className="h-2 flex-1 rounded-full" style={{ background: "linear-gradient(90deg,#0d0887,#8b0aa5,#db5c68,#febc2a,#f0f921)" }} />
                high
              </div>
            </div>
          ) : (
            <Empty icon={<MapPin className="h-6 w-6" />} text="Mean channel intensity per cluster" />
          )}
        </Panel>
      </div>
    </div>
  );
}

function ColorControl({
  colorBy,
  setColorBy,
  hasClusters,
  channels,
  hasTypes,
}: {
  colorBy: ColorBy;
  setColorBy: (c: ColorBy) => void;
  hasClusters: boolean;
  channels: ChannelDef[];
  hasTypes: boolean;
}) {
  const panel = panelIndices(channels.length);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-white/45">Color by</span>
      <div className="flex items-center gap-1 rounded-xl glass p-1">
        {hasClusters && <Seg active={colorBy.mode === "cluster"} onClick={() => setColorBy({ mode: "cluster" })}>Cluster</Seg>}
        {hasTypes && <Seg active={colorBy.mode === "type"} onClick={() => setColorBy({ mode: "type" })}>Cell type</Seg>}
        <Seg active={colorBy.mode === "marker"} onClick={() => setColorBy({ mode: "marker", marker: colorBy.marker ?? panel[0] })}>Channel</Seg>
      </div>
      {colorBy.mode === "marker" && (
        <select
          value={colorBy.marker}
          onChange={(e) => setColorBy({ mode: "marker", marker: parseInt(e.target.value) })}
          className="rounded-xl glass px-3 py-1.5 text-sm text-white/80 outline-none"
        >
          {panel.map((m) => (
            <option key={m} value={m} className="bg-ink-800">
              {channels[m].name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function Seg({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={clsx("rounded-lg px-3 py-1 text-xs font-semibold transition", active ? "bg-white/12 text-white ring-1 ring-white/20" : "text-white/55 hover:text-white")}>
      {children}
    </button>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="grid h-full min-h-[120px] place-items-center text-center">
      <div>
        <div className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-2xl bg-white/5 text-white/40">{icon}</div>
        <p className="max-w-[220px] text-xs text-white/40">{text}</p>
      </div>
    </div>
  );
}

function ClusterRow({
  cluster,
  count,
  pct,
  signature,
  name,
  onRename,
}: {
  cluster: number;
  count: number;
  pct: number;
  signature: MarkerSign[];
  name: string;
  onRename: (v: string) => void;
}) {
  const suggested = suggestName(signature, cluster);
  return (
    <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="rounded-xl bg-white/[0.03] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg text-xs font-bold text-ink-950" style={{ background: clusterColor(cluster) }}>
          C{cluster}
        </span>
        <input
          key={name}
          defaultValue={name}
          placeholder={suggested}
          onBlur={(e) => onRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="min-w-0 flex-1 rounded-md bg-white/[0.04] px-2 py-1 text-sm font-semibold text-white/85 outline-none placeholder:font-normal placeholder:text-white/35 focus:bg-white/[0.08]"
          aria-label={`Cell-type name for cluster ${cluster}`}
        />
        <span className="flex-shrink-0 text-[11px] text-white/55">
          {count.toLocaleString()} · {pct.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1.5">
        <SignatureChips signature={signature} />
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: clusterColor(cluster) }} />
      </div>
    </motion.div>
  );
}

function SignatureChips({ signature }: { signature: MarkerSign[] }) {
  const shown = signature.filter((s) => s.sign !== "~").slice(0, 5);
  if (shown.length === 0) return <span className="text-[11px] text-white/35">no strongly enriched markers</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((s) => (
        <span
          key={s.index}
          className={clsx("rounded px-1.5 py-0.5 text-[10px] font-semibold", s.sign === "+" ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300")}
          title={`z = ${s.z.toFixed(2)}`}
        >
          {s.name}
          <sup>{s.sign}</sup>
        </span>
      ))}
    </div>
  );
}

function suggestName(signature: MarkerSign[], cluster: number): string {
  const pos = signature.filter((s) => s.sign === "+").slice(0, 2).map((s) => s.name);
  return pos.length ? `${pos.join("/")}+ cells` : `Cluster ${cluster}`;
}

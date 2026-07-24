import { useMemo } from "react";
import { BarChart3 } from "lucide-react";
import { useStore } from "../../lib/store";
import { cellsInRoi, channelStats, shapeArea, shapeKindLabel } from "../../lib/roi";
import { clusterColor } from "../../lib/palette";
import { Panel, EmptyState } from "../ui";
import RoiComments from "./RoiComments";

export default function RoiAnalysis() {
  const rois = useStore((s) => s.rois);
  const selectedRoiId = useStore((s) => s.selectedRoiId);
  const tissue = useStore((s) => s.tissue);
  const activeChannels = useStore((s) => s.activeChannels);
  const cellTypes = useStore((s) => s.cellTypes);

  const roi = rois.find((r) => r.id === selectedRoiId) ?? null;

  const data = useMemo(() => {
    if (!roi || !tissue) return null;
    const cells = cellsInRoi(tissue.cells, roi.shape);
    const stats = activeChannels.map((_, i) => channelStats(cells, i));
    const global = activeChannels.map((_, i) => channelStats(tissue.cells, i));

    let composition: { key: string; label: string; color: string; count: number }[] = [];
    if (cells.some((c) => c.cluster != null)) {
      const m = new Map<number, number>();
      for (const c of cells) if (c.cluster != null) m.set(c.cluster, (m.get(c.cluster) ?? 0) + 1);
      composition = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cl, count]) => ({ key: `c${cl}`, label: `Cluster ${cl}`, color: clusterColor(cl), count }));
    } else if (cellTypes) {
      const m = new Map<number, number>();
      for (const c of cells) m.set(c.typeIndex, (m.get(c.typeIndex) ?? 0) + 1);
      composition = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([ti, count]) => ({ key: `t${ti}`, label: cellTypes[ti]?.name ?? `Type ${ti}`, color: cellTypes[ti]?.color ?? "#22d3ee", count }));
    }
    return { cells, stats, global, composition };
  }, [roi, tissue, activeChannels, cellTypes]);

  if (!roi || !data) {
    return (
      <Panel className="p-6" strong>
        <EmptyState icon={<BarChart3 className="h-6 w-6" />} title="No ROI selected" hint="Draw or select a region above to see its per-channel statistics and composition." />
      </Panel>
    );
  }

  const { cells, stats, global, composition } = data;
  const maxMean = Math.max(0.15, ...stats.map((s) => s.mean + s.sem));

  return (
    <Panel className="p-5" strong>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="h-3 w-3 rounded-full" style={{ background: roi.color }} />
          <h3 className="text-base font-bold">{roi.label}</h3>
          <span className="text-xs text-white/45">
            {shapeKindLabel(roi.shape)} · {cells.length.toLocaleString()} cells · {Math.round(shapeArea(roi.shape)).toLocaleString()} px²
          </span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-cyan-300/80">
            <span>Mean intensity per channel</span>
            <span className="font-normal normal-case text-white/40">± SEM · tick = whole-image mean</span>
          </div>
          <div className="space-y-2">
            {activeChannels.map((ch, i) => {
              const s = stats[i];
              const g = global[i];
              const w = (s.mean / maxMean) * 100;
              const lo = (Math.max(0, s.mean - s.sem) / maxMean) * 100;
              const hi = (Math.min(maxMean, s.mean + s.sem) / maxMean) * 100;
              const gTick = (g.mean / maxMean) * 100;
              return (
                <div key={ch.name} className="flex items-center gap-2">
                  <div className="flex w-32 flex-shrink-0 items-center gap-1.5">
                    <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: ch.color }} />
                    <span className="truncate text-xs text-white/70" title={ch.name}>{ch.name}</span>
                  </div>
                  <div className="relative h-5 flex-1 overflow-hidden rounded bg-white/[0.05]">
                    <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${w}%`, background: ch.color, opacity: 0.85 }} />
                    {/* ± SEM whisker */}
                    <div className="absolute top-1/2 h-[2px] -translate-y-1/2 bg-white/80" style={{ left: `${lo}%`, width: `${Math.max(0, hi - lo)}%` }} />
                    {/* whole-image mean tick */}
                    <div className="absolute inset-y-0 w-[2px] bg-white/45" style={{ left: `${gTick}%` }} title={`image mean ${g.mean.toFixed(3)}`} />
                  </div>
                  <span className="w-10 text-right font-mono text-[11px] text-white/70">{s.mean.toFixed(2)}</span>
                </div>
              );
            })}
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="text-white/40">
                <tr>
                  <th className="pb-1 pr-2 font-medium">Channel</th>
                  <th className="pb-1 pr-2 text-right font-medium">Mean</th>
                  <th className="pb-1 pr-2 text-right font-medium">Median</th>
                  <th className="pb-1 pr-2 text-right font-medium">SD</th>
                  <th className="pb-1 pr-2 text-right font-medium">Min</th>
                  <th className="pb-1 text-right font-medium">Max</th>
                </tr>
              </thead>
              <tbody className="font-mono text-white/70">
                {activeChannels.map((ch, i) => {
                  const s = stats[i];
                  return (
                    <tr key={ch.name} className="border-t border-white/5">
                      <td className="py-1 pr-2 font-sans text-white/80">{ch.name}</td>
                      <td className="py-1 pr-2 text-right">{s.mean.toFixed(3)}</td>
                      <td className="py-1 pr-2 text-right">{s.median.toFixed(3)}</td>
                      <td className="py-1 pr-2 text-right">{s.sd.toFixed(3)}</td>
                      <td className="py-1 pr-2 text-right">{s.min.toFixed(3)}</td>
                      <td className="py-1 text-right">{s.max.toFixed(3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-cyan-300/80">Cell composition</div>
          {composition.length ? (
            <div className="space-y-1.5">
              {composition.map((c) => {
                const pct = (c.count / cells.length) * 100;
                return (
                  <div key={c.key} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: c.color }} />
                    <span className="w-28 flex-shrink-0 truncate text-xs text-white/70" title={c.label}>{c.label}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: c.color }} />
                    </div>
                    <span className="w-16 text-right font-mono text-[11px] text-white/55">{c.count.toLocaleString()} · {pct.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-white/45">
              Composition needs cell classes. Run clustering in the <span className="text-white/70">Analysis</span> tab to break this ROI down by cluster.
            </p>
          )}
        </div>
      </div>

      <RoiComments roi={roi} />
    </Panel>
  );
}

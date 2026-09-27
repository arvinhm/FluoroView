import {
  Circle, Lasso, type LucideIcon, MessageSquarePlus, MousePointer2, Pentagon, ScanSearch, Spline, Square, Tally5,
} from "lucide-react";
import { type Tool, useStudio } from "../state/store";

export const TOOLS: [Tool, string, string, LucideIcon][] = [
  ["move", "Move and select", "V", MousePointer2],
  ["rectangle", "Rectangle", "R", Square],
  ["ellipse", "Ellipse", "E", Circle],
  ["polygon", "Polygon", "P", Pentagon],
  ["freehand", "Freehand", "F", Lasso],
  ["line", "Line profile", "L", Spline],
  ["count", "Count cells", "K", Tally5],
  ["note", "Note", "N", MessageSquarePlus],
];

const PITCH = 28;

export function ToolPalette() {
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  const loupe = useStudio((s) => s.options.loupe);
  const setOption = useStudio((s) => s.setOption);
  const index = Math.max(0, TOOLS.findIndex(([t]) => t === tool));
  return (
    <div className="tools viewer-ui" role="toolbar" aria-label="Tools" aria-orientation="vertical"
      onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="tools-thumb" style={{ transform: `translateY(${index * PITCH}px)` }} />
      {TOOLS.map(([t, label, key, Icon]) => (
        <button key={t} className={`ib${t === tool ? " sel" : ""}`} title={`${label} (${key})`} aria-pressed={t === tool}
          onClick={() => setTool(t)}><Icon /></button>
      ))}
      <span className="tools-sep" />
      <button className={`ib${loupe ? " on" : ""}`} title="Pixel loupe (Z)" aria-pressed={loupe}
        onClick={() => setOption("loupe", !loupe)}><ScanSearch /></button>
    </div>
  );
}

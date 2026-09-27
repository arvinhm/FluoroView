import type { RegionCombine, RegionOpRequest } from "../api/types";
import { isTyping } from "../lib/dom";
import { deleteNote, deleteRegion, regionOp, selectedRegions, selectRegions, useProject } from "../state/project";
import { type Accent, useStudio } from "../state/store";
import { runViewerCommand } from "../viewer/commands";
import { TOOLS } from "../viewer/ToolPalette";
import { activeTools } from "../viewer/tools";
import { exportGeoJson, exportRegionsCsv, exportRoiSet, importRegionsFile } from "./actions";

export type CommandGroup = "File" | "View" | "Image" | "Region" | "Tools" | "Help";

export interface Command {
  id: string;
  group: CommandGroup;
  title: string;
  keys?: string;
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

export const MENU_GROUPS: CommandGroup[] = ["File", "View", "Image", "Region", "Tools", "Help"];

export const COMBINE: [RegionCombine, string, string][] = [
  ["union", "Union", "Pixels in any of the selected regions"],
  ["intersect", "Intersect", "Pixels in all of the selected regions"],
  ["xor", "Exclusive or (XOR)", "Pixels in an odd number of the selected regions"],
  ["subtract", "Subtract", "The first selected region minus the others"],
];

/** Every action in the studio; menus, the palette and shortcuts all read this list. */
export function buildCommands(): Command[] {
  const s = useStudio.getState();
  const id = s.activeId;
  const ds = id ? s.datasets[id] : undefined;
  const display = id ? s.display[id] ?? [] : [];
  const none = !ds;
  const toggle = (key: "grid" | "smooth" | "minimap" | "clip" | "gallery" | "histLog" | "loupe") => () =>
    s.setOption(key, !s.options[key]);
  const accents: [Accent, string][] = [["champagne", "Champagne"], ["ice", "Ice"], ["white", "White"]];
  const regions = id ? useProject.getState().scans[id]?.regions.length ?? 0 : 0;
  const selection = useProject.getState().selection;
  const picked = selectedRegions(selection);
  const op = (req: RegionOpRequest) => () => id && void regionOp(id, req);

  const commands: Command[] = [
    { id: "open", group: "File", title: "Open image or session…", keys: "⌘O", run: () => s.setDialog("open") },
    { id: "save-session", group: "File", title: "Save session…", keys: "⌘S", disabled: none,
      run: () => s.setDialog("save-session") },
    { id: "home", group: "File", title: "Home", checked: s.page === "home", run: () => s.setPage("home") },
    { id: "scans", group: "File", title: "Scan gallery", checked: s.page === "scans", disabled: none,
      run: () => s.setPage(s.page === "scans" ? "viewer" : "scans") },
    { id: "export-regions", group: "File", title: "Export region measurements (CSV)", keys: "⌘E", disabled: !regions,
      run: () => id && void exportRegionsCsv(id) },
    { id: "export-figure", group: "File", title: "Export figure…", keys: "⇧⌘E", disabled: none,
      run: () => s.setDialog("export") },
    { id: "zoom-in", group: "View", title: "Zoom in", keys: "⌘=", disabled: none, run: () => runViewerCommand("zoom-in") },
    { id: "zoom-out", group: "View", title: "Zoom out", keys: "⌘−", disabled: none, run: () => runViewerCommand("zoom-out") },
    { id: "fit", group: "View", title: "Fit to window", keys: "⌘0", disabled: none, run: () => runViewerCommand("fit") },
    { id: "actual", group: "View", title: "Actual pixels (100%)", keys: "⌘1", disabled: none, run: () => runViewerCommand("actual") },
    { id: "gallery", group: "View", title: "Channel gallery", keys: "G", checked: s.options.gallery, run: toggle("gallery") },
    { id: "grid", group: "View", title: "Pixel grid from 800%", keys: "⇧G", checked: s.options.grid, run: toggle("grid") },
    { id: "smooth", group: "View", title: "Smooth magnification", keys: "S", checked: s.options.smooth, run: toggle("smooth") },
    { id: "minimap", group: "View", title: "Minimap", keys: "M", checked: s.options.minimap, run: toggle("minimap") },
    { id: "clip", group: "View", title: "Highlight clipped pixels", keys: "C", checked: s.options.clip, run: toggle("clip") },
    { id: "hist-log", group: "View", title: "Log-scaled histograms", keys: "⇧L", checked: s.options.histLog, run: toggle("histLog") },
    ...accents.map(([accent, label]): Command => ({
      id: `accent-${accent}`, group: "View", title: `Accent: ${label}`, checked: s.accent === accent,
      run: () => s.setAccent(accent),
    })),
    { id: "auto", group: "Image", title: "Auto contrast, all channels", keys: "A", disabled: none,
      run: () => id && s.autoContrast(id) },
    { id: "set-scale", group: "Image", title: "Set scale…", disabled: none, run: () => s.setDialog("set-scale") },
  ];
  commands.push(
    { id: "select-all-regions", group: "Region", title: "Select all regions", keys: "⌘A", disabled: !regions,
      run: () => id && selectRegions(useProject.getState().scans[id]?.regions.map((r) => r.id) ?? []) },
    ...COMBINE.map(([combine, title]): Command => ({
      id: `region-${combine}`, group: "Region", title, disabled: none || picked.length < 2,
      run: op({ op: combine, ids: picked }),
    })),
    { id: "region-enlarge", group: "Region", title: "Enlarge or shrink…", disabled: none || !picked.length,
      run: () => s.setDialog("enlarge") },
    { id: "region-hull", group: "Region", title: "Convex hull", disabled: none || !picked.length,
      run: op({ op: "hull", ids: picked }) },
    { id: "region-ellipse", group: "Region", title: "Fit ellipse", disabled: none || !picked.length,
      run: op({ op: "ellipse", ids: picked }) },
    { id: "region-specify", group: "Region", title: "Specify…", disabled: none, run: () => s.setDialog("specify") },
    { id: "region-import", group: "Region", title: "Import regions (ImageJ, QuPath)…", disabled: none,
      run: () => id && void importRegionsFile(id) },
    { id: "region-export-roiset", group: "Region", title: "Export ImageJ RoiSet (.zip)", disabled: !regions,
      run: () => id && void exportRoiSet(id) },
    { id: "region-export-geojson", group: "Region", title: "Export QuPath GeoJSON", disabled: !regions,
      run: () => id && void exportGeoJson(id) },
  );
  ds?.channels.slice(0, 9).forEach((ch, i) => {
    commands.push({
      id: `channel-${i}`, group: "Image", title: `Show ${ch.name}`, keys: `${i + 1}`, checked: display[i]?.visible,
      run: () => id && s.setChannel(id, i, { visible: !display[i]?.visible }),
    });
  });
  for (const [tool, title, keys] of TOOLS) {
    commands.push({ id: `tool-${tool}`, group: "Tools", title, keys, checked: s.tool === tool, disabled: none,
      run: () => s.setTool(tool) });
  }
  commands.push(
    { id: "loupe", group: "Tools", title: "Pixel loupe", keys: "Z", checked: s.options.loupe, disabled: none, run: toggle("loupe") },
    { id: "delete", group: "Tools", title: "Delete selection", keys: "⌫", disabled: !selection || none,
      run: () => {
        if (!id || !selection) return;
        if (selection.kind === "region") void deleteRegion(id, selection.id);
        else void deleteNote(id, selection.id);
      } },
    { id: "palette", group: "Help", title: "Command palette", keys: "⌘K", run: () => s.setDialog("palette") },
    { id: "shortcuts", group: "Help", title: "Keyboard shortcuts", keys: "?", run: () => s.setDialog("shortcuts") },
  );
  return commands;
}

export function handleShortcut(e: KeyboardEvent): void {
  const s = useStudio.getState();
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (e.key === "Escape") {
    if (s.dialog) s.setDialog(null);
    else if (s.page !== "viewer" && s.activeId) s.setPage("viewer");
    else if (activeTools.current?.key(e)) e.preventDefault();
    return;
  }
  if (mod && key === "k") {
    e.preventDefault();
    s.setDialog(s.dialog === "palette" ? null : "palette");
    return;
  }
  if (mod && key === "o") {
    e.preventDefault();
    s.setDialog("open");
    return;
  }
  if (s.dialog || isTyping(e.target)) return;
  const id = s.activeId;

  if (mod) {
    const viewer: Record<string, Parameters<typeof runViewerCommand>[0]> = {
      "=": "zoom-in", "+": "zoom-in", "-": "zoom-out", "0": "fit", "1": "actual",
    };
    const cmd = viewer[e.key];
    if (cmd && id) {
      e.preventDefault();
      runViewerCommand(cmd);
    } else if (key === "e" && id) {
      e.preventDefault();
      if (e.shiftKey) s.setDialog("export");
      else void exportRegionsCsv(id);
    } else if (key === "s") {
      e.preventDefault();
      if (id) s.setDialog("save-session");
    } else if (key === "a" && id && s.page === "viewer") {
      e.preventDefault();
      selectRegions(useProject.getState().scans[id]?.regions.map((r) => r.id) ?? []);
    }
    return;
  }
  if (s.page === "viewer" && activeTools.current?.key(e)) {
    e.preventDefault();
    return;
  }
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit && id) {
    const c = Number(digit[1]) - 1;
    const d = s.display[id]?.[c];
    if (!d) return;
    if (e.shiftKey) s.soloChannel(id, c);
    else s.setChannel(id, c, { visible: !d.visible });
    return;
  }
  const single: Record<string, () => void> = {
    "=": () => runViewerCommand("zoom-in"),
    "+": () => runViewerCommand("zoom-in"),
    "-": () => runViewerCommand("zoom-out"),
    "0": () => runViewerCommand("fit"),
    g: () => s.setOption("gallery", !s.options.gallery),
    G: () => s.setOption("grid", !s.options.grid),
    s: () => s.setOption("smooth", !s.options.smooth),
    m: () => s.setOption("minimap", !s.options.minimap),
    c: () => s.setOption("clip", !s.options.clip),
    L: () => s.setOption("histLog", !s.options.histLog),
    z: () => s.setOption("loupe", !s.options.loupe),
    a: () => id && s.autoContrast(id),
    "?": () => s.setDialog("shortcuts"),
  };
  for (const [tool, , keys] of TOOLS) single[keys.toLowerCase()] = () => s.setTool(tool);
  const action = single[e.key] ?? (e.shiftKey ? undefined : single[key]);
  if (action && (id || e.key === "?")) {
    e.preventDefault();
    action();
  }
}

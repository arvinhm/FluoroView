import { type Accent, useStudio } from "../state/store";
import { runViewerCommand } from "../viewer/commands";

export type CommandGroup = "File" | "View" | "Image" | "Help";

export interface Command {
  id: string;
  group: CommandGroup;
  title: string;
  keys?: string;
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

export const MENU_GROUPS: CommandGroup[] = ["File", "View", "Image", "Help"];

/** Every action in the studio; menus, the palette and shortcuts all read this list. */
export function buildCommands(): Command[] {
  const s = useStudio.getState();
  const id = s.activeId;
  const ds = id ? s.datasets[id] : undefined;
  const display = id ? s.display[id] ?? [] : [];
  const none = !ds;
  const toggle = (key: "grid" | "smooth" | "minimap" | "clip" | "gallery" | "histLog") => () =>
    s.setOption(key, !s.options[key]);
  const accents: [Accent, string][] = [["champagne", "Champagne"], ["ice", "Ice"], ["white", "White"]];

  const commands: Command[] = [
    { id: "open", group: "File", title: "Open image…", keys: "⌘O", run: () => s.setDialog("open") },
    { id: "scans", group: "File", title: "Scan gallery", checked: s.page === "scans", disabled: none,
      run: () => s.setPage(s.page === "scans" ? "viewer" : "scans") },
    { id: "zoom-in", group: "View", title: "Zoom in", keys: "⌘=", disabled: none, run: () => runViewerCommand("zoom-in") },
    { id: "zoom-out", group: "View", title: "Zoom out", keys: "⌘−", disabled: none, run: () => runViewerCommand("zoom-out") },
    { id: "fit", group: "View", title: "Fit to window", keys: "⌘0", disabled: none, run: () => runViewerCommand("fit") },
    { id: "actual", group: "View", title: "Actual pixels (100%)", keys: "⌘1", disabled: none, run: () => runViewerCommand("actual") },
    { id: "gallery", group: "View", title: "Channel gallery", keys: "G", checked: s.options.gallery, run: toggle("gallery") },
    { id: "grid", group: "View", title: "Pixel grid from 800%", keys: "⇧G", checked: s.options.grid, run: toggle("grid") },
    { id: "smooth", group: "View", title: "Smooth magnification", keys: "S", checked: s.options.smooth, run: toggle("smooth") },
    { id: "minimap", group: "View", title: "Minimap", keys: "M", checked: s.options.minimap, run: toggle("minimap") },
    { id: "clip", group: "View", title: "Highlight clipped pixels", keys: "C", checked: s.options.clip, run: toggle("clip") },
    { id: "hist-log", group: "View", title: "Log-scaled histograms", keys: "L", checked: s.options.histLog, run: toggle("histLog") },
    ...accents.map(([accent, label]): Command => ({
      id: `accent-${accent}`, group: "View", title: `Accent: ${label}`, checked: s.accent === accent,
      run: () => s.setAccent(accent),
    })),
    { id: "auto", group: "Image", title: "Auto contrast, all channels", keys: "A", disabled: none,
      run: () => id && s.autoContrast(id) },
  ];
  ds?.channels.slice(0, 9).forEach((ch, i) => {
    commands.push({
      id: `channel-${i}`, group: "Image", title: `Show ${ch.name}`, keys: `${i + 1}`, checked: display[i]?.visible,
      run: () => id && s.setChannel(id, i, { visible: !display[i]?.visible }),
    });
  });
  commands.push(
    { id: "palette", group: "Help", title: "Command palette", keys: "⌘K", run: () => s.setDialog("palette") },
    { id: "shortcuts", group: "Help", title: "Keyboard shortcuts", keys: "?", run: () => s.setDialog("shortcuts") },
  );
  return commands;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

export function handleShortcut(e: KeyboardEvent): void {
  const s = useStudio.getState();
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (e.key === "Escape") {
    if (s.dialog) s.setDialog(null);
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
    }
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
    l: () => s.setOption("histLog", !s.options.histLog),
    a: () => id && s.autoContrast(id),
    "?": () => s.setDialog("shortcuts"),
  };
  const action = single[e.key] ?? (e.shiftKey ? undefined : single[key]);
  if (action && (id || e.key === "?")) {
    e.preventDefault();
    action();
  }
}

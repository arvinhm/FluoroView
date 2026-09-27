import { useMemo, useState } from "react";
import { useStudio } from "../state/store";
import { buildCommands } from "./commands";

export function CommandPalette() {
  const setDialog = useStudio((s) => s.setDialog);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return buildCommands().filter((c) => !c.disabled && words.every((w) => `${c.group} ${c.title}`.toLowerCase().includes(w)));
  }, [query]);
  const run = (i: number) => {
    const cmd = matches[i];
    if (!cmd) return;
    setDialog(null);
    cmd.run();
  };

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
      <div className="dialog palette" role="dialog" aria-label="Command palette">
        <input
          className="input"
          autoFocus
          placeholder="Type a command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(matches.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              run(index);
            }
          }}
        />
        <div className="scroll">
          {matches.map((c, i) => (
            <button key={c.id} className={`row${i === index ? " active" : ""}`} onPointerEnter={() => setIndex(i)} onClick={() => run(i)}>
              <span className="group">{c.group}</span>
              <span className="name">{c.title}{c.checked !== undefined ? (c.checked ? "  ✓" : "") : ""}</span>
              {c.keys && <span className="kbd">{c.keys}</span>}
            </button>
          ))}
          {matches.length === 0 && <div className="empty-note">No matching command.</div>}
        </div>
      </div>
    </div>
  );
}

export function ShortcutsDialog() {
  const setDialog = useStudio((s) => s.setDialog);
  const rows: [string, string][] = [
    ...buildCommands().filter((c) => c.keys && !c.id.startsWith("channel-")).map((c): [string, string] => [c.title, c.keys!]),
    ["Show / hide channel 1–9", "1 … 9"],
    ["Show only channel 1–9", "⇧1 … ⇧9"],
    ["Pan", "Drag · two-finger scroll"],
    ["Pan while drawing", "Space-drag · middle-drag"],
    ["Zoom about the cursor", "Pinch · mouse wheel"],
    ["Zoom in 2× (⌥ out)", "Double-click"],
    ["Zoom to a region", "Double-click the region"],
    ["Nudge the selected region (⇧ 10 px)", "← ↑ → ↓"],
    ["Add a region to the selection", "⇧-click"],
    ["Cancel drawing · deselect", "Esc"],
  ];
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
      <div className="dialog" style={{ width: 460 }} role="dialog" aria-label="Keyboard shortcuts">
        <div className="dialog-h">Keyboard shortcuts</div>
        <div className="shortcuts">
          {rows.map(([title, keys]) => (
            <div key={title} style={{ display: "contents" }}>
              <span>{title}</span>
              <span className="kbd">{keys}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

import { Check, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fmtInt } from "../lib/format";
import { useProject } from "../state/project";
import { useActive, useStudio } from "../state/store";
import { buildCommands, type CommandGroup, MENU_GROUPS } from "./commands";

export function TopBar() {
  const ds = useActive();
  const setDialog = useStudio((s) => s.setDialog);
  const page = useStudio((s) => s.page);
  const setPage = useStudio((s) => s.setPage);
  useStudio((s) => s.options);
  useStudio((s) => s.tool);
  useStudio((s) => (s.activeId ? s.display[s.activeId] : undefined));
  useProject((s) => s.selection);
  useProject((s) => (ds ? s.scans[ds.id]?.regions.length : 0));
  const [open, setOpen] = useState<CommandGroup | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const commands = buildCommands();

  return (
    <header className="bar">
      <button className="mark" title="Home" onClick={() => setPage(page === "home" && ds ? "viewer" : "home")}>
        FluoroView<sup>4</sup>
      </button>
      <div ref={wrap} style={{ display: "flex" }}>
        {MENU_GROUPS.map((group) => (
          <div key={group} className="menu-wrap">
            <button
              className="menu-trigger"
              aria-expanded={open === group}
              onClick={() => setOpen(open === group ? null : group)}
              onPointerEnter={() => open && setOpen(group)}
            >
              {group}
            </button>
            {open === group && (
              <div className="menu" role="menu">
                {commands.filter((c) => c.group === group).map((c, i, list) => (
                  <div key={c.id}>
                    {i > 0 && list[i - 1]!.checked === undefined && c.checked !== undefined && <div className="menu-sep" />}
                    <button
                      className="menu-item"
                      role="menuitem"
                      disabled={c.disabled}
                      onClick={() => {
                        setOpen(null);
                        c.run();
                      }}
                    >
                      <span className="check">{c.checked ? <Check /> : null}</span>
                      <span>{c.title}</span>
                      {c.keys && <span className="kbd">{c.keys}</span>}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <span className="title">
        {ds ? (
          <>
            <b>{ds.name}</b> &nbsp;·&nbsp; <span className="num">{fmtInt(ds.width)} × {fmtInt(ds.height)}</span>
          </>
        ) : (
          "No image open"
        )}
      </span>
      <button className="cmd" onClick={() => setDialog("palette")}>
        <Search />
        <span>Search or run a command</span>
        <span className="kbd">⌘K</span>
      </button>
    </header>
  );
}

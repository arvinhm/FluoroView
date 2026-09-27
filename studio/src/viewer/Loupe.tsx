import { useEffect, useRef, useState } from "react";
import { project as papi } from "../api/client";
import type { DatasetInfo, Patch } from "../api/types";
import { fmtInt } from "../lib/format";
import { type Blend, lookup, lutFor } from "../lib/lut";
import { type ChannelDisplay, useStudio } from "../state/store";
import type { Bounds } from "./overlay";

const RADIUS = 5;
const CELL = 12;
const OFFSET = 22;
const MARGIN = 8;

/** The image shader's colour for one pixel: window, gamma, the channel's colour table, then the blend. */
export function compositeColor(values: readonly number[], display: readonly ChannelDisplay[], blend: Blend): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  display.forEach((d, c) => {
    if (!d.visible) return;
    const t = Math.min(1, Math.max(0, ((values[c] ?? 0) - d.lo) / Math.max(d.hi - d.lo, 1))) ** (1 / d.gamma);
    const [cr, cg, cb] = lookup(lutFor(d).table, t);
    if (blend === "max") {
      r = Math.max(r, cr);
      g = Math.max(g, cg);
      b = Math.max(b, cb);
    } else {
      r += cr;
      g += cg;
      b += cb;
    }
  });
  return [Math.round(Math.min(1, r) * 255), Math.round(Math.min(1, g) * 255), Math.round(Math.min(1, b) * 255)];
}

export function Loupe({ ds, bounds }: { ds: DatasetInfo; bounds: Bounds }) {
  const cursor = useStudio((s) => s.cursor);
  const display = useStudio((s) => s.display[ds.id]);
  const blend = useStudio((s) => s.options.blend);
  const [patch, setPatch] = useState<(Patch & { cx: number; cy: number }) | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 170, h: 250 });
  const wanted = useRef<[number, number] | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!cursor) return;
    wanted.current = [cursor.x, cursor.y];
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      while (wanted.current) {
        const [x, y] = wanted.current;
        wanted.current = null;
        try {
          setPatch({ ...(await papi.patch(ds.id, x, y, RADIUS)), cx: x, cy: y });
        } catch {
          // keep showing the last patch; the next move retries
        }
      }
      busy.current = false;
    })();
  }, [ds.id, cursor?.x, cursor?.y]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !patch || !display) return;
    const dpr = window.devicePixelRatio || 1;
    const n = patch.size;
    cv.width = n * CELL * dpr;
    cv.height = n * CELL * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const k = row * n + col;
        const [r, g, b] = compositeColor(patch.channels.map((ch) => ch[k]!), display, blend);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
      }
    }
    ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      ctx.moveTo(i * CELL + 0.5, 0);
      ctx.lineTo(i * CELL + 0.5, n * CELL);
      ctx.moveTo(0, i * CELL + 0.5);
      ctx.lineTo(n * CELL, i * CELL + 0.5);
    }
    ctx.stroke();
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--fv-accent").trim() || "#d9c4a1";
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect((patch.cx - patch.x0) * CELL + 0.75, (patch.cy - patch.y0) * CELL + 0.75, CELL - 1.5, CELL - 1.5);
  }, [patch, display, blend]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });

  if (!cursor || !display) return null;
  const left = cursor.left + OFFSET + size.w <= bounds.w - MARGIN ? cursor.left + OFFSET : cursor.left - OFFSET - size.w;
  const top = cursor.top + OFFSET + size.h <= bounds.h - MARGIN ? cursor.top + OFFSET : cursor.top - OFFSET - size.h;
  const centre = patch ? (patch.cy - patch.y0) * patch.size + (patch.cx - patch.x0) : -1;

  return (
    <div ref={boxRef} className="loupe" style={{ transform: `translate(${Math.max(MARGIN, left)}px, ${Math.max(MARGIN, top)}px)` }}>
      <div className="loupe-h num">
        <span>x {fmtInt(patch?.cx ?? cursor.x)}</span>
        <span>y {fmtInt(patch?.cy ?? cursor.y)}</span>
      </div>
      <canvas ref={canvasRef} className="loupe-px" style={{ width: (patch?.size ?? 2 * RADIUS + 1) * CELL, height: (patch?.size ?? 2 * RADIUS + 1) * CELL }} />
      <div className="loupe-vals">
        {ds.channels.map((ch, c) => {
          const d = display[c];
          const v = patch && centre >= 0 ? patch.channels[c]?.[centre] : cursor.values[c];
          return (
            <div key={ch.index} className={`loupe-row${d?.visible ? "" : " off"}`}>
              <span className="sw" style={{ background: d?.color ?? ch.color }} />
              <span className="loupe-name">{ch.name}</span>
              <span className="num">{v === null || v === undefined ? "—" : fmtInt(v)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

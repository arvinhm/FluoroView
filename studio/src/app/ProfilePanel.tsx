import { Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DatasetInfo } from "../api/types";
import { fmtInt } from "../lib/format";
import { niceTicks } from "../lib/ticks";
import { setLine, setProfileHover, useProject } from "../state/project";
import { useStudio } from "../state/store";
import { formatLength } from "../viewer/camera";
import { exportProfileCsv } from "./actions";
import { Segmented } from "./Segmented";

const PAD = { l: 54, r: 16, t: 14, b: 24 };
const GRID = "#1c1d21";
const AXIS_TEXT = "#6c6f77";
const CURSOR = "#45474e";

type Scale = "raw" | "window";

export function ProfilePanel({ ds }: { ds: DatasetInfo }) {
  const line = useProject((s) => s.line);
  const profile = useProject((s) => s.profile);
  const loading = useProject((s) => s.profileLoading);
  const error = useProject((s) => s.profileError);
  const hover = useProject((s) => s.profileHover);
  const display = useStudio((s) => s.display[ds.id]);
  const [scale, setScale] = useState<Scale>("raw");
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const um = profile?.distance_um ?? null;
  const xs = um ?? profile?.distance_px ?? [];
  const visible = display ? ds.channels.flatMap((_, i) => (display[i]?.visible ? [i] : [])) : [];
  const valueOf = (c: number, v: number) => {
    if (scale === "raw" || !display?.[c]) return v;
    const d = display[c]!;
    return (v - d.lo) / Math.max(d.hi - d.lo, 1);
  };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !profile || !display || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const plotW = size.w - PAD.l - PAD.r;
    const plotH = size.h - PAD.t - PAD.b;
    if (plotW <= 0 || plotH <= 0) return;
    const xMax = xs[xs.length - 1] || 1;
    let yMax = 1;
    let yMin = 0;
    for (const c of visible) {
      for (const v of profile.channels[c]!.values) {
        const y = valueOf(c, v);
        if (y > yMax) yMax = y;
        if (y < yMin) yMin = y;
      }
    }
    const X = (v: number) => PAD.l + (v / xMax) * plotW;
    const Y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;

    ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillStyle = AXIS_TEXT;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of niceTicks(yMin, yMax, 4)) {
      const y = Math.round(Y(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + plotW, y);
      ctx.stroke();
      ctx.fillText(scale === "window" ? `${Math.round(t * 100)}%` : fmtInt(t), PAD.l - 8, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of niceTicks(0, xMax, Math.max(2, Math.floor(plotW / 110)))) {
      ctx.fillText(um ? formatLength(t) : `${fmtInt(t)} px`, X(t), PAD.t + plotH + 7);
    }

    ctx.lineJoin = "round";
    ctx.lineWidth = 1.25;
    for (const c of visible) {
      const values = profile.channels[c]!.values;
      ctx.strokeStyle = display[c]!.color;
      ctx.beginPath();
      values.forEach((v, i) => {
        const x = X(xs[i]!);
        const y = Y(valueOf(c, v));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    if (hover !== null && hover < profile.samples) {
      const x = Math.round(X(xs[hover]!)) + 0.5;
      ctx.strokeStyle = CURSOR;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + plotH);
      ctx.stroke();
      for (const c of visible) {
        ctx.beginPath();
        ctx.arc(x, Y(valueOf(c, profile.channels[c]!.values[hover]!)), 3, 0, 2 * Math.PI);
        ctx.fillStyle = display[c]!.color;
        ctx.fill();
      }
    }
  });

  if (!line || line.dsId !== ds.id) return null;
  const length = Math.hypot(line.x1 - line.x0, line.y1 - line.y0);
  const onMove = (e: React.PointerEvent) => {
    if (!profile) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const plotW = rect.width - PAD.l - PAD.r;
    const t = (e.clientX - rect.left - PAD.l) / plotW;
    setProfileHover(t < 0 || t > 1 ? null : Math.round(t * (profile.samples - 1)));
  };
  const resolution = profile ? (profile.level === 0 ? "full resolution"
    : `level ${profile.level} · ${2 ** profile.level}×${2 ** profile.level} px means`) : "";

  return (
    <section className="profile viewer-ui" aria-label="Line profile">
      <div className="profile-h">
        <span className="caps">Line profile</span>
        <span className="profile-meta num">
          {ds.pixel_size_um ? formatLength(length * ds.pixel_size_um) : `${fmtInt(length)} px`}
          {profile && <> · {fmtInt(profile.samples)} samples · {resolution}</>}
          {loading && <span className="muted"> · reading…</span>}
          {error && <span className="err"> · {error}</span>}
        </span>
        <span className="profile-act">
          <Segmented value={scale} options={[["raw", "Raw"], ["window", "Display window"]]} onChange={setScale} />
          <button className="btn" disabled={!profile} onClick={() => void exportProfileCsv(ds.id, line)}
            title="One row per sample: position, distance, raw value per channel"><Download /> CSV</button>
          <button className="ib" title="Remove line (Esc)" onClick={() => setLine(ds.id, null)}><X /></button>
        </span>
      </div>
      <div className="profile-body" ref={wrapRef} onPointerMove={onMove} onPointerLeave={() => setProfileHover(null)}>
        <canvas ref={canvasRef} />
        {profile && hover !== null && hover < profile.samples && (
          <div className="profile-legend num">
            <span className="muted">{um ? formatLength(um[hover]!) : `${fmtInt(profile.distance_px[hover]!)} px`}</span>
            {visible.map((c) => (
              <span key={c}>
                <span className="sw" style={{ background: display![c]!.color }} />
                {fmtInt(profile.channels[c]!.values[hover]!)}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

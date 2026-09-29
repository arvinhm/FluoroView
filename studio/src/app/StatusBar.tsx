import { api } from "../api/client";
import { fmt1, fmtInt, fmtZoom } from "../lib/format";
import { type Tool, useActive, useStudio } from "../state/store";

const HINTS: Record<Tool, string | null> = {
  move: null,
  rectangle: "Drag to draw · ⇧ square · ⌥ from centre · Esc cancels",
  ellipse: "Drag to draw · ⇧ circle · ⌥ from centre · Esc cancels",
  polygon: "Click to add points · Enter or double-click closes · ⌫ removes the last point",
  freehand: "Drag around the area · release to close",
  line: "Drag to draw a line · ⇧ snaps to 45°",
  count: "Click to count · ⌥-click removes · Esc ends counting",
  note: "Click to pin a note",
};

function BuildStatus() {
  const ds = useActive();
  if (!ds) return null;
  const b = ds.build;
  switch (b.state) {
    case "queued":
      return <span><span className="led busy" />Waiting to read the scan</span>;
    case "building":
      return (
        <span title="Reading the scan once to build the zoom levels and exact histograms">
          <span className="progress"><span style={{ width: `${b.progress * 100}%` }} /></span>
          Reading scan {Math.round(b.progress * 100)}%{b.elapsed_s ? ` · ${b.elapsed_s.toFixed(1)} s` : ""}
        </span>
      );
    case "ready":
      return <span><span className="led ok" />Pyramid cached{b.seconds ? ` · built in ${b.seconds.toFixed(1)} s` : ""}</span>;
    case "failed":
      return <span className="err" title={b.error ?? ""}><span className="led bad" />Pyramid failed</span>;
    case "cancelled":
      return <span className="muted">Pyramid cancelled</span>;
    default: {
      const unreachable: never = b.state;
      return unreachable;
    }
  }
}

export function StatusBar() {
  const ds = useActive();
  const cursor = useStudio((s) => s.cursor);
  const view = useStudio((s) => s.view);
  const display = useStudio((s) => (ds ? s.display[ds.id] : undefined));
  const connected = useStudio((s) => s.connected);
  const hint = useStudio((s) => HINTS[s.tool]);
  const px = ds?.pixel_size_um ?? null;

  return (
    <footer className="status">
      {ds && cursor ? (
        <>
          <span><span className="k">x</span> {fmtInt(cursor.x)} <span className="k">y</span> {fmtInt(cursor.y)} <span className="k">px</span></span>
          {px && (
            <>
              <span className="d" />
              <span>{fmt1(cursor.x * px)} <span className="k">·</span> {fmt1(cursor.y * px)} <span className="k">µm</span></span>
            </>
          )}
          <span className="d" />
          {ds.channels.map((ch, c) =>
            display?.[c]?.visible ? (
              <span key={c}>
                <span className="sw" style={{ background: display[c]!.color }} />
                <span className="k">{ch.name}</span> {cursor.values[c] === null || cursor.values[c] === undefined ? "…" : fmtInt(cursor.values[c]!)}
              </span>
            ) : null,
          )}
        </>
      ) : (
        <span className="k">{ds ? "Move over the image to read raw pixel values" : "FluoroView 4.0"}</span>
      )}
      <span className="end">
        {ds && hint && (
          <>
            <span className="hint-live">{hint}</span>
            <span className="d" />
          </>
        )}
        {ds && view && <span>{fmtZoom(view.scale)} <span className="k">·</span> L{view.level}{view.level === 0 ? " native" : ""}</span>}
        {px && (
          <>
            <span className="d" />
            <span>{px.toFixed(4)} <span className="k">µm/px</span></span>
          </>
        )}
        {ds && <span className="d" />}
        <BuildStatus />
        <span className="d" />
        {api.inBrowser ? (
          <span title="FluoroView is running in this browser, on this computer; files are not uploaded">
            <span className="led ok" />
            In this browser
          </span>
        ) : (
          <span title={connected ? "Connected to the local engine" : "Engine connection lost; retrying"}>
            <span className={`led ${connected ? "ok" : "bad"}`} />
            {connected ? "Engine" : "Reconnecting"}
          </span>
        )}
      </span>
    </footer>
  );
}

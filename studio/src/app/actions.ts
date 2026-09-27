import { api, ApiError, project, sessions } from "../api/client";
import type { DatasetInfo, SessionInfo, SessionSaveRequest } from "../api/types";
import { pickFile, saveBlob } from "../lib/dom";
import { fmtBytes } from "../lib/format";
import { importRegions, type Line, setLine, setScanState, useProject } from "../state/project";
import { useStudio } from "../state/store";

/** Export dialog choices, remembered in the browser and carried in session files. */
export const EXPORT_SETTINGS_KEY = "fluoroview.export";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function download(fetchFile: () => Promise<{ blob: Blob; name: string }>): Promise<void> {
  try {
    const { blob, name } = await fetchFile();
    saveBlob(blob, name);
  } catch (e) {
    useStudio.getState().setNotice(e instanceof Error ? e.message : String(e));
  }
}

/** One row per region × channel, measured by the engine on raw full-resolution pixels. */
export function exportRegionsCsv(id: string): Promise<void> {
  return download(() => project.regionsCsv(id));
}

export function exportProfileCsv(id: string, line: Line): Promise<void> {
  return download(() => project.profileCsv(id, line));
}

/** Cell Counter: one row per counted point. */
export function exportPointsCsv(id: string): Promise<void> {
  return download(() => project.pointsCsv(id));
}

/** Cell Counter: counts and densities per category and region, and over the whole image. */
export function exportCountsCsv(id: string): Promise<void> {
  return download(() => project.countsCsv(id));
}

export function exportRoiSet(id: string): Promise<void> {
  return download(() => project.roiSet(id));
}

export function exportGeoJson(id: string): Promise<void> {
  return download(() => project.geojson(id));
}

/** Pick an ImageJ .roi or RoiSet.zip, or a QuPath GeoJSON file, and add its regions to the scan. */
export async function importRegionsFile(id: string): Promise<void> {
  const file = await pickFile(".roi,.zip,.geojson,.json");
  if (file) await importRegions(id, file);
}

export async function loadHistograms(id: string): Promise<void> {
  const s = useStudio.getState();
  const ds = s.datasets[id];
  if (!ds) return;
  await Promise.all(
    ds.channels.map((_, c) =>
      api.histogram(id, c).then((h) => useStudio.getState().setHistogram(id, c, h)).catch((e: unknown) => {
        if (!(e instanceof ApiError && e.status === 409)) console.warn("histogram", c, e);
      }),
    ),
  );
}

function remember(ds: DatasetInfo): void {
  useStudio.getState().addRecent({
    kind: ds.files.length ? "channels" : "image", paths: ds.files.length ? ds.files : [ds.path], name: ds.name,
    folder: ds.folder, width: ds.width, height: ds.height, channels: ds.channels.length,
  });
}

async function openWith(request: () => Promise<DatasetInfo>): Promise<boolean> {
  const s = useStudio.getState();
  try {
    const ds = await request();
    s.upsertDataset(ds);
    s.setActive(ds.id);
    remember(ds);
    void loadHistograms(ds.id);
    return true;
  } catch (e) {
    s.setNotice(e instanceof Error ? e.message : String(e));
    return false;
  }
}

export async function openImage(path: string): Promise<boolean> {
  const s = useStudio.getState();
  const existing = Object.values(s.datasets).find((d) => d.files.length === 0 && d.path === path);
  if (existing) {
    s.setActive(existing.id);
    remember(existing);
    return true;
  }
  return openWith(() => api.open(path));
}

/** Open single-channel files of the same size as the channels of one image. */
export async function openChannels(paths: string[]): Promise<boolean> {
  const s = useStudio.getState();
  const existing = Object.values(s.datasets).find((d) => d.files.join("\n") === paths.join("\n"));
  if (existing) {
    s.setActive(existing.id);
    remember(existing);
    return true;
  }
  return openWith(() => api.openChannels(paths));
}

/** Suggested session file name: the scan's name without extension, or <folder>_<n>ch for combined files. */
export function sessionName(ds: DatasetInfo): string {
  const base = ds.files.length
    ? `${ds.folder.split("/").filter(Boolean).pop() ?? "scan"}_${ds.files.length}ch`
    : (ds.path.split("/").pop() ?? "scan").replace(/\.[^.]+$/, "").replace(/\.ome$/i, "");
  return `${base.replace(/[^\w.-]+/g, "_")}.fv`;
}

/** What only the studio knows about a dataset: display, view, viewer options, line and export choices. */
function studioState(id: string): Omit<SessionSaveRequest, "path" | "overwrite"> {
  const s = useStudio.getState();
  const ds = s.datasets[id]!;
  const display = (s.display[id] ?? []).map(({ visible, color, lo, hi, gamma, touched }) => ({ visible, color, lo, hi, gamma, touched }));
  const v = s.activeId === id ? s.view : null;
  const o = s.options;
  const line = useProject.getState().line;
  let exported: Record<string, unknown> | null = null;
  try {
    exported = JSON.parse(localStorage.getItem(EXPORT_SETTINGS_KEY) ?? "null") as Record<string, unknown> | null;
  } catch {
    exported = null;
  }
  return {
    display,
    view: v ? { cx: v.cx, cy: v.cy, zoom: v.cssPxPerImagePx, gallery: o.gallery }
      : { cx: ds.width / 2, cy: ds.height / 2, zoom: 1, gallery: o.gallery },
    viewer: { grid: o.grid, smooth: o.smooth, clip: o.clip, minimap: o.minimap, hist_log: o.histLog },
    profile_line: line?.dsId === id ? { x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 } : null,
    export: exported,
  };
}

export async function saveSession(id: string, path: string, overwrite: boolean): Promise<string | null> {
  const s = useStudio.getState();
  try {
    const res = await sessions.save(id, { path, overwrite, ...studioState(id) });
    s.setNotice(`Saved ${res.path.split("/").pop()} (${fmtBytes(res.bytes)}): regions, notes, display and view.`);
    return res.path;
  } catch (e) {
    s.setNotice(`Could not save the session: ${message(e)}`);
    return null;
  }
}

/** Open a .fv: find and open its image, then restore it (asking first if the image already has work). */
export async function openSession(path: string): Promise<boolean> {
  const s = useStudio.getState();
  let info: SessionInfo;
  try {
    info = await sessions.inspect(path);
  } catch (e) {
    s.setNotice(`Could not open the session: ${message(e)}`);
    return false;
  }
  const { image } = info.manifest;
  s.addRecent({
    kind: "session", paths: [path], name: path.split("/").pop() ?? path, folder: path.slice(0, path.lastIndexOf("/")),
    width: image.width, height: image.height, channels: image.channels.length,
  });
  const paths = info.image_paths;
  if (!paths) {
    s.setPendingSession({ path, names: info.manifest.image.names });
    s.setDialog("open");
    return false;
  }
  const ok = paths.length > 1 ? await openChannels(paths) : await openImage(paths[0]!);
  const id = useStudio.getState().activeId;
  if (!ok || !id) return false;
  await restoreInto(id, path, info);
  return true;
}

export async function restoreInto(id: string, path: string, info?: SessionInfo): Promise<void> {
  const s = useStudio.getState();
  try {
    const incoming = info ?? await sessions.inspect(path);
    const current = await project.get(id);
    if (current.regions.length || current.annotations.length) {
      s.setSessionPrompt({
        path, dsId: id,
        existing: { regions: current.regions.length, notes: current.annotations.length },
        incoming: { regions: incoming.regions, notes: incoming.notes },
      });
      return;
    }
    await applySession(id, path, "replace");
  } catch (e) {
    s.setNotice(`Could not restore the session: ${message(e)}`);
  }
}

export async function applySession(id: string, path: string, mode: "replace" | "merge"): Promise<void> {
  const s = useStudio.getState();
  s.setSessionPrompt(null);
  try {
    const r = await sessions.apply(id, path, mode);
    setScanState(id, r.project);
    if (r.viewer) {
      s.setOption("grid", r.viewer.grid);
      s.setOption("smooth", r.viewer.smooth);
      s.setOption("clip", r.viewer.clip);
      s.setOption("minimap", r.viewer.minimap);
      s.setOption("histLog", r.viewer.hist_log);
    }
    if (r.view) {
      s.setOption("gallery", r.view.gallery);
      s.setPendingView({ dsId: id, cx: r.view.cx, cy: r.view.cy, zoom: r.view.zoom });
    }
    setLine(id, r.profile_line);
    if (r.export) localStorage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify(r.export));
    const issues = [
      ...(r.fingerprint_ok ? [] : ["this image's pixels differ from the image it was saved with"]),
      ...(r.channels_match ? [] : ["the channel names differ"]),
    ];
    const name = path.split("/").pop();
    s.setNotice(issues.length
      ? `Restored ${name}, but ${issues.join(" and ")}. Regions are at their saved coordinates.`
      : `Restored ${name}${r.backup ? "; the work it replaced was kept as a backup" : ""}.`);
  } catch (e) {
    s.setNotice(`Could not restore the session: ${message(e)}`);
  }
}

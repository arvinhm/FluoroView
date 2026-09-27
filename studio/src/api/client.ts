import type {
  Annotation, Counter, CountPoint, DatasetInfo, EngineEvent, ExportPlan, FigureRequest, FsListing, Histogram,
  ImportedRegions, Measurement, Patch, Point,
  Profile, Project, RawRequest, Region, RegionOpRequest, RegionShape, SavedDisplay, SessionApplied, SessionInfo,
  SessionSaveRequest,
} from "./types";

const TOKEN_KEY = "fluoroview.token";

/**
 * The engine opens `/#token=…`. The token is remembered for this address, in every tab and after restarts
 * (the engine keeps its token between launches), and removed from the address bar.
 */
function readToken(): string {
  const match = /(?:^|[#&])token=([^&]+)/.exec(window.location.hash);
  if (match?.[1]) {
    localStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1]));
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

const token = readToken();
const auth = { Authorization: `Bearer ${token}` };

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { ...init, headers: { ...auth, ...init.headers } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {
      detail = (await res.text().catch(() => detail)) || detail;
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

function send(method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown): RequestInit {
  return body === undefined ? { method }
    : { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
}

/** File name from a Content-Disposition header (plain or RFC 5987 encoded), if it gives one. */
function attachmentName(header: string | null, fallback: string): string {
  const encoded = /filename\*=utf-8''([^;]+)/i.exec(header ?? "")?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return /filename="([^"]+)"/.exec(header ?? "")?.[1] ?? fallback;
}

export const project = {
  get: (id: string) => request<Project>(`/datasets/${id}/project`),
  createRegion: (id: string, body: { shape: RegionShape; points: Point[]; name?: string; color?: string }) =>
    request<Region>(`/datasets/${id}/regions`, send("POST", body)),
  patchRegion: (id: string, rid: string, body: { name?: string; points?: Point[]; rings?: Point[][]; color?: string }) =>
    request<Region>(`/datasets/${id}/regions/${rid}`, send("PATCH", body)),
  /** Union, intersect, XOR, subtract, enlarge/shrink, convex hull or fit ellipse; the results are new regions. */
  regionOp: (id: string, body: RegionOpRequest) =>
    request<{ regions: Region[] }>(`/datasets/${id}/regions/op`, send("POST", body)),
  /** Regions from an ImageJ .roi or RoiSet.zip, or a QuPath GeoJSON file, added to the scan's regions. */
  importRegions: (id: string, file: File) =>
    request<ImportedRegions>(`/datasets/${id}/regions/import?filename=${encodeURIComponent(file.name)}`,
      { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } }),
  roiSet: (id: string) => download(`/datasets/${id}/regions.zip`, "RoiSet.zip"),
  geojson: (id: string) => download(`/datasets/${id}/regions.geojson`, "regions.geojson"),
  deleteRegion: (id: string, rid: string) =>
    request<{ deleted: string; background_region: string | null }>(`/datasets/${id}/regions/${rid}`, send("DELETE")),
  /** Put back a deleted region with its original id. */
  restoreRegion: (id: string, region: Region) => request<Region>(`/datasets/${id}/regions/restore`, send("POST", region)),
  restoreNote: (id: string, note: Annotation) => request<Annotation>(`/datasets/${id}/annotations/restore`, send("POST", note)),
  setBackground: (id: string, rid: string | null) =>
    request<{ background_region: string | null }>(`/datasets/${id}/background`, send("PUT", { region_id: rid })),
  saveDisplay: (id: string, channels: SavedDisplay[]) => request<{ saved: number }>(`/datasets/${id}/display`, send("PUT", channels)),
  /** Set Scale: µm per pixel, or null to go back to the file's pixel size. */
  setCalibration: (id: string, pixelSizeUm: number | null) =>
    request<{ pixel_size_um: number | null }>(`/datasets/${id}/calibration`, send("PUT", { pixel_size_um: pixelSizeUm })),
  measurement: (id: string, rid: string, signal?: AbortSignal) =>
    request<Measurement>(`/datasets/${id}/regions/${rid}/measurement`, { signal }),
  createNote: (id: string, body: { x: number; y: number; text: string; author: string | null; region_id?: string | null }) =>
    request<Annotation>(`/datasets/${id}/annotations`, send("POST", body)),
  patchNote: (id: string, aid: string, body: { x?: number; y?: number; text?: string }) =>
    request<Annotation>(`/datasets/${id}/annotations/${aid}`, send("PATCH", body)),
  deleteNote: (id: string, aid: string) => request<{ deleted: string }>(`/datasets/${id}/annotations/${aid}`, send("DELETE")),
  reply: (id: string, aid: string, text: string, author: string | null) =>
    request<Annotation>(`/datasets/${id}/annotations/${aid}/replies`, send("POST", { text, author })),
  profile: (id: string, line: LineQuery, signal?: AbortSignal) =>
    request<Profile>(`/datasets/${id}/profile?${lineQuery(line)}`, { signal }),
  patch: (id: string, x: number, y: number, r: number, signal?: AbortSignal) =>
    request<Patch>(`/datasets/${id}/patch?x=${x}&y=${y}&r=${r}`, { signal }),
  createCounter: (id: string, body: { name: string; color: string }) =>
    request<Counter>(`/datasets/${id}/counters`, send("POST", body)),
  patchCounter: (id: string, cid: string, body: { name?: string; color?: string }) =>
    request<Counter>(`/datasets/${id}/counters/${cid}`, send("PATCH", body)),
  deleteCounter: (id: string, cid: string) =>
    request<{ deleted: string; points_deleted: number }>(`/datasets/${id}/counters/${cid}`, send("DELETE")),
  createPoint: (id: string, body: { x: number; y: number; counter: string }) =>
    request<CountPoint>(`/datasets/${id}/points`, send("POST", body)),
  deletePoint: (id: string, pid: string) => request<{ deleted: string }>(`/datasets/${id}/points/${pid}`, send("DELETE")),
  pointsCsv: (id: string) => download(`/datasets/${id}/points.csv`, "points.csv"),
  countsCsv: (id: string) => download(`/datasets/${id}/counts.csv`, "counts.csv"),
  /** The regions CSV as the engine writes it, with the file name it suggests. */
  regionsCsv: (id: string) => download(`/datasets/${id}/measurements.csv`, "regions.csv"),
  profileCsv: (id: string, line: LineQuery) => download(`/datasets/${id}/profile.csv?${lineQuery(line)}`, "profile.csv"),
  figurePlan: (id: string, body: FigureRequest) =>
    request<ExportPlan>(`/datasets/${id}/figure`, send("POST", { ...body, plan_only: true })),
  figure: (id: string, body: FigureRequest) => download(`/datasets/${id}/figure`, "figure", send("POST", body)),
  rawPlan: (id: string, body: RawRequest) =>
    request<ExportPlan>(`/datasets/${id}/export.ome.tif`, send("POST", { ...body, plan_only: true })),
  raw: (id: string, body: RawRequest) => download(`/datasets/${id}/export.ome.tif`, "area.ome.tif", send("POST", body)),
};

export const sessions = {
  save: (id: string, body: SessionSaveRequest) =>
    request<{ path: string; bytes: number }>(`/datasets/${id}/session`, send("POST", body)),
  inspect: (path: string) => request<SessionInfo>("/sessions/inspect", send("POST", { path })),
  apply: (id: string, path: string, mode: "replace" | "merge") =>
    request<SessionApplied>(`/datasets/${id}/session/apply`, send("POST", { path, mode })),
};

interface LineQuery {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function lineQuery(l: LineQuery): string {
  return `x0=${l.x0}&y0=${l.y0}&x1=${l.x1}&y1=${l.y1}`;
}

async function download(path: string, fallback: string, init: RequestInit = {}): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(`/api/v1${path}`, { ...init, headers: { ...auth, ...init.headers } });
  if (!res.ok) {
    let detail = res.status === 409 ? "The image is still loading; try again in a moment." : res.statusText;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // keep the status text
    }
    throw new ApiError(res.status, detail);
  }
  return { blob: await res.blob(), name: attachmentName(res.headers.get("Content-Disposition"), fallback) };
}

export const api = {
  hasToken: () => token.length > 0,
  datasets: () => request<DatasetInfo[]>("/datasets"),
  dataset: (id: string) => request<DatasetInfo>(`/datasets/${id}`),
  open: (path: string) =>
    request<DatasetInfo>("/datasets", {
      method: "POST",
      body: JSON.stringify({ path }),
      headers: { "Content-Type": "application/json" },
    }),
  openChannels: (paths: string[]) =>
    request<DatasetInfo>("/datasets", {
      method: "POST",
      body: JSON.stringify({ paths }),
      headers: { "Content-Type": "application/json" },
    }),
  histogram: (id: string, c: number, bins = 256) => request<Histogram>(`/datasets/${id}/histogram/${c}?bins=${bins}`),
  pixel: (id: string, x: number, y: number, signal?: AbortSignal) =>
    request<{ values: number[] }>(`/datasets/${id}/pixel?x=${x}&y=${y}`, { signal }),
  list: (path?: string) => request<FsListing>(`/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  /** The preview saved inside a .fv session. */
  sessionThumbnail: async (path: string, signal?: AbortSignal): Promise<Blob> => {
    const res = await fetch(`/api/v1/sessions/thumbnail?path=${encodeURIComponent(path)}`, { headers: auth, signal });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.blob();
  },
  /** PNG preview of a cached scan, or of files combined as channels (in order); 404 for scans not read yet. */
  thumbnail: async (path: string | string[], size = 480, signal?: AbortSignal): Promise<Blob> => {
    const query = (Array.isArray(path) ? path : [path]).map((p) => `path=${encodeURIComponent(p)}`).join("&");
    const res = await fetch(`/api/v1/thumbnail?${query}&size=${size}`, { headers: auth, signal });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.blob();
  },
};

export type TileResult =
  | { kind: "data"; data: Uint16Array | Uint8Array; width: number; height: number; final: boolean }
  | { kind: "pending" };

export async function fetchTile(id: string, level: number, c: number, ty: number, tx: number,
  signal: AbortSignal): Promise<TileResult> {
  const res = await fetch(`/api/v1/datasets/${id}/tiles/${level}/${c}/${ty}/${tx}`, { headers: auth, signal });
  if (res.status === 202) return { kind: "pending" };
  if (!res.ok) throw new ApiError(res.status, `tile ${level}/${c}/${ty}/${tx}: ${res.status}`);
  const width = Number(res.headers.get("X-Tile-Width"));
  const height = Number(res.headers.get("X-Tile-Height"));
  const buffer = await res.arrayBuffer();
  const data = res.headers.get("X-Tile-Dtype")?.endsWith("u1") ? new Uint8Array(buffer) : new Uint16Array(buffer);
  return { kind: "data", data, width, height, final: res.headers.get("X-Tile-Final") === "1" };
}

/** Engine event stream with automatic reconnect. Returns a function that closes it. */
export function openEvents(onEvent: (e: EngineEvent) => void, onStatus: (connected: boolean) => void): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let delay = 250;
  const connect = () => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${window.location.host}/api/v1/events?token=${encodeURIComponent(token)}`);
    socket.onopen = () => {
      delay = 250;
      onStatus(true);
    };
    socket.onmessage = (msg) => onEvent(JSON.parse(msg.data) as EngineEvent);
    socket.onclose = () => {
      onStatus(false);
      if (!closed) window.setTimeout(connect, (delay = Math.min(delay * 2, 4000)));
    };
  };
  connect();
  return () => {
    closed = true;
    socket?.close();
  };
}

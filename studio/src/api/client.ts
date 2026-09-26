import type { DatasetInfo, EngineEvent, FsListing, Histogram } from "./types";

const TOKEN_KEY = "fluoroview.token";

/** The engine prints `/#token=…`; keep it for this tab only and remove it from the address bar. */
function readToken(): string {
  const match = /(?:^|[#&])token=([^&]+)/.exec(window.location.hash);
  if (match?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1]));
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
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

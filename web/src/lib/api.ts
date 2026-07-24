// Thin client for the optional FastAPI backend. Everything degrades gracefully
// to on-device demo computation when the backend is not running.

const BASE = "/api";

export async function pingBackend(timeoutMs = 1200): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${BASE}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export interface BackendInfo {
  status: string;
  version: string;
  capabilities: Record<string, boolean>;
}

export async function backendInfo(): Promise<BackendInfo | null> {
  try {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) return null;
    return (await res.json()) as BackendInfo;
  } catch {
    return null;
  }
}

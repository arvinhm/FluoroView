/**
 * One entry point for running CoSMoS, which decides *where* the work happens.
 *
 * Small regions run in a Web Worker on the client so the app needs no backend at
 * all; large ones (or reporting-grade permutation counts) go to the optional
 * FastAPI service, which uses the same vendored reference implementation. The
 * returned `engine` field tells the UI which one produced the numbers.
 */
import type { Cell } from "../types";
import { CLIENT_CELL_LIMIT, computeEnrichment, discoverNiches } from "./cosmos";
import type { ContrastResult, EnrichmentOptions, EnrichmentResult, NicheOptions, NicheResult, RefineOptions, RefineResult } from "./types";
import type { SpatialWorkerRequest, SpatialWorkerResponse } from "./cosmos.worker";

const BASE = "/api/spatial";

export type ProgressFn = (ratio: number, detail: string) => void;

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./cosmos.worker.ts", import.meta.url), { type: "module" });
    worker.onerror = () => {
      workerBroken = true;
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function runInWorker<T>(kind: "enrichment" | "niches", cells: Cell[], opts: EnrichmentOptions | NicheOptions, onProgress?: ProgressFn): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("no-worker"));
  const id = (seq += 1);
  return new Promise<T>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<SpatialWorkerResponse>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") {
        onProgress?.(msg.ratio, msg.detail);
        return;
      }
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      if (msg.type === "done") resolve(msg.result as T);
      else reject(new Error(msg.message));
    };
    const onError = (ev: ErrorEvent) => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      workerBroken = true;
      reject(new Error(ev.message || "spatial worker crashed"));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.postMessage({ id, kind, cells, opts } as SpatialWorkerRequest);
  });
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {
      /* keep the status line */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

/** Strip cells down to what the endpoints read — payloads get large fast. */
function slim(cells: Cell[]) {
  return cells.map((c) => ({ id: c.id, x: c.x, y: c.y, typeIndex: c.typeIndex, compartmentIndex: c.compartmentIndex }));
}

export type Engine = "client" | "server";

/** Where should this run? Client unless it's too big or the user asked for server. */
export function chooseEngine(nCells: number, prefer: Engine | "auto", backendOnline: boolean): Engine {
  if (prefer === "server") return "server";
  if (prefer === "client") return "client";
  return nCells > CLIENT_CELL_LIMIT && backendOnline ? "server" : "client";
}

export async function runEnrichment(
  cells: Cell[],
  opts: EnrichmentOptions,
  engine: Engine,
  onProgress?: ProgressFn
): Promise<EnrichmentResult> {
  if (engine === "server") {
    onProgress?.(0.25, "computing on the backend");
    const out = await post<EnrichmentResult>("/enrichment", { cells: slim(cells), ...opts });
    onProgress?.(1, "done");
    return out;
  }
  try {
    return await runInWorker<EnrichmentResult>("enrichment", cells, opts, onProgress);
  } catch (e) {
    // A worker-less environment still gets correct numbers, just on the main thread.
    if (workerBroken || (e instanceof Error && e.message === "no-worker")) return computeEnrichment(cells, opts, onProgress);
    throw e;
  }
}

export async function runNiches(cells: Cell[], opts: NicheOptions, engine: Engine, onProgress?: ProgressFn): Promise<NicheResult> {
  if (engine === "server") {
    onProgress?.(0.25, "computing on the backend");
    const out = await post<NicheResult>("/niches", { cells: slim(cells), ...opts });
    onProgress?.(1, "done");
    return out;
  }
  try {
    return await runInWorker<NicheResult>("niches", cells, opts, onProgress);
  } catch (e) {
    if (workerBroken || (e instanceof Error && e.message === "no-worker")) return discoverNiches(cells, opts, onProgress);
    throw e;
  }
}

/**
 * Stratified vs global null, side by side. Client-side we simply run the same
 * statistic twice; the backend has a dedicated endpoint that shares work.
 */
export async function runContrast(
  cells: Cell[],
  opts: EnrichmentOptions,
  engine: Engine,
  onProgress?: ProgressFn
): Promise<ContrastResult> {
  if (engine === "server") {
    onProgress?.(0.3, "both nulls on the backend");
    const out = await post<ContrastResult>("/contrast", { cells: slim(cells), ...opts });
    onProgress?.(1, "done");
    return out;
  }
  const aware = await runEnrichment(cells, { ...opts, compartmentAware: true }, "client", (r, d) => onProgress?.(r * 0.5, `compartment-aware null — ${d}`));
  const global = await runEnrichment(cells, { ...opts, compartmentAware: false }, "client", (r, d) => onProgress?.(0.5 + r * 0.5, `global null — ${d}`));
  return { compartmentAware: aware, global, stratified: aware.stratified };
}

/**
 * CARE annotation refinement. Only the backend implements it, so this reports a
 * clear, actionable error instead of silently faking a result.
 */
export async function runRefine(cells: Cell[], opts: RefineOptions): Promise<RefineResult> {
  return post<RefineResult>("/refine", {
    cells: slim(cells),
    numTypes: opts.numTypes,
    umPerUnit: opts.umPerUnit,
    markers: opts.markers,
    features: opts.features,
    posteriors: opts.posteriors,
    kNeighbors: opts.kNeighbors,
    radiusUm: opts.radiusUm,
    abstainCoverage: opts.abstainCoverage,
  });
}

/// <reference lib="webworker" />
/**
 * Runs CAMSE / MOSAIC off the main thread. The permutation null is O(B · edges),
 * which would freeze the UI for seconds on the main thread.
 */
import type { Cell } from "../types";
import { computeEnrichment, discoverNiches } from "./cosmos";
import type { EnrichmentOptions, NicheOptions } from "./types";

export type SpatialWorkerRequest =
  | { id: number; kind: "enrichment"; cells: Cell[]; opts: EnrichmentOptions }
  | { id: number; kind: "niches"; cells: Cell[]; opts: NicheOptions };

export type SpatialWorkerResponse =
  | { id: number; type: "progress"; ratio: number; detail: string }
  | { id: number; type: "done"; result: unknown }
  | { id: number; type: "error"; message: string };

self.onmessage = (ev: MessageEvent<SpatialWorkerRequest>) => {
  const req = ev.data;
  const post = (m: SpatialWorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
  const onProgress = (ratio: number, detail: string) => post({ id: req.id, type: "progress", ratio, detail });
  try {
    const result = req.kind === "enrichment" ? computeEnrichment(req.cells, req.opts, onProgress) : discoverNiches(req.cells, req.opts, onProgress);
    post({ id: req.id, type: "done", result });
  } catch (e) {
    post({ id: req.id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};

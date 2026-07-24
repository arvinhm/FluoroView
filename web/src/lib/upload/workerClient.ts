import type { BuildDatasetInput, BuildDatasetOutput, MaskInput, ProgressFn } from "./jobs";
import type { MaskResult } from "./types";
import type { WorkerRequest, WorkerResponse } from "./upload.worker";

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./upload.worker.ts", import.meta.url), { type: "module" });
    worker.onerror = () => {
      workerBroken = true;
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function run<T>(kind: "dataset" | "mask", input: BuildDatasetInput | MaskInput, onProgress?: ProgressFn): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("no-worker"));
  const id = (seq += 1);
  return new Promise<T>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") {
        onProgress?.(msg.progress);
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
      reject(new Error(ev.message || "upload worker crashed"));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.postMessage({ id, kind, input } as WorkerRequest);
  });
}

/**
 * Decode + pyramid (+ segment) an upload off the main thread so the UI keeps
 * animating. If a Worker can't be created (or dies), the same pure job code runs
 * inline — correct, just not as smooth — instead of failing the upload.
 */
export async function buildDatasetInWorker(input: BuildDatasetInput, onProgress?: ProgressFn): Promise<BuildDatasetOutput> {
  try {
    return await run<BuildDatasetOutput>("dataset", input, onProgress);
  } catch (e) {
    if (!workerBroken && !(e instanceof Error && e.message === "no-worker")) throw e;
    const { buildDataset } = await import("./jobs");
    return buildDataset(input, onProgress);
  }
}

export async function buildMaskInWorker(input: MaskInput, onProgress?: ProgressFn): Promise<MaskResult> {
  try {
    return await run<MaskResult>("mask", input, onProgress);
  } catch (e) {
    if (!workerBroken && !(e instanceof Error && e.message === "no-worker")) throw e;
    const { buildMask } = await import("./jobs");
    return buildMask(input, onProgress);
  }
}

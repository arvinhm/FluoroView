/// <reference lib="webworker" />
import { buildDataset, buildMask, type BuildDatasetInput, type MaskInput } from "./jobs";
import type { UploadProgress } from "./types";

export type WorkerRequest =
  | { id: number; kind: "dataset"; input: BuildDatasetInput }
  | { id: number; kind: "mask"; input: MaskInput };

export type WorkerResponse =
  | { id: number; type: "progress"; progress: UploadProgress }
  | { id: number; type: "done"; result: unknown }
  | { id: number; type: "error"; message: string };

/** Every buffer in a payload must be transferred, or a big upload is copied twice. */
function collectBuffers(value: unknown, out: ArrayBuffer[] = [], seen = new Set<unknown>()): ArrayBuffer[] {
  if (!value || typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    const buf = value.buffer;
    if (buf instanceof ArrayBuffer && !out.includes(buf)) out.push(buf);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectBuffers(v, out, seen);
    return out;
  }
  for (const v of Object.values(value as Record<string, unknown>)) collectBuffers(v, out, seen);
  return out;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const post = (msg: WorkerResponse, transfer?: ArrayBuffer[]) => {
    (self as unknown as { postMessage: (m: WorkerResponse, t?: ArrayBuffer[]) => void }).postMessage(msg, transfer);
  };
  const onProgress = (progress: UploadProgress) => post({ id: req.id, type: "progress", progress });
  try {
    const result = req.kind === "dataset" ? await buildDataset(req.input, onProgress) : await buildMask(req.input, onProgress);
    post({ id: req.id, type: "done", result }, collectBuffers(result));
  } catch (e) {
    post({ id: req.id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};

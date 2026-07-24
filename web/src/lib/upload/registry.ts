import type { DatasetDef } from "../datasets";
import type { LoadedDataset } from "../loadReal";

/**
 * Uploaded datasets live in memory for the session only.
 *
 * Dropped pixels are never written anywhere: no server, no IndexedDB, no
 * localStorage. Reloading the tab discards them (the dataset switcher says so),
 * which is also why sessions saved against an upload restore ROIs but ask for
 * the files again.
 */
const loaded = new Map<string, LoadedDataset>();
const defs = new Map<string, DatasetDef>();

export function registerUpload(def: DatasetDef, dataset: LoadedDataset): void {
  defs.set(def.id, def);
  loaded.set(def.id, dataset);
}

export function getUploadedDataset(id: string): LoadedDataset | undefined {
  return loaded.get(id);
}

export function getUploadDef(id: string): DatasetDef | undefined {
  return defs.get(id);
}

export function updateUploadedDataset(id: string, patch: Partial<LoadedDataset>): void {
  const cur = loaded.get(id);
  if (cur) loaded.set(id, { ...cur, ...patch });
}

export function releaseUpload(id: string): void {
  loaded.delete(id);
  defs.delete(id);
}

export function uploadDefs(): DatasetDef[] {
  return Array.from(defs.values());
}

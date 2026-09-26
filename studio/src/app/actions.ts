import { api, ApiError } from "../api/client";
import { useStudio } from "../state/store";

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

export async function openImage(path: string): Promise<boolean> {
  const s = useStudio.getState();
  const existing = Object.values(s.datasets).find((d) => d.path === path);
  if (existing) {
    s.setActive(existing.id);
    return true;
  }
  try {
    const ds = await api.open(path);
    s.upsertDataset(ds);
    s.setActive(ds.id);
    void loadHistograms(ds.id);
    return true;
  } catch (e) {
    s.setNotice(e instanceof Error ? e.message : String(e));
    return false;
  }
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

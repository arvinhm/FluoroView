import { api, ApiError } from "../api/client";
import type { DatasetInfo } from "../api/types";
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

async function openWith(request: () => Promise<DatasetInfo>): Promise<boolean> {
  const s = useStudio.getState();
  try {
    const ds = await request();
    s.upsertDataset(ds);
    s.setActive(ds.id);
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
    return true;
  }
  return openWith(() => api.openChannels(paths));
}

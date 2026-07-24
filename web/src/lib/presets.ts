import type { ChannelAppearance, ChannelPreset, ChannelState } from "./types";

const KEY = "fluoroview.presets.v1";

/** Extract the persistable appearance from live channel state. */
export function appearanceOf(channels: ChannelState[]): ChannelAppearance[] {
  return channels.map((c) => ({
    visible: c.visible,
    color: c.color,
    contrastLimits: [c.contrastLimits[0], c.contrastLimits[1]],
    gamma: c.gamma,
    opacity: c.opacity,
  }));
}

/** Apply a saved appearance back onto live channel state (by position). */
export function applyAppearance(channels: ChannelState[], appearance: ChannelAppearance[]): ChannelState[] {
  return channels.map((c, i) => {
    const a = appearance[i];
    if (!a) return c;
    return {
      ...c,
      visible: a.visible,
      color: a.color,
      contrastLimits: [a.contrastLimits[0], a.contrastLimits[1]],
      gamma: a.gamma,
      opacity: a.opacity,
    };
  });
}

/** User presets persisted in localStorage (offline; no backend). */
export function loadPresets(): ChannelPreset[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChannelPreset[]) : [];
  } catch {
    return [];
  }
}

export function savePresets(presets: ChannelPreset[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(presets));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

let presetSeq = 0;
export function newPresetId(): string {
  presetSeq += 1;
  return `p${Date.now().toString(36)}${presetSeq}`;
}

/** Serialize a preset to a downloadable JSON file. */
export function presetToJson(preset: ChannelPreset): string {
  return JSON.stringify(preset, null, 2);
}

/** Parse an imported preset JSON, tolerating partial/foreign shapes. */
export function presetFromJson(text: string, datasetId: string): ChannelPreset | null {
  try {
    const obj = JSON.parse(text) as Partial<ChannelPreset>;
    if (!obj || !Array.isArray(obj.channels)) return null;
    const channels: ChannelAppearance[] = obj.channels.map((a) => ({
      visible: a?.visible ?? true,
      color: a?.color ?? "#ffffff",
      contrastLimits: Array.isArray(a?.contrastLimits) ? [a!.contrastLimits[0], a!.contrastLimits[1]] : [0, 255],
      gamma: typeof a?.gamma === "number" ? a!.gamma : 1,
      opacity: typeof a?.opacity === "number" ? a!.opacity : 1,
    }));
    return {
      id: newPresetId(),
      name: obj.name || "Imported preset",
      datasetId,
      channels,
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}

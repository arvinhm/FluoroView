import type { VivPixelSource } from "../vivSource";
import type { LevelData, UploadDtype } from "./types";
import { allocPlane, type NumArray } from "./pyramid";

/**
 * Wrap decoded in-memory planes as a Viv `PixelSource[]` so uploaded images ride
 * the exact same render path as a streamed OME-TIFF pyramid: `MultiscaleImageLayer`
 * pulls only the tiles the viewport needs at the current level, and the per-channel
 * controls (contrast / color / gamma / opacity) work unchanged.
 *
 * Level 0 is the highest resolution; `shape` is [t, c, z, y, x] to match `labels`.
 */
export function createArrayLoader(
  levels: LevelData[],
  dtype: UploadDtype,
  nChannels: number,
  tileSize = 512,
  physicalSizeUm: number | null = null
): VivPixelSource[] {
  if (!levels.length) throw new Error("createArrayLoader: no levels");
  // Viv reads a trailing dimension of 3 or 4 as interleaved RGB(A), so a 3- or
  // 4-pixel-wide image would be misinterpreted.
  if (levels[0].width < 5 || levels[0].height < 5) throw new Error("Image is too small to display (minimum 5x5 pixels)");
  const physicalSizes = physicalSizeUm ? { x: { size: physicalSizeUm, unit: "µm" }, y: { size: physicalSizeUm, unit: "µm" } } : undefined;

  return levels.map((level) => {
    const planes = level.planes as unknown as NumArray[];
    const source: VivPixelSource = {
      dtype,
      shape: [1, nChannels, 1, level.height, level.width],
      labels: ["t", "c", "z", "y", "x"],
      tileSize,
      meta: { photometricInterpretation: 1, physicalSizes },
      async getRaster({ selection }) {
        const c = clampChannel(selection?.c ?? 0, nChannels);
        return { data: planes[c], width: level.width, height: level.height };
      },
      async getTile({ x, y, selection }) {
        const c = clampChannel(selection?.c ?? 0, nChannels);
        const x0 = x * tileSize;
        const y0 = y * tileSize;
        const tw = Math.min(tileSize, level.width - x0);
        const th = Math.min(tileSize, level.height - y0);
        if (tw <= 0 || th <= 0) return { data: allocPlane(dtype, 0) as unknown as ArrayLike<number>, width: 0, height: 0 };
        const src = planes[c];
        const out = allocPlane(dtype, tw * th);
        for (let row = 0; row < th; row++) {
          const s = (y0 + row) * level.width + x0;
          const d = row * tw;
          for (let col = 0; col < tw; col++) out[d + col] = src[s + col];
        }
        return { data: out as unknown as ArrayLike<number>, width: tw, height: th };
      },
      onTileError(err: Error) {
        console.error("[upload] tile error", err);
      },
    };
    return source;
  });
}

function clampChannel(c: number, n: number): number {
  if (!Number.isFinite(c) || c < 0) return 0;
  return Math.min(n - 1, Math.floor(c));
}

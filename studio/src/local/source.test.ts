import { describe, expect, it } from "vitest";
import type { ChannelInfo } from "../api/types";
import raw from "./fixtures/reference.json";
import { openSource, readRows } from "./source";

interface EngineView {
  error?: string;
  name: string;
  dtype: string;
  layout: string;
  vendor: string;
  pixel_size_um: number | null;
  saturation: number | null;
  acquisition: Record<string, string | number>;
  channels: ChannelInfo[];
  /** per channel: sum of all pixels, first pixel, last pixel */
  pixels: [number, number, number][];
}

const ref = raw as unknown as { files: Record<string, string>; engine: Record<string, EngineView> };
const H = 45;
const W = 70;

function file(name: string): File {
  return new File([Uint8Array.from(atob(ref.files[name]!), (ch) => ch.charCodeAt(0))], name);
}

/** The pattern make_fixtures.py writes: channel `c` of the pattern at (x, y). */
function value(c: number, y: number, x: number, bits: 8 | 16): number {
  return bits === 8 ? (x * 3 + y * 5 + c * 40) % 256 : (x * 7 + y * 13 + c * 1000) % 65536;
}

/** Which pattern channel each channel of a fixture holds (at the first z plane), and its bit depth. */
const PATTERNS: Record<string, { bits: 8 | 16; channels: number[] }> = {
  "biotek.tif": { bits: 16, channels: [0, 1, 2, 3] },
  "lzw.tif": { bits: 16, channels: [0] },
  "deflate-predictor.tif": { bits: 16, channels: [0, 1, 2] },
  "packbits.tif": { bits: 8, channels: [1] },
  "tiled.tif": { bits: 16, channels: [2] },
  "bigtiff.tif": { bits: 16, channels: [3] },
  "bigendian.tif": { bits: 16, channels: [1] },
  "rgb.tif": { bits: 8, channels: [0, 1, 2] },
  "ome.ome.tif": { bits: 16, channels: [0, 1, 2] },
  "imagej.tif": { bits: 16, channels: [0, 1] },
  "lzw.tif+tiled.tif+bigtiff.tif": { bits: 16, channels: [0, 2, 3] },
};

describe("the browser's TIFF reader", () => {
  for (const [key, pattern] of Object.entries(PATTERNS)) {
    it(`reads every pixel of ${key}`, async () => {
      const { spec } = await openSource(key.split("+").map(file));
      expect(spec.planes).toHaveLength(pattern.channels.length);
      for (const [c, p] of pattern.channels.entries()) {
        const want = Array.from({ length: H * W }, (_, i) => value(p, Math.floor(i / W), i % W, pattern.bits));
        expect(Array.from(await readRows(spec, c, 0, H))).toEqual(want);
        // rows that start and end inside strips and tiles
        expect(Array.from(await readRows(spec, c, 13, 31))).toEqual(want.slice(13 * W, 31 * W));
      }
    });
  }
});

describe("what the browser reports matches the engine", () => {
  for (const [key, view] of Object.entries(ref.engine)) {
    if (view.error) continue;
    it(key, async () => {
      const names = key.split("+");
      const { spec, info } = await openSource(names.map(file));
      if (names.length === 1) expect(info.name).toBe(view.name);
      expect(info.dtype).toBe(view.dtype);
      expect(info.layout).toBe(view.layout);
      expect(info.vendor).toBe(view.vendor);
      expect(info.saturation).toBe(view.saturation);
      expect(info.acquisition).toEqual(view.acquisition);
      if (view.pixel_size_um === null) expect(info.pixel_size_um).toBeNull();
      else expect(info.pixel_size_um).toBeCloseTo(view.pixel_size_um, 12);
      expect(info.channels).toEqual(view.channels);
      for (const [c, checksum] of view.pixels.entries()) {
        const rows = Array.from(await readRows(spec, c, 0, info.height));
        expect([rows.reduce((a, b) => a + b, 0), rows[0], rows.at(-1)]).toEqual(checksum);
      }
    });
  }
});

describe("files the browser version does not open", () => {
  it("names the sample type, as the engine does", async () => {
    const message = ref.engine["float.tif"]!.error!.replace(/^\w+: /, "");
    await expect(openSource([file("float.tif")])).rejects.toThrow(message);
  });

  it("combines only single-channel files of one size and type", async () => {
    await expect(openSource([file("biotek.tif"), file("lzw.tif")]))
      .rejects.toThrow("biotek.tif has 4 channels; combine single-channel files only.");
    await expect(openSource([file("lzw.tif"), file("packbits.tif")]))
      .rejects.toThrow("packbits.tif is 70 × 45 |u1, but lzw.tif is 70 × 45 <u2; files must match to be combined.");
  });

  it("opens TIFF files only", async () => {
    await expect(openSource([new File(["x"], "notes.txt")])).rejects.toThrow("FluoroView opens TIFF files");
  });
});

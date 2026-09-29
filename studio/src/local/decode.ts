/** Decompression of TIFF strips and tiles: none, LZW, Deflate and PackBits, and the horizontal predictor. */

import { TiffError } from "./tiff";

const NAMES: Record<number, string> = {
  6: "old-style JPEG", 7: "JPEG", 33003: "JPEG 2000", 33005: "JPEG 2000", 34712: "JPEG 2000", 34887: "LERC",
  34925: "LZMA", 50000: "Zstandard", 50001: "WebP", 50002: "JPEG XL",
};

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function packbits(input: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let i = 0;
  let o = 0;
  while (i < input.length && o < size) {
    const n = (input[i++]! << 24) >> 24;
    if (n >= 0) {
      const len = Math.min(n + 1, size - o);
      out.set(input.subarray(i, i + len), o);
      i += n + 1;
      o += len;
    } else if (n !== -128) {
      const len = Math.min(1 - n, size - o);
      out.fill(input[i++]!, o, o + len);
      o += len;
    }
  }
  return out;
}

/** TIFF LZW: codes of 9 to 12 bits, most significant bit first, widening one code early. */
function lzw(input: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
    length[i] = 1;
  }
  let o = 0;
  let bit = 0;
  let width = 9;
  let next = 258;
  let old = -1;
  const bits = input.length * 8;
  const emit = (code: number) => {
    const len = length[code]!;
    let p = o + len - 1;
    for (let c = code; c !== -1; c = prefix[c]!, p--) if (p < size) out[p] = suffix[c]!;
    o += len;
  };
  while (o < size && bit + width <= bits) {
    const byte = bit >> 3;
    const word = (input[byte]! << 16) | ((input[byte + 1] ?? 0) << 8) | (input[byte + 2] ?? 0);
    const code = (word >> (24 - (bit & 7) - width)) & ((1 << width) - 1);
    bit += width;
    if (code === 257) break;
    if (code === 256) {
      width = 9;
      next = 258;
      old = -1;
      continue;
    }
    if (old === -1) {
      emit(code);
      old = code;
      continue;
    }
    const known = code < next;
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = known ? first[code]! : first[old]!;
      first[next] = first[old]!;
      length[next] = length[old]! + 1;
      next++;
      if (next >= (1 << width) - 1 && width < 12) width++;
    }
    emit(known ? code : next - 1);
    old = code;
  }
  return out;
}

export async function decompress(compression: number, data: Uint8Array, size: number): Promise<Uint8Array> {
  switch (compression) {
    case 1:
      return data;
    case 5:
      return lzw(data, size);
    case 8:
    case 32946:
      return inflate(data);
    case 32773:
      return packbits(data, size);
    default:
      throw new TiffError(`${NAMES[compression] ?? `Compression ${compression}`} is not supported in the browser version yet.`);
  }
}

/** Undo horizontal differencing (predictor 2) in place, row by row. */
export function undoPredictor(samples: Uint16Array | Uint8Array, rowSamples: number, rows: number, spp: number): void {
  for (let r = 0; r < rows; r++) {
    const o = r * rowSamples;
    for (let i = spp; i < rowSamples; i++) samples[o + i] = samples[o + i]! + samples[o + i - spp]!;
  }
}

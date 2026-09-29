/**
 * Default channel colours and names, chosen exactly as the engine's io/colors.py and io/multifile.py do:
 * the emission wavelength when it is known, then common dye names, then a fixed palette.
 */

export const PALETTE = ["#3d7aff", "#2bff6b", "#ff3df2", "#ffb000", "#00e1ff", "#ff4b3e", "#ffffff", "#f0ff3c"];
export const TRANSMITTED = "#c8cbd1";
export const RGB_COLORS = ["#ff4b3e", "#2bff6b", "#3d7aff"];

const BY_NAME: [string[], number][] = [
  [["dapi", "hoechst"], 0],
  [["gfp", "fitc", "af488", "alexa488"], 1],
  [["rfp", "tritc", "cy3", "af555", "af568", "alexa555", "alexa568"], 2],
  [["cy5", "af647", "alexa647"], 3],
  [["cy7", "af750"], 4],
];
const EMISSION_LIMITS: [number, number][] = [[490, 0], [560, 1], [630, 2], [720, 3]];
const TRANSMITTED_NAMES = /bright\s*field|brightfield|phase|\bdic\b|\bbf\b|transmitted/i;
const SUFFIX = /(\.ome)?\.(tiff?|btf|tf8|qptiff)$/i;
const TRAILING_INDEX = /[\s_-]+(?:(?:channel|chan|ch|c)[\s_-]*)?\d+$/i;
const NUCLEAR = /\b(dapi|hoechst|nuclei|nucleus)\b/i;
export const GENERIC_NAME = /^Channel \d+$/;

export function isTransmittedName(name: string): boolean {
  return TRANSMITTED_NAMES.test(name);
}

export function defaultColor(index: number, name: string, emission: number | null, transmitted = false): string {
  if (transmitted) return TRANSMITTED;
  if (emission) {
    for (const [limit, slot] of EMISSION_LIMITS) if (emission < limit) return PALETTE[slot]!;
    return PALETTE[4]!;
  }
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [names, slot] of BY_NAME) if (names.some((n) => key.includes(n))) return PALETTE[slot]!;
  return PALETTE[index % PALETTE.length]!;
}

/** "Nuclei_channel_8.tif" → "Nuclei". */
export function channelNameFromFile(fileName: string): string {
  const stem = fileName.replace(SUFFIX, "");
  const name = stem.replace(TRAILING_INDEX, "") || stem;
  return name.replace(/_+/g, " ").trim() || stem;
}

/** Distinct colours: emission wavelength when known, blue for the nuclear stain, then the palette. */
export function assignColors(names: string[], emissions: (number | null)[], transmitted: boolean[]): string[] {
  const colors: (string | null)[] = names.map(() => null);
  const used = new Set<string>();
  names.forEach((name, i) => {
    if (transmitted[i]) {
      colors[i] = TRANSMITTED;
      return;
    }
    const emission = emissions[i] ?? null;
    const preferred = emission ? defaultColor(i, name, emission) : NUCLEAR.test(name) ? PALETTE[0]! : null;
    if (preferred && !used.has(preferred)) {
      colors[i] = preferred;
      used.add(preferred);
    }
  });
  const free = PALETTE.filter((c) => !used.has(c));
  return colors.map((c, i) => c ?? free.shift() ?? PALETTE[i % PALETTE.length]!);
}

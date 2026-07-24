import type { MarkerKind } from "../types";

/** Fluorophore-ish LUT palette used when a channel name gives no hint. */
export const LUT_PALETTE = [
  "#0050ff",
  "#ff00ff",
  "#00dc5a",
  "#00dcff",
  "#ffbf00",
  "#ff2d55",
  "#7c5cff",
  "#ffffff",
  "#00ffa3",
  "#ff7a00",
];

const EXT_RE = /\.(ome\.tiff?|tiff?|png|jpe?g|zarr\.zip|zarr|zip)$/i;

/**
 * Trailing channel-index noise: `_channel_8`, `-ch3`, `_16`, `_c02`.
 * A separator is required so marker names that legitimately end in a digit
 * (CD8, PD1, Ki67) survive intact.
 */
const CHANNEL_SUFFIX_RE = /[_\-. ](?:channel|chan|ch|cyc|c)?[_\-. ]?\d{1,3}$/i;

const MASK_RE = /(^|[_\-. ])(mask|masks|label|labels|labelmap|labelled|labeled|seg|segmentation|cellpose|stardist|nuclei_seg)([_\-. ]|$)/i;

export function stripExtension(filename: string): string {
  return filename.replace(/^.*[\\/]/, "").replace(EXT_RE, "");
}

/** Human channel name from a filename: `Nuclear_membrane_channel_20.tif` → `Nuclear membrane`. */
export function cleanChannelName(filename: string): string {
  let n = stripExtension(filename);
  n = n.replace(CHANNEL_SUFFIX_RE, "");
  n = n.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return "Channel";
  // Capitalise plain lowercase words but leave acronyms (ECM, DAPI, CD8) alone.
  if (n === n.toLowerCase()) n = n[0].toUpperCase() + n.slice(1);
  return n;
}

/** Does this filename look like a segmentation / label mask rather than a channel? */
export function looksLikeMask(filename: string): boolean {
  return MASK_RE.test(stripExtension(filename));
}

const COLOR_HINTS: [RegExp, string][] = [
  [/dapi|hoechst|nucle|dna|histone|h3/i, "#0050ff"],
  [/membrane|panck|cd45|e[- ]?cad|na.?k.?atpase|wga/i, "#ff00ff"],
  [/ecm|collagen|fibronectin|sma|vimentin/i, "#00dc5a"],
  [/cytoplasm|tubulin|actin|phalloidin/i, "#00dcff"],
  [/autofluor|af\b|background/i, "#ffbf00"],
  [/gfp|fitc|488/i, "#00dc5a"],
  [/rfp|cy3|tritc|555|568/i, "#ff2d55"],
  [/cy5|647|apc/i, "#ff00ff"],
  [/he\b|h&e|brightfield|eosin/i, "#ffffff"],
];

const KIND_HINTS: [RegExp, MarkerKind][] = [
  [/dapi|hoechst|nucle|dna|histone|h3|ki67|foxp3/i, "nuclear"],
  [/membrane|cd\d|panck|e[- ]?cad|wga|na.?k.?atpase/i, "membrane"],
];

export function guessChannelKind(name: string): MarkerKind {
  for (const [re, kind] of KIND_HINTS) if (re.test(name)) return kind;
  return "cyto";
}

/**
 * Assign a LUT color per channel: name hints first (DAPI → blue, membrane →
 * magenta …), then the palette for anything unmatched, never repeating a color
 * while unused ones remain. Every value stays user-editable in the panel.
 */
export function assignChannelColors(names: string[]): string[] {
  const used = new Set<string>();
  const out: (string | null)[] = names.map((name) => {
    for (const [re, color] of COLOR_HINTS) {
      if (re.test(name) && !used.has(color)) {
        used.add(color);
        return color;
      }
    }
    return null;
  });
  let p = 0;
  return out.map((color) => {
    if (color) return color;
    while (p < LUT_PALETTE.length && used.has(LUT_PALETTE[p])) p++;
    const pick = LUT_PALETTE[p % LUT_PALETTE.length];
    used.add(pick);
    p++;
    return pick;
  });
}

/** RGB(A) source split into per-channel planes gets conventional additive LUTs. */
export const RGB_CHANNEL_NAMES = ["Red", "Green", "Blue"];
export const RGB_CHANNEL_COLORS = ["#ff2d2d", "#2dff5a", "#2d7bff"];

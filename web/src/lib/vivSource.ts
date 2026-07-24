// Viv's PixelSource type isn't cleanly re-exported and the library is heavy
// (pulls deck.gl + luma.gl + geotiff). We keep it OUT of the eager bundle by
// dynamically importing it here — `loadReal` is in the store's static graph, so
// a top-level `import` would bloat the entry chunk by ~1 MB. This is a
// deliberate code-splitting boundary, not an ordinary inline import.
export type VivPixelSource = {
  dtype: string;
  shape: number[];
  labels: string[];
  tileSize?: number;
  getRaster: (sel: unknown) => Promise<{ data: ArrayLike<number>; width: number; height: number }>;
};
export type VivLoader = VivPixelSource[];

export interface LoadedVivImage {
  loader: VivLoader;
  /** number of pyramid resolution levels */
  levels: number;
}

/**
 * Load a pyramidal OME-TIFF as a Viv multiscale pixel-source array. Tiles stream
 * on demand per zoom level, so memory stays bounded regardless of file size.
 */
export async function loadVivImage(url: string): Promise<LoadedVivImage> {
  const { loadOmeTiff } = await import("@hms-dbmi/viv");
  const { data } = await loadOmeTiff(url, { images: "first" });
  return { loader: data as unknown as VivLoader, levels: data.length };
}

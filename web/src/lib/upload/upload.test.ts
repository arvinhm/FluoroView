import { describe, expect, it } from "vitest";
import { assignChannelColors, cleanChannelName, guessChannelKind, looksLikeMask } from "./names";
import { classifyFile, detectUpload } from "./detect";
import { buildLevels, downsample2x, dtypeRange, makePreview, measureDomain, planDownsample } from "./pyramid";
import { createArrayLoader } from "./arraySource";
import { analyzeLabelMask, scanLabels, simplifyRing, traceContour } from "./labelMask";
import { promoteDtype } from "./jobs";
import { pixelSizeFromDescription, physicalToUm } from "./decode";
import { pickCompositedChannels, safeContrastLimits, safeGamma } from "../channelGuards";
import type { ChannelState } from "../types";
import type { LevelData } from "./types";

const file = (name: string, bytes = 32) => new File([new Uint8Array(bytes)], name.split("/").pop() ?? name);
const raw = (path: string, bytes = 32) => ({ file: file(path, bytes), relPath: path });

describe("channel naming", () => {
  it("strips trailing channel indices but keeps marker names ending in digits", () => {
    expect(cleanChannelName("Nuclei_channel_8.tif")).toBe("Nuclei");
    expect(cleanChannelName("ECM_16.tif")).toBe("ECM");
    expect(cleanChannelName("Nuclear_membrane_channel_20.tif")).toBe("Nuclear membrane");
    expect(cleanChannelName("Membrane_channel_25.tif")).toBe("Membrane");
    expect(cleanChannelName("CD8.tif")).toBe("CD8");
    expect(cleanChannelName("Ki67.ome.tiff")).toBe("Ki67");
    expect(cleanChannelName("scan/dapi.png")).toBe("Dapi");
  });

  it("recognises mask-like filenames", () => {
    expect(looksLikeMask("BEMS340264_Scene-002_cell_mask.tif")).toBe(true);
    expect(looksLikeMask("labels.png")).toBe(true);
    expect(looksLikeMask("cellpose_seg.tif")).toBe(true);
    expect(looksLikeMask("Nuclei_channel_8.tif")).toBe(false);
  });

  it("assigns hinted LUTs without repeating a color", () => {
    const colors = assignChannelColors(["Nuclei", "Membrane", "ECM", "Cytoplasm", "Nuclear membrane", "Unknown A", "Unknown B"]);
    expect(colors[0]).toBe("#0050ff");
    expect(colors[1]).toBe("#ff00ff");
    expect(colors[2]).toBe("#00dc5a");
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("guesses marker kind", () => {
    expect(guessChannelKind("DAPI")).toBe("nuclear");
    expect(guessChannelKind("CD45")).toBe("membrane");
    expect(guessChannelKind("Collagen IV")).toBe("cyto");
  });
});

describe("format detection", () => {
  it("classifies extensions", () => {
    expect(classifyFile("a/scan.ome.tif")).toBe("ome-tiff");
    expect(classifyFile("scan.tiff")).toBe("tiff");
    expect(classifyFile("x.PNG")).toBe("png");
    expect(classifyFile("x.jpeg")).toBe("jpeg");
    expect(classifyFile("g.zarr/.zattrs")).toBe("zarr");
    expect(classifyFile("notes.txt")).toBe("unsupported");
  });

  it("merges several single-channel images and picks up the mask", () => {
    const det = detectUpload([
      raw("Nuclei_channel_8.tif"),
      raw("Membrane_channel_25.tif"),
      raw("ECM_16.tif"),
      raw("Cytoplasm_channel_18.tif"),
      raw("Nuclear_membrane_channel_20.tif"),
      raw("BEMS340264_Scene-002_cell_mask.tif"),
    ]);
    expect(det.kind).toBe("images");
    expect(det.files.map((f) => f.name)).toEqual(["Cytoplasm", "ECM", "Membrane", "Nuclear membrane", "Nuclei"]);
    expect(det.mask?.relPath).toBe("BEMS340264_Scene-002_cell_mask.tif");
    expect(new Set(det.files.map((f) => f.color)).size).toBe(5);
    // The nuclear stain keeps DAPI blue; the nuclear-membrane marker doesn't take it.
    expect(det.files.find((f) => f.name === "Nuclei")?.color).toBe("#0050ff");
    expect(det.files.find((f) => f.name === "Nuclear membrane")?.color).toBe("#ffbf00");
  });

  it("treats a lone OME-TIFF as the pyramid path", () => {
    const det = detectUpload([raw("scan.ome.tif")]);
    expect(det.kind).toBe("ome-tiff");
    expect(det.files).toHaveLength(1);
  });

  it("keeps a lone mask-named image as a mask (for the open dataset)", () => {
    const det = detectUpload([raw("labels.png")]);
    expect(det.kind).toBe("images");
    expect(det.files).toHaveLength(0);
    expect(det.mask?.relPath).toBe("labels.png");
  });

  it("detects an OME-Zarr folder and indexes members relative to the group root", () => {
    const det = detectUpload([raw("img.zarr/.zattrs"), raw("img.zarr/0/.zarray"), raw("img.zarr/0/0.0.0")]);
    expect(det.kind).toBe("ome-zarr-dir");
    expect([...(det.zarrMembers?.keys() ?? [])].sort()).toEqual(["0/.zarray", "0/0.0.0", ".zattrs"].sort());
  });

  it("explains 10x bundles instead of failing on them", () => {
    const xen = detectUpload([raw("outs/experiment.xenium"), raw("outs/morphology.ome.tif")]);
    expect(xen.kind).toBe("needs-ingest");
    expect(xen.message).toMatch(/Xenium/);
    const vis = detectUpload([raw("outs/binned_outputs/square_002um/spatial/tissue_positions.parquet")]);
    expect(vis.kind).toBe("needs-ingest");
    expect(vis.message).toMatch(/Visium HD/);
  });

  it("reports unsupported drops with a helpful message", () => {
    const det = detectUpload([raw("readme.txt"), raw("data.csv")]);
    expect(det.kind).toBe("unsupported");
    expect(det.message).toMatch(/OME-TIFF/);
  });
});

describe("pyramid building", () => {
  it("box-averages by 2 and handles odd sizes", () => {
    const src = new Uint16Array([0, 100, 4, 200, 300, 8, 12, 16, 1000]);
    const out = downsample2x(src, 3, 3, "Uint16");
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    expect(out.data[0]).toBe(Math.round((0 + 100 + 200 + 300) / 4));
  });

  it("keeps floats unrounded", () => {
    const src = new Float32Array([0, 1, 2, 3]);
    const out = downsample2x(src, 2, 2, "Float32");
    expect(out.data[0]).toBeCloseTo(1.5);
  });

  it("picks a power-of-two downsample that fits the budget", () => {
    // 10000x10000 x 2 channels x 2 bytes = 400 MB -> must shrink for a 64 MB budget.
    const f = planDownsample(10000, 10000, 2, "Uint16", 64 * 1024 * 1024);
    expect(f).toBeGreaterThan(1);
    expect(Math.log2(f) % 1).toBe(0);
    expect((10000 / f) * (10000 / f) * 2 * 2 * 1.34).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(planDownsample(512, 512, 1, "Uint8", 64 * 1024 * 1024)).toBe(1);
  });

  it("builds levels down to the tile size", () => {
    const level0: LevelData = { width: 2000, height: 1000, planes: [new Uint8Array(2000 * 1000)] };
    const levels = buildLevels(level0, "Uint8", 512);
    expect(levels[0].width).toBe(2000);
    expect(levels[levels.length - 1].width).toBeLessThanOrEqual(512);
    for (let i = 1; i < levels.length; i++) expect(levels[i].width).toBe(Math.floor(levels[i - 1].width / 2));
  });

  it("guards degenerate domains", () => {
    expect(measureDomain(new Uint8Array([7, 7, 7]), "Uint8")).toEqual([7, 8]);
    expect(measureDomain(new Float32Array([NaN, NaN]), "Float32")).toEqual(dtypeRange("Float32"));
    expect(measureDomain(new Uint16Array([10, 4000]), "Uint16")).toEqual([10, 4000]);
  });

  it("normalises 16-bit previews into each channel's domain", () => {
    const level0: LevelData = { width: 8, height: 8, planes: [new Uint16Array(64).fill(0)] };
    (level0.planes[0] as Uint16Array)[0] = 1000;
    (level0.planes[0] as Uint16Array)[1] = 500;
    const preview = makePreview([level0], "Uint16", [[0, 1000]], 2048);
    expect(preview.planes[0][0]).toBe(255);
    expect(preview.planes[0][1]).toBe(128);
    expect(preview.planes[0][2]).toBe(0);
    expect(preview.scale).toBe(1);
  });
});

describe("in-memory Viv pixel source", () => {
  const level0: LevelData = { width: 10, height: 6, planes: [new Uint16Array(60), new Uint16Array(60)] };
  for (let i = 0; i < 60; i++) {
    (level0.planes[0] as Uint16Array)[i] = i;
    (level0.planes[1] as Uint16Array)[i] = 1000 + i;
  }

  it("exposes Viv's PixelSource contract", () => {
    const loader = createArrayLoader([level0], "Uint16", 2, 4, 0.5);
    expect(loader[0].labels).toEqual(["t", "c", "z", "y", "x"]);
    expect(loader[0].shape).toEqual([1, 2, 1, 6, 10]);
    expect(loader[0].tileSize).toBe(4);
    expect(loader[0].meta?.physicalSizes?.x.size).toBe(0.5);
  });

  it("reads whole rasters per channel", async () => {
    const loader = createArrayLoader([level0], "Uint16", 2, 4);
    const a = await loader[0].getRaster({ selection: { c: 0, z: 0, t: 0 } });
    const b = await loader[0].getRaster({ selection: { c: 1, z: 0, t: 0 } });
    expect(a.width).toBe(10);
    expect(a.data[5]).toBe(5);
    expect(b.data[5]).toBe(1005);
  });

  it("clips edge tiles to their real extent", async () => {
    const loader = createArrayLoader([level0], "Uint16", 2, 4);
    const inner = await loader[0].getTile!({ x: 0, y: 0, selection: { c: 0, z: 0, t: 0 } });
    expect([inner.width, inner.height]).toEqual([4, 4]);
    expect(inner.data[0]).toBe(0);
    expect(inner.data[4]).toBe(10); // second row of the tile = row 1 of the image
    const edge = await loader[0].getTile!({ x: 2, y: 1, selection: { c: 0, z: 0, t: 0 } });
    expect([edge.width, edge.height]).toEqual([2, 2]);
    const outside = await loader[0].getTile!({ x: 9, y: 9, selection: { c: 0, z: 0, t: 0 } });
    expect(outside.width).toBe(0);
  });

  it("clamps out-of-range channel selections instead of returning undefined", async () => {
    const loader = createArrayLoader([level0], "Uint16", 2, 4);
    const r = await loader[0].getRaster({ selection: { c: 99, z: 0, t: 0 } });
    expect(r.data.length).toBe(60);
  });

  it("refuses images too small for Viv's interleaved-RGB heuristic", () => {
    expect(() => createArrayLoader([{ width: 3, height: 3, planes: [new Uint8Array(9)] }], "Uint8", 1)).toThrow(/too small/i);
  });
});

describe("label mask → cells and outlines", () => {
  // 6x5 mask: label 1 is a 2x2 block, label 2 a single pixel.
  const w = 6;
  const h = 5;
  const labels = new Uint16Array(w * h);
  labels[1 * w + 1] = 1;
  labels[1 * w + 2] = 1;
  labels[2 * w + 1] = 1;
  labels[2 * w + 2] = 1;
  labels[4 * w + 5] = 2;

  it("scans areas, centroids and a tracing seed", () => {
    const scan = scanLabels(labels, w, h);
    expect(scan.ids).toEqual([1, 2]);
    expect(scan.count[1]).toBe(4);
    expect(scan.sumX[1] / 4).toBeCloseTo(1.5);
    expect(scan.sumY[1] / 4).toBeCloseTo(1.5);
    expect(scan.firstIdx[1]).toBe(1 * w + 1);
  });

  it("traces the exact pixel-edge outline of a block", () => {
    const ring = traceContour(labels, w, h, 1, 1 * w + 1);
    expect(ring[0]).toEqual([1, 1]);
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(1);
    expect(Math.max(...xs)).toBe(3);
    expect(Math.min(...ys)).toBe(1);
    expect(Math.max(...ys)).toBe(3);
    // 2x2 block has a 8-crack perimeter.
    expect(ring).toHaveLength(8);
  });

  it("traces a single pixel as its unit square", () => {
    const ring = traceContour(labels, w, h, 2, 4 * w + 5);
    expect(ring).toEqual([
      [5, 4],
      [6, 4],
      [6, 5],
      [5, 5],
    ]);
  });

  it("keeps corners when simplifying a ring", () => {
    const square: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [1, 2],
      [0, 2],
      [0, 1],
    ];
    const simple = simplifyRing(square, 0.75);
    expect(simple.length).toBeLessThanOrEqual(5);
    expect(simple).toContainEqual([0, 0]);
    expect(simple).toContainEqual([2, 2]);
  });

  it("derives per-cell records, scaled outlines and normalised means", () => {
    const intensity = { planes: [new Uint16Array(w * h)], width: w, height: h, domains: [[0, 100] as [number, number]] };
    intensity.planes[0].fill(0);
    // label 1 pixels = 50 → normalised 0.5; label 2 pixel = 100 → 1.
    intensity.planes[0][1 * w + 1] = 50;
    intensity.planes[0][1 * w + 2] = 50;
    intensity.planes[0][2 * w + 1] = 50;
    intensity.planes[0][2 * w + 2] = 50;
    intensity.planes[0][4 * w + 5] = 100;
    const res = analyzeLabelMask(labels, w, h, { scaleX: 2, scaleY: 2, intensity });
    expect(res.labelCount).toBe(2);
    expect(res.cells[0].x).toBeCloseTo(4); // (1.5 + 0.5) * 2
    expect(res.cells[0].area).toBe(16); // 4 px * 2 * 2
    expect(res.cells[0].markers[0]).toBeCloseTo(0.5);
    expect(res.cells[1].markers[0]).toBeCloseTo(1);
    expect(res.rings[0][0]).toBe(2); // outline scaled into world pixels
    expect(res.rings[0].length).toBeGreaterThanOrEqual(6);
  });

  it("rejects an image with no labels", () => {
    expect(() => analyzeLabelMask(new Uint8Array(16), 4, 4, {})).toThrow(/segmentation mask/i);
  });
});

describe("dtype promotion", () => {
  it("widens without rescaling and escapes to float on mixed signs", () => {
    expect(promoteDtype("Uint8", "Uint16")).toBe("Uint16");
    expect(promoteDtype("Uint16", "Uint16")).toBe("Uint16");
    expect(promoteDtype("Uint8", "Float32")).toBe("Float32");
    expect(promoteDtype("Int16", "Uint16")).toBe("Float32");
  });
});

describe("pixel size metadata", () => {
  it("reads OME PhysicalSizeX with its unit", () => {
    expect(pixelSizeFromDescription('<OME><Image><Pixels PhysicalSizeX="0.325" PhysicalSizeXUnit="µm"/></Image></OME>')).toBeCloseTo(0.325);
    expect(pixelSizeFromDescription('<OME><Pixels PhysicalSizeX="325" PhysicalSizeXUnit="nm"/></OME>')).toBeCloseTo(0.325);
  });

  it("reads ImageJ micron spacing", () => {
    expect(pixelSizeFromDescription("ImageJ=1.54f\nunit=micron\n", 2)).toBeCloseTo(0.5);
  });

  it("stays null when nothing states a physical size", () => {
    expect(pixelSizeFromDescription(undefined)).toBeNull();
    expect(pixelSizeFromDescription('<OME><Pixels PhysicalSizeX="1" PhysicalSizeXUnit="pixel"/></OME>')).toBeNull();
    // 72/96 dpi are defaulted tags, not microscope calibrations.
    expect(pixelSizeFromDescription(undefined, 72, 2)).toBeNull();
    expect(pixelSizeFromDescription(undefined, 96, 2)).toBeNull();
    expect(pixelSizeFromDescription(undefined, 0.0001, 2)).toBeNull();
    expect(physicalToUm(1, "reference frame")).toBeNull();
    // A genuine 0.5 µm/px calibration stored as cm resolution is believed.
    expect(pixelSizeFromDescription(undefined, 20000, 3)).toBeCloseTo(0.5);
  });
});

describe("render guards (black-canvas regressions)", () => {
  const ch = (patch: Partial<ChannelState>): ChannelState => ({
    index: 0,
    visible: true,
    gain: 1,
    gamma: 1,
    color: "#ffffff",
    contrastLimits: [0, 255],
    domain: [0, 255],
    opacity: 1,
    ...patch,
  });

  it("repairs non-finite and collapsed contrast windows", () => {
    expect(safeContrastLimits(ch({ contrastLimits: [NaN, 255] }))).toEqual([0, 255]);
    expect(safeContrastLimits(ch({ contrastLimits: [10, 10] }))[1]).toBeGreaterThan(10);
    expect(safeContrastLimits(ch({ contrastLimits: [500, 10] }))[1]).toBeGreaterThan(500);
    const [lo, hi] = safeContrastLimits(ch({ contrastLimits: [NaN, NaN], domain: [NaN, NaN] }));
    expect(Number.isFinite(lo)).toBe(true);
    expect(hi).toBeGreaterThan(lo);
  });

  it("never yields gamma 0 (pow(0,0) is NaN on the GPU)", () => {
    expect(safeGamma(0)).toBe(1);
    expect(safeGamma(NaN)).toBe(1);
    expect(safeGamma(-2)).toBe(1);
    expect(safeGamma(0.4)).toBe(0.4);
  });

  it("sends every channel up to the GPU limit, then the visible ones", () => {
    const five = Array.from({ length: 5 }, (_, i) => ch({ index: i, visible: i < 2 }));
    expect(pickCompositedChannels(five)).toEqual([0, 1, 2, 3, 4]);
    const twelve = Array.from({ length: 12 }, (_, i) => ch({ index: i, visible: i >= 2 }));
    expect(pickCompositedChannels(twelve)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const noneVisible = Array.from({ length: 12 }, (_, i) => ch({ index: i, visible: false }));
    expect(pickCompositedChannels(noneVisible)).toEqual([0]);
    expect(pickCompositedChannels([])).toEqual([]);
  });
});

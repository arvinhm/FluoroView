import JSZip from "jszip";
import type { ChannelDef, ChannelState, Roi } from "./types";
import type { ChannelMaps } from "./synth";
import type { Cell } from "./types";
import { roiBounds, pointInShape, cellsInRoi, channelStats, shapeArea, shapeKindLabel } from "./roi";
import { hexToRgb } from "./palette";
import { niceNumber } from "./format";

function slug(s: string): string {
  return s.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "roi";
}

function canvasToBlob(cv: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}

interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Bbox is expressed in WORLD (image) pixel coords. maps.scale = arrayPx per
// worldPx, so the intensity arrays may be a bounded lower resolution than the
// world coordinate space (the real scan's world is the native pyramid size).
function clampedBbox(shape: Roi["shape"], maps: ChannelMaps): Bbox {
  const s = maps.scale || 1;
  const worldW = maps.width / s;
  const worldH = maps.height / s;
  const b = roiBounds(shape);
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const x2 = Math.min(worldW, Math.ceil(b.x + b.w));
  const y2 = Math.min(worldH, Math.ceil(b.y + b.h));
  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

/** Replicate the WebGL compositor's additive LUT blend + tone-map on the CPU,
 *  cropped to the ROI bbox and masked to the ROI shape (outside = transparent).
 *  Output is rendered at the intensity arrays' resolution (bounded), so a big
 *  full-res ROI never allocates a giant canvas. */
function renderBlend(
  maps: ChannelMaps,
  defs: ChannelDef[],
  channels: ChannelState[],
  include: number[],
  shape: Roi["shape"],
  bbox: Bbox
): HTMLCanvasElement {
  const s = maps.scale || 1;
  const aw = maps.width;
  const ah = maps.height;
  const cw = Math.max(1, Math.round(bbox.w * s));
  const cimgH = Math.max(1, Math.round(bbox.h * s));
  const ax0 = bbox.x * s;
  const ay0 = bbox.y * s;
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = cimgH;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(cw, cimgH);
  const cols = include.map((i) => {
    const [r, g, b] = hexToRgb(channels[i]?.color ?? defs[i].color);
    return [r / 255, g / 255, b / 255] as [number, number, number];
  });
  // Per-channel contrast window (normalized to 0..1) matching the live shader.
  const win = include.map((i) => {
    const ch = channels[i];
    const [dlo, dhi] = ch?.domain ?? [0, 255];
    const range = Math.max(1, dhi - dlo);
    const lo = ((ch?.contrastLimits?.[0] ?? dlo) - dlo) / range;
    const hi = ((ch?.contrastLimits?.[1] ?? dhi) - dlo) / range;
    return { lo, hi: Math.max(lo + 1e-4, hi), gamma: ch?.gamma ?? 1, opacity: ch?.opacity ?? 1 };
  });
  for (let py = 0; py < cimgH; py++) {
    for (let px = 0; px < cw; px++) {
      const ax = ax0 + px;
      const ay = ay0 + py;
      const o = (py * cw + px) * 4;
      if (!pointInShape(shape, (ax + 0.5) / s, (ay + 0.5) / s)) {
        img.data[o + 3] = 0;
        continue;
      }
      const mx = Math.min(aw - 1, Math.max(0, Math.round(ax)));
      const my = Math.min(ah - 1, Math.max(0, Math.round(ay)));
      const at = my * aw + mx;
      let R = 0;
      let G = 0;
      let B = 0;
      for (let c = 0; c < include.length; c++) {
        const i = include[c];
        const inten = maps.maps[i][at] / 255;
        const w = win[c];
        let t = Math.min(1, Math.max(0, (inten - w.lo) / (w.hi - w.lo)));
        t = Math.pow(t, 1 / Math.max(0.02, w.gamma)) * w.opacity;
        R += cols[c][0] * t;
        G += cols[c][1] * t;
        B += cols[c][2] * t;
      }
      // Reinhard-ish tone map matching the shader.
      R = Math.pow(R / (R + 0.82), 0.86);
      G = Math.pow(G / (G + 0.82), 0.86);
      B = Math.pow(B / (B + 0.82), 0.86);
      img.data[o] = Math.min(255, R * 255);
      img.data[o + 1] = Math.min(255, G * 255);
      img.data[o + 2] = Math.min(255, B * 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** Burn a scale bar (µm when pixel size known, else px) into the bottom-right. */
function burnScaleBar(cv: HTMLCanvasElement, pixelSizeUm: number | null) {
  const ctx = cv.getContext("2d")!;
  const targetPx = Math.min(cv.width * 0.35, 140);
  let barPx: number;
  let label: string;
  if (pixelSizeUm && pixelSizeUm > 0) {
    const um = niceNumber(targetPx * pixelSizeUm);
    barPx = um / pixelSizeUm;
    label = um >= 1000 ? `${um / 1000} mm` : `${um} µm`;
  } else {
    const px = niceNumber(targetPx);
    barPx = px;
    label = `${px.toLocaleString()} px`;
  }
  if (barPx < 10 || barPx > cv.width - 8) return;
  const x = cv.width - barPx - 10;
  const y = cv.height - 14;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + barPx, y);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "600 11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(label, x + barPx / 2, y - 5);
}

/** Per-channel mean±SEM bar chart rendered to a canvas for export. */
export function drawBarChartCanvas(
  defs: ChannelDef[],
  cells: Cell[],
  title: string
): HTMLCanvasElement {
  const stats = defs.map((_, i) => channelStats(cells, i));
  const maxMean = Math.max(0.15, ...stats.map((s) => s.mean + s.sem));
  const rowH = 26;
  const padL = 150;
  const padR = 70;
  const top = 44;
  const W = 640;
  const H = top + defs.length * rowH + 20;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#0b0f1c";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#e7ecf5";
  ctx.font = "700 15px sans-serif";
  ctx.fillText(title, 16, 26);
  const barW = W - padL - padR;
  defs.forEach((d, i) => {
    const s = stats[i];
    const y = top + i * rowH;
    ctx.fillStyle = "#94a3b8";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(d.name.slice(0, 18), padL - 10, y + 15);
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(padL, y + 6, barW, 12);
    ctx.fillStyle = d.color;
    ctx.fillRect(padL, y + 6, (s.mean / maxMean) * barW, 12);
    // SEM whisker
    const lo = padL + (Math.max(0, s.mean - s.sem) / maxMean) * barW;
    const hi = padL + (Math.min(maxMean, s.mean + s.sem) / maxMean) * barW;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(lo, y + 12);
    ctx.lineTo(hi, y + 12);
    ctx.stroke();
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "600 11px sans-serif";
    ctx.fillText(s.mean.toFixed(3), padL + barW + 8, y + 15);
  });
  return cv;
}

function statsCsv(roi: Roi, cells: Cell[], defs: ChannelDef[], pixelSizeUm: number | null): string {
  const areaPx = shapeArea(roi.shape);
  const lines: string[] = [];
  lines.push(`# FluoroView ROI export`);
  lines.push(`# ROI: ${roi.label}`);
  lines.push(`# Shape: ${shapeKindLabel(roi.shape)}`);
  lines.push(`# Cells: ${cells.length}`);
  lines.push(`# Area_px2: ${Math.round(areaPx)}`);
  if (pixelSizeUm && pixelSizeUm > 0) lines.push(`# Area_um2: ${(areaPx * pixelSizeUm * pixelSizeUm).toFixed(2)}`);
  lines.push(`# Note: intensities are per-channel values in [0,1] sampled at cell centroids.`);
  lines.push("channel,mean,median,sd,sem,min,max,n");
  defs.forEach((d, i) => {
    const s = channelStats(cells, i);
    lines.push([d.name, s.mean, s.median, s.sd, s.sem, s.min, s.max, s.n].map((v) => (typeof v === "number" ? v.toFixed(6).replace(/\.?0+$/, "") : v)).join(","));
  });
  return lines.join("\n");
}

export interface RoiExportContext {
  maps: ChannelMaps;
  defs: ChannelDef[];
  channels: ChannelState[];
  cells: Cell[];
  pixelSizeUm: number | null;
  datasetLabel: string;
}

async function addRoiToZip(zip: JSZip, roi: Roi, ctx: RoiExportContext) {
  const folder = zip.folder(slug(roi.label))!;
  const bbox = clampedBbox(roi.shape, ctx.maps);
  const roiCells = cellsInRoi(ctx.cells, roi.shape);

  // Merged composite of the currently-visible channels.
  const visible = ctx.channels.filter((c) => c.visible).map((c) => c.index);
  const comp = renderBlend(ctx.maps, ctx.defs, ctx.channels, visible.length ? visible : ctx.defs.map((_, i) => i), roi.shape, bbox);
  burnScaleBar(comp, ctx.pixelSizeUm);
  folder.file("composite.png", await canvasToBlob(comp));

  // Per-channel masked images.
  const ch = folder.folder("channels")!;
  for (let i = 0; i < ctx.defs.length; i++) {
    const cv = renderBlend(ctx.maps, ctx.defs, ctx.channels, [i], roi.shape, bbox);
    burnScaleBar(cv, ctx.pixelSizeUm);
    ch.file(`${slug(ctx.defs[i].name)}.png`, await canvasToBlob(cv));
  }

  // Analysis bar chart + stats + metadata.
  folder.file("analysis.png", await canvasToBlob(drawBarChartCanvas(ctx.defs, roiCells, `${roi.label} — mean ± SEM`)));
  folder.file("stats.csv", statsCsv(roi, roiCells, ctx.defs, ctx.pixelSizeUm));
  folder.file(
    "roi.json",
    JSON.stringify(
      {
        label: roi.label,
        dataset: ctx.datasetLabel,
        shape: roi.shape,
        kind: shapeKindLabel(roi.shape),
        cells: roiCells.length,
        area_px2: Math.round(shapeArea(roi.shape)),
        pixel_size_um: ctx.pixelSizeUm,
        comments: roi.comments,
        exported_at: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportRoisZip(rois: Roi[], ctx: RoiExportContext, filename = "fluoroview-rois.zip") {
  const zip = new JSZip();
  for (const roi of rois) await addRoiToZip(zip, roi, ctx);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  downloadBlob(blob, filename);
}

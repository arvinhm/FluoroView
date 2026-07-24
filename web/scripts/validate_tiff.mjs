import { fromArrayBuffer } from "geotiff";
import { readFile } from "node:fs/promises";

const path = process.argv[2] || "public/data/multiplex/scan.ome.tif";
const buf = await readFile(path);
const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const n = await tiff.getImageCount();
console.log("top-level image count =", n);
const img0 = await tiff.getImage(0);
const fd = img0.fileDirectory;
console.log("img0: WxH =", img0.getWidth() + "x" + img0.getHeight(),
  "tile =", fd.TileWidth + "x" + fd.TileLength,
  "SamplesPerPixel =", fd.SamplesPerPixel,
  "BitsPerSample =", JSON.stringify(fd.BitsPerSample),
  "Compression =", fd.Compression,
  "Photometric =", fd.PhotometricInterpretation);
console.log("SubIFDs on img0 =", Array.isArray(fd.SubIFDs) ? fd.SubIFDs.length : fd.SubIFDs);
const desc = (fd.ImageDescription || "").slice(0, 400);
console.log("ImageDescription (head):\n", desc);

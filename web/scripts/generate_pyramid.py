#!/usr/bin/env python3
"""
FluoroView v3.2 — build the REAL multiplex scan's viewer assets from the
FULL-RESOLUTION source files (NOT the 8x-downsampled proxies in example_data/).

It emits, into web/public/data/multiplex/ :

  scan.ome.tif        pyramidal, tiled, 5-channel OME-TIFF (8-bit) for Viv
                      -> zoom streams tiles per LOD, revealing real detail.
  boundaries.bin      packed per-cell VECTOR contour polygons (full-res mask)
                      -> razor-sharp outlines at any zoom (no raster upscaling).
  boundaries.meta.json  { width, height, count, bytesPerCoord, ... }
  cells.json          full-res cell centroids + area + per-channel mean intensity
  scan.meta.json      image size, #levels, per-channel color + contrast defaults

The full-res originals live OUTSIDE this repo (they are ~95 MB each). Point the
script at them with --src or $FLUOROVIEW_SRC; it also probes a few known paths.

    python web/scripts/generate_pyramid.py --src /path/to/example [--bits 8|16]

Regenerate at 16-bit for maximum intensity fidelity (bigger file) with --bits 16.
Everything is deterministic; re-running overwrites the committed assets.
"""
from __future__ import annotations
import argparse, json, os, struct, sys, time
import numpy as np

# --- channel panel: order + display color MUST match web/src/lib/datasets.ts ---
CHANNELS = [
    ("Nuclei",           "Nuclei_channel_8.tif",           "#0050ff"),
    ("Membrane",         "Membrane_channel_25.tif",        "#ff00ff"),
    ("ECM",              "ECM_16.tif",                     "#00dc5a"),
    ("Cytoplasm",        "Cytoplasm_channel_18.tif",       "#00dcff"),
    ("Nuclear membrane", "Nuclear_membrane_channel_20.tif","#ffbf00"),
]
MASK_NAMES = ["BEMS340264_Scene-002_cell_mask.ome.tiff",
              "BEMS340264_Scene-002_cell_mask.tif"]

PROBE_DIRS = [
    os.environ.get("FLUOROVIEW_SRC", ""),
    "/Users/Arvin/Documents/GitHub/FluoroView/example",
    "/Users/Arvin/Downloads/Grants/Fluroview/example",
]


def find_src(cli_src: str | None) -> str:
    cands = ([cli_src] if cli_src else []) + PROBE_DIRS
    for d in cands:
        if d and os.path.isfile(os.path.join(d, CHANNELS[0][1])):
            return d
    sys.exit("ERROR: could not locate full-res source dir. Pass --src /path/to/example "
             "(must contain %s and the cell_mask)." % CHANNELS[0][1])


def to_uint8(a: np.ndarray, lo: float, hi: float) -> np.ndarray:
    if hi <= lo:
        hi = lo + 1.0
    out = (a.astype(np.float32) - lo) / (hi - lo)
    return np.clip(out * 255.0, 0, 255).astype(np.uint8)


def build_levels(base: np.ndarray, min_side: int = 512):
    """base: (C, Y, X). Return list of (C,Y,X) arrays halving each step (INTER_AREA)."""
    import cv2
    levels = [base]
    cur = base
    while max(cur.shape[1], cur.shape[2]) > min_side:
        c, h, w = cur.shape
        nh, nw = max(1, h // 2), max(1, w // 2)
        nxt = np.empty((c, nh, nw), dtype=cur.dtype)
        for ci in range(c):
            nxt[ci] = cv2.resize(cur[ci], (nw, nh), interpolation=cv2.INTER_AREA)
        levels.append(nxt)
        cur = nxt
    return levels


def write_ome_tiff(path: str, levels, names, bits: int):
    import tifffile
    dtype_ok = levels[0].dtype
    opts = dict(photometric="minisblack", tile=(512, 512),
                compression="adobe_deflate", predictor=True)
    # bioformats2raw-style pyramid: base holds N-1 SubIFDs, each subsequent
    # write (subfiletype=1) is the next reduced-resolution level. Viv reads it.
    with tifffile.TiffWriter(path, ome=True, bigtiff=False) as tif:
        tif.write(levels[0], subifds=len(levels) - 1,
                  metadata={"axes": "CYX", "Channel": {"Name": names}}, **opts)
        for lvl in levels[1:]:
            tif.write(lvl, subfiletype=1, **opts)
    return dtype_ok


def extract_boundaries(mask: np.ndarray, eps: float = 0.75):
    """Return (records, count). records: list of (id, np.int-array Nx2 [x,y] full-res px)."""
    import cv2
    from scipy import ndimage as ndi
    objs = ndi.find_objects(mask)
    recs = []
    for i, sl in enumerate(objs):
        if sl is None:
            continue
        lab = i + 1
        y0, x0 = sl[0].start, sl[1].start
        sub = (mask[sl] == lab).astype(np.uint8)
        # pad 1px so cells touching the bbox edge still close
        sub = np.pad(sub, 1)
        cs, _ = cv2.findContours(sub, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cs:
            continue
        cnt = max(cs, key=cv2.contourArea)
        if len(cnt) >= 4:
            cnt = cv2.approxPolyDP(cnt, eps, True)
        pts = cnt.reshape(-1, 2).astype(np.float64)
        # undo pad, offset to full-res, center on pixel (+0.5)
        pts[:, 0] += (x0 - 1 + 0.5)
        pts[:, 1] += (y0 - 1 + 0.5)
        if len(pts) < 3:
            continue
        recs.append((lab, np.clip(np.round(pts), 0, 65535).astype(np.uint16)))
    return recs


def pack_boundaries(recs, path: str):
    """Compact binary: [u32 count] then per cell [u32 id][u16 npts][npts*(u16 x,u16 y)]."""
    with open(path, "wb") as f:
        f.write(struct.pack("<I", len(recs)))
        for lab, pts in recs:
            f.write(struct.pack("<IH", lab, len(pts)))
            f.write(pts.astype("<u2").tobytes())
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=None, help="dir with full-res channel TIFFs + mask")
    ap.add_argument("--out", default=None, help="output data dir (default web/public/data/multiplex)")
    ap.add_argument("--bits", type=int, default=8, choices=(8, 16), help="OME-TIFF bit depth")
    ap.add_argument("--eps", type=float, default=0.75, help="contour simplify tolerance (px)")
    args = ap.parse_args()

    import tifffile, cv2  # noqa: F401  (fail early if missing)

    src = find_src(args.src)
    here = os.path.dirname(os.path.abspath(__file__))
    out = args.out or os.path.normpath(os.path.join(here, "..", "public", "data", "multiplex"))
    os.makedirs(out, exist_ok=True)
    print(f"SRC = {src}\nOUT = {out}\nbits = {args.bits}")

    # ---- 1. channels -> 8/16-bit stack + per-channel contrast defaults ----
    names = [c[0] for c in CHANNELS]
    colors = [c[2] for c in CHANNELS]
    stack = None
    chan_meta = []
    t0 = time.time()
    for idx, (name, fname, color) in enumerate(CHANNELS):
        fp = os.path.join(src, fname)
        if not os.path.isfile(fp):
            sys.exit(f"ERROR: missing channel file {fp}")
        a = tifffile.imread(fp)
        if a.ndim != 2:
            a = np.asarray(a).reshape(a.shape[-2], a.shape[-1])
        if stack is None:
            H, W = a.shape
            stack = np.empty((len(CHANNELS), H, W),
                             dtype=(np.uint8 if args.bits == 8 else np.uint16))
        lo, hi = np.percentile(a, [1.0, 99.8])
        if args.bits == 8:
            stack[idx] = to_uint8(a, lo, hi)
            # good default window in 8-bit space (brighten sparse signal a touch)
            hi8 = float(np.percentile(stack[idx][stack[idx] > 0], 99.0)) if (stack[idx] > 0).any() else 255.0
            chan_meta.append({"name": name, "color": color,
                              "domain": [0, 255],
                              "contrastLimits": [0, max(24.0, min(255.0, hi8))]})
        else:
            stack[idx] = np.clip(a, 0, 65535).astype(np.uint16)
            chan_meta.append({"name": name, "color": color,
                              "domain": [0, 65535],
                              "contrastLimits": [float(lo), float(hi)]})
        print(f"  ch{idx} {name:18s} p1/p99.8=({lo:.0f},{hi:.0f})")
    print(f"channels loaded in {time.time()-t0:.1f}s  size={W}x{H}")

    # ---- 2. pyramid + OME-TIFF ----
    t0 = time.time()
    levels = build_levels(stack, min_side=512)
    print(f"pyramid: {len(levels)} levels -> " + ", ".join(f"{l.shape[2]}x{l.shape[1]}" for l in levels))
    ome_path = os.path.join(out, "scan.ome.tif")
    write_ome_tiff(ome_path, levels, names, args.bits)
    print(f"wrote {ome_path}  ({os.path.getsize(ome_path)/1e6:.1f} MB) in {time.time()-t0:.1f}s")

    # ---- 2b. small per-channel preview PNGs (8-bit) for ROI-crop export/maps ----
    # (Viv renders the real image; these bounded arrays back the CPU ROI compositor
    #  and keep memory tiny — full-res per-channel arrays would be ~240 MB.)
    from PIL import Image
    prev = next((lv for lv in levels if max(lv.shape[1], lv.shape[2]) <= 2200), levels[-1])
    pv_stack = prev if prev.dtype == np.uint8 else (prev >> 8).astype(np.uint8)
    pW, pH = pv_stack.shape[2], pv_stack.shape[1]
    slug = lambda n: n.lower().replace(" ", "_")
    for ci, (name, _f, _c) in enumerate(CHANNELS):
        Image.fromarray(pv_stack[ci]).save(os.path.join(out, f"{slug(name)}.png"))
    print(f"preview PNGs: {pW}x{pH} (scale {pW / W:.4f})")

    # ---- 3. mask -> vector boundaries + cells ----
    mp = next((os.path.join(src, m) for m in MASK_NAMES if os.path.isfile(os.path.join(src, m))), None)
    if not mp:
        sys.exit("ERROR: cell mask not found in src")
    mask = tifffile.imread(mp)
    if mask.ndim != 2:
        mask = np.asarray(mask).reshape(mask.shape[-2], mask.shape[-1])
    assert mask.shape == (H, W), f"mask {mask.shape} != image {(H, W)}"

    t0 = time.time()
    recs = extract_boundaries(mask, eps=args.eps)
    bpath = os.path.join(out, "boundaries.bin")
    bsize = pack_boundaries(recs, bpath)
    print(f"boundaries: {len(recs)} cells, {bsize/1e6:.2f} MB in {time.time()-t0:.1f}s")
    with open(os.path.join(out, "boundaries.meta.json"), "w") as f:
        json.dump({"width": W, "height": H, "count": len(recs),
                   "format": "u32 count; per cell: u32 id, u16 npts, npts*(u16 x,u16 y)"}, f)

    # ---- 4. cells.json (full-res centroid + area + per-channel mean intensity) ----
    from scipy import ndimage as ndi
    t0 = time.time()
    lab_ids = np.arange(1, int(mask.max()) + 1)
    ones = np.ones_like(mask, dtype=np.float32)
    areas = ndi.sum(ones, mask, lab_ids)
    centroids = ndi.center_of_mass(ones, mask, lab_ids)
    # per-channel mean over each label (use 8-bit stack normalized 0..1)
    means = []
    for ci in range(len(CHANNELS)):
        img = stack[ci].astype(np.float32)
        m = ndi.mean(img, mask, lab_ids)
        means.append(m)
    cells = []
    for k, lab in enumerate(lab_ids):
        a = float(areas[k])
        if a <= 0:
            continue
        cy, cx = centroids[k]
        markers = [round(float(means[ci][k]) / (255.0 if args.bits == 8 else 65535.0), 4)
                   for ci in range(len(CHANNELS))]
        cells.append({"id": int(lab), "x": round(float(cx), 1), "y": round(float(cy), 1),
                      "area": int(a), "markers": markers})
    with open(os.path.join(out, "cells.json"), "w") as f:
        json.dump(cells, f)
    print(f"cells.json: {len(cells)} cells in {time.time()-t0:.1f}s")

    # ---- 5. scan.meta.json ----
    meta = {
        "width": W, "height": H, "levels": len(levels), "bits": args.bits,
        "tile": 512, "pixelSizeUm": None, "channels": chan_meta,
        "previewWidth": pW, "previewHeight": pH, "previewScale": round(pW / W, 6),
        "image": "scan.ome.tif", "boundaries": "boundaries.bin",
        "source": os.path.basename(src),
    }
    with open(os.path.join(out, "scan.meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("wrote scan.meta.json")
    print("DONE.")


if __name__ == "__main__":
    main()

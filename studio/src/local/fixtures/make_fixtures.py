"""Writes reference.json for the in-browser engine's tests: small TIFF files and what the engine makes of them.

Run with the engine's environment:  uv run --project ../../../../engine python make_fixtures.py
The TIFFs are stored in the JSON (base64), so the tests need no file access. Pixels follow
value(c, y, x) so every decoded pixel can be checked; names, colours, pixel sizes, zoom levels and
histograms come from the engine itself, so the browser code is held to the engine's results.
"""

import base64
import json
import tempfile
from pathlib import Path

import numpy as np
import tifffile

from fluoroview.datasets import histogram_summary
from fluoroview.io import MultiFileSource, TiffSource
from fluoroview.pyramid.builder import band_rows_for
from fluoroview.pyramid.kernels import downsample2
from fluoroview.pyramid.store import TILE, plan_levels

HERE = Path(__file__).parent
H, W = 45, 70
COMBINED = ["lzw.tif", "tiled.tif", "bigtiff.tif"]

BIOTEK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<BTIImageMetaData Version="29">
  <System><Gen5><Version>3.09.07</Version></Gen5>
    <Camera><Model>Grasshopper3</Model><SaturationLevel>65520</SaturationLevel></Camera></System>
  <ImageReference><Date>02/19/26</Date><Well>B1</Well></ImageReference>
  <ImageAcquisition>
    <PixelWidth>{w}</PixelWidth><PixelHeight>{h}</PixelHeight>
    <ImageWidthMicrons>{wum}</ImageWidthMicrons><ImageHeightMicrons>{hum}</ImageHeightMicrons>
    <Channel Color="Stitched[{name} {ex},{em}]"><BrightField>FALSE</BrightField></Channel>
  </ImageAcquisition>
</BTIImageMetaData>"""


def plane(c: int, dtype=np.uint16, h: int = H, w: int = W) -> np.ndarray:
    y, x = np.mgrid[0:h, 0:w]
    if dtype == np.uint8:
        return ((x * 3 + y * 5 + c * 40) % 256).astype(np.uint8)
    return ((x * 7 + y * 13 + c * 1000) % 65536).astype(np.uint16)


def write_fixtures(out: Path) -> None:
    channels = [("DAPI", 377, 447), ("GFP", 469, 525), ("RFP", 531, 593), ("CY5", 628, 685)]
    with tifffile.TiffWriter(out / "biotek.tif") as tif:
        for c, (name, ex, em) in enumerate(channels):
            desc = BIOTEK.format(w=W, h=H, wum=W * 0.65, hum=H * 0.65, name=name, ex=ex, em=em)
            tif.write(plane(c), description=desc, metadata=None, contiguous=False)
    tifffile.imwrite(out / "lzw.tif", plane(0), compression="lzw", rowsperstrip=8, metadata=None)
    tifffile.imwrite(out / "deflate-predictor.tif", np.stack([plane(c) for c in range(3)]), photometric="rgb",
                     planarconfig="separate", compression="zlib", predictor=True, rowsperstrip=7, metadata=None)
    tifffile.imwrite(out / "packbits.tif", plane(1, np.uint8), compression="packbits", rowsperstrip=5, metadata=None)
    tifffile.imwrite(out / "tiled.tif", plane(2), tile=(32, 32), compression="zlib", metadata=None)
    tifffile.imwrite(out / "bigtiff.tif", plane(3), bigtiff=True, metadata=None)
    tifffile.imwrite(out / "bigendian.tif", plane(1), byteorder=">", metadata=None)
    tifffile.imwrite(out / "rgb.tif", np.stack([plane(c, np.uint8) for c in range(3)], axis=-1), photometric="rgb",
                     metadata=None)
    ome = np.stack([np.stack([plane(c) + z for z in range(2)]) for c in range(3)])  # C, Z, Y, X
    tifffile.imwrite(out / "ome.ome.tif", ome, ome=True, photometric="minisblack",
                     metadata={"axes": "CZYX", "PhysicalSizeX": 0.5, "PhysicalSizeY": 0.5,
                               "Channel": {"Name": ["Hoechst", "AF488", "AF647"]}})
    ij = np.stack([np.stack([plane(c) + z for c in range(2)]) for z in range(2)])  # Z, C, Y, X
    tifffile.imwrite(out / "imagej.tif", ij, imagej=True, resolution=(4.0, 4.0),
                     metadata={"axes": "ZCYX", "unit": "um", "Labels": ["Nuclei", "Actin", "Nuclei", "Actin"]})
    tifffile.imwrite(out / "float.tif", plane(0).astype(np.float32), metadata=None)


def engine_view(source) -> dict:
    """What the engine reports for a fixture, and checksums of every channel's pixels."""
    info = source.info.to_json()
    for key in ("path", "folder", "files"):
        info.pop(key, None)
    info["pixels"] = []
    for c in range(len(source.info.channels)):
        rows = source.read_rows(c, 0, source.info.height).astype(np.int64)
        info["pixels"].append([int(rows.sum()), int(rows[0, 0]), int(rows[-1, -1])])
    return info


def engine_views(out: Path, names: list[str]) -> dict:
    views = {}
    for name in names:
        try:
            src = TiffSource(out / name)
        except Exception as exc:  # noqa: BLE001 - the reference records what the engine does
            views[name] = {"error": f"{type(exc).__name__}: {exc}"}
            continue
        try:
            views[name] = engine_view(src)
        except Exception as exc:  # noqa: BLE001
            views[name] = {"error": f"{type(exc).__name__}: {exc}"}
        finally:
            src.close()
    multi = MultiFileSource([str(out / n) for n in COMBINED])
    views["+".join(COMBINED)] = engine_view(multi)
    multi.close()
    return views


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        write_fixtures(out)
        names = sorted(p.name for p in out.glob("*.tif"))
        files = {n: base64.b64encode((out / n).read_bytes()).decode() for n in names}
        engine = engine_views(out, names)

    rng = np.random.default_rng(7)
    a = rng.integers(0, 4096, size=(21, 37), dtype=np.uint16)
    levels = [a]
    while max(levels[-1].shape) > 4:
        levels.append(downsample2(levels[-1]))
    counts = np.bincount(a.ravel(), minlength=65536).astype(np.int64)
    reference = {
        "files": files,
        "engine": engine,
        "image": a.tolist(),
        "levels": [lv.tolist() for lv in levels],
        "histogram16": histogram_summary(counts, 4000, 16, True),
        "histogram_wide": histogram_summary(counts, None, 256, False),
        "histogram_all": histogram_summary(counts, 2000, 65536, True),
        "plans": {f"{w}x{h}": [[lv.width, lv.height] for lv in plan_levels(w, h, TILE)]
                  for w, h in [(27643, 17482), (1063, 704), (512, 512), (513, 300), (70, 45)]},
        "band_rows": {str(n): band_rows_for(n, TILE) for n in range(1, 12)},
    }
    (HERE / "reference.json").write_text(json.dumps(reference))


if __name__ == "__main__":
    main()

# FluoroView 4

Viewer and analysis engine for multiplex fluorescence whole-slide scans. A local Python engine reads
images where they are; the studio, a browser UI served by the engine, draws raw 16-bit pixels on the
GPU, so what you see at any zoom is the data in the file.

> **Status:** FluoroView 4 is in development on the `v4` branch. The engine and viewer are working;
> regions and measurements, export, segmentation, per-cell quantification, phenotyping, spatial
> statistics and batch projects follow. The JOSS paper in `paper.md` describes FluoroView 2.0
> (tag `v2.0.0`).

## What works today

- Opens BioTek Gen5 (Cytation, Lionheart), OME-TIFF, ImageJ and multi-page TIFF files in place.
  Nothing is uploaded, copied or converted before the image is shown.
- Uncompressed scans show full resolution immediately. One sequential pass over the file builds the
  zoom levels (2×2 area mean) and exact 65,536-bin histograms in the background, and the image fills
  in while it runs.
- Channel names, excitation/emission, pixel size, objective and the camera's saturation level are read
  from the file. Bright-field and phase channels are recognised and start hidden.
- Per-channel window, gamma and colour are applied on the GPU to the raw values. Magnified views show
  exact pixels, with a pixel grid from 800%.
- Auto contrast uses exact whole-image percentiles and ignores saturated pixels; each channel shows its
  clipped fraction, and clipped pixels can be highlighted.
- The status bar shows the raw value of every visible channel under the cursor, in pixels and µm.

## Measured

A 3.87 GB BioTek Cytation scan (27,643 × 17,482 px, 4 channels, 16-bit, uncompressed), stored on an
external USB SSD (exFAT) and opened on a MacBook Pro with an Apple M2 and 16 GB of memory:

| Step | Time |
| --- | --- |
| Open and read metadata | 25–35 ms |
| Full-resolution tile straight from the source | ≈50 ms for a new 512-row band, then from memory |
| Zoom pyramid and exact histograms (one read of the file) | 8.4–8.6 s |
| Tile from the cache, any zoom level | 0.1–0.9 ms median |

The cache for that scan uses 1.39 GB on the internal disk. The same scan in FluoroView 3.5 was
decoded completely in the browser and then shown at a quarter of its resolution.
`engine/bench/bench_open.py` reproduces these measurements on any scan.

## Install and run

Requirements: Python 3.11 or newer, [uv](https://docs.astral.sh/uv/), Node.js 20 or newer (to build the studio).

```bash
git clone -b v4 https://github.com/arvinhm/FluoroView.git
cd FluoroView/studio && npm ci && npm run build      # builds the UI into the engine package
cd ../engine && uv sync
uv run fluoroview /path/to/scan.tif
```

`fluoroview` prints a local address containing a one-time access token and opens it in the browser.
The engine listens on 127.0.0.1 only and rejects requests without the token or with a foreign Host
header. Options: `--port`, `--no-browser`, `--cache-dir`, `--cache-limit-gb` (default 20; the least
recently used caches are removed first).

## How it works

- `engine/` (Python): TIFF-family readers; a one-pass pyramid builder (a reader thread, one compute
  thread per channel, compiled histogram and downsampling kernels); a cache of raw 512 × 512 chunks
  in OME-Zarr v0.4 layout under `~/Library/Caches/FluoroView`; a FastAPI server for tiles,
  histograms, pixel values, folder listing and build progress over WebSocket.
- `studio/` (TypeScript, React): a WebGL2 renderer that keeps each tile as a 16-bit integer texture
  array (one layer per channel), chooses the pyramid level in device pixels, loads the coarsest level
  first and shows it until finer tiles arrive.

## Development

```bash
cd engine && uv run pytest && uv run ruff check src tests bench
cd studio && npm test && npx tsc --noEmit
cd engine && uv run python bench/bench_open.py /path/to/scan.tif
```

For live UI work, run the engine with a fixed token and the Vite dev server:

```bash
cd engine && FLUOROVIEW_TOKEN=dev uv run fluoroview --port 7070 --no-browser
cd studio && npm run dev        # then open http://localhost:5173/#token=dev
```

## Earlier versions

- FluoroView 2.0: Python desktop application (CustomTkinter); tag `v2.0.0`, described in `paper.md`.
- FluoroView 3.5: web application; tag `v3.5.1`.

## Citation

If you use FluoroView in your research, please cite the JOSS paper (see `CITATION.cff`).

## License

BSD 3-Clause. See [LICENSE](LICENSE).

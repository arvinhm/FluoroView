# Figure 1 (overview.png): Combined 4-Panel Figure

## Purpose
The ONE figure for the JOSS paper. Must show the complete software in a single glance.

## Final Image
- **File**: `figures/overview.png`
- **Width**: 7 inches (2100 px at 300 DPI)
- **Height**: 5 inches (1500 px at 300 DPI)

## Layout: 2x2 grid (A, B, C, D)

### Panel A (top-left, ~55% width): Main Viewer
- Load a 4-channel multiplex tissue image
- All channels visible with nice pseudo-colors
- Channel panel on right showing histograms + sliders
- Minimap visible top-right with green viewport rectangle
- Scale bar visible bottom-right showing µm
- Set pixel size first (e.g. 0.5 µm)

### Panel B (top-right, ~45% width): Segmentation Overlay
- Same or similar tissue, zoomed in
- Yellow Cellpose cell boundary outlines on top of fluorescence
- Clearly visible individual cells

### Panel C (bottom-left, ~50% width): Single-Cell Analysis
- Two sub-panels side by side:
  - Left: Scatter plot (marker X vs Y, colored by Z)
  - Right: Spatial map (cells at coordinates, colored by expression)
- From the Cells analysis dialog

### Panel D (bottom-right, ~50% width): ROI Export
- Screenshot of an exported ROI folder in Finder showing:
  - ROI-1-merged.tif, ROI-1-DAPI.tif, ROI-1-stats.csv, ROI-1-analysis.png, ROI-1-notes.txt
- OR: the exported bar graph (analysis.png) opened

## Assembly
1. Capture all 4 panels separately
2. PowerPoint/Keynote at 7" x 5"
3. 2x2 grid, 6px white gaps
4. Bold white **A**, **B**, **C**, **D** labels (14pt) top-left of each panel
5. Export PNG at 300 DPI

## Caption (in paper.md)
"FluoroView interface. (A) Main viewer showing a 4-channel multiplex
fluorescence tissue image with channel controls, minimap, and scale bar.
(B) Cellpose segmentation overlay with cell boundaries. (C) Single-cell
scatter plot and spatial expression map. (D) ROI export folder with masked
channel images, intensity statistics CSV, and analysis bar graph."

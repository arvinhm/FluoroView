# Figure 3: ROI Tools and Export

## Purpose
Show the three ROI types in action on tissue AND the complete exported folder structure with all output files. This demonstrates the quantitative analysis workflow.

## Final Image Size
- **Width**: 7 inches (2100 px at 300 DPI)
- **Height**: 5 inches (1500 px at 300 DPI)
- **File**: `figures/rois.png`

## Layout: 2×2 panel grid (A, B, C, D)

### Panel A (top-left, ~50% width): "ROI Types on Tissue"
**What to show**: A zoomed-in view of tissue with 3 different ROIs drawn:
1. A **rectangle** ROI (green outline, labeled "ROI-1")
2. A **circle/ellipse** ROI (green outline, labeled "ROI-2")
3. A **freehand polygon** ROI (green outline, labeled "ROI-3")

**How to capture**:
1. Load a multiplex image
2. Zoom to a region with clear tissue structures
3. Draw a rectangle ROI around a gland/structure
4. Draw a circle ROI around a cluster of cells
5. Draw a freehand polygon around an irregular region
6. Take a screenshot of just the canvas area

**Key details**: Labels must be visible (Arial 13pt, green, zoom-independent). ROI borders should be thin (2px) and green (#00ff88). Corner handles visible on the rectangle.

### Panel B (top-right, ~50% width): "In-Progress Drawing"
**What to show**: A rectangle being drawn — the yellow dashed preview during mouse drag.

**How to capture**:
1. Click the rectangle tool
2. Start dragging to draw a rectangle
3. While HOLDING the mouse button, take a screenshot (`Cmd+Shift+3` captures instantly)
   - Alternative: use screen recording, then extract a frame showing the yellow preview

**Key details**: The yellow (#ffff00) preview rectangle should be clearly visible on the tissue.

### Panel C (bottom-left, ~50% width): "Exported ROI Folder"
**What to show**: A Finder/Explorer window showing the contents of one exported ROI folder.

**How to capture**:
1. Draw at least one ROI
2. Set pixel size (e.g., 0.5 µm) so scale bars appear on images
3. Click the ROI export button (triangle ruler icon)
4. Choose a destination folder
5. After export, open the ROI folder in Finder/Explorer
6. Screenshot showing all files:
   - `ROI-1-merged.tif`
   - `ROI-1-DAPI.tif`
   - `ROI-1-GFP.tif`
   - `ROI-1-Cy5.tif`
   - `ROI-1-stats.csv`
   - `ROI-1-analysis.png`
   - `ROI-1-notes.txt`

**Key details**: Show the file names, sizes, and dates clearly. Use List view in Finder for clarity.

### Panel D (bottom-right, ~50% width): "Analysis Output"
**What to show**: The exported bar graph (`ROI-1-analysis.png`) opened in Preview/Photos.

**How to capture**:
1. Open the exported `ROI-1-analysis.png`
2. Screenshot showing the bar chart with:
   - Channel-colored bars
   - SEM error bars
   - Mean values labeled above bars
   - Title: "ROI-1 — Channel Intensities"

**Alternative for Panel D**: Open the CSV file in Excel/Numbers showing the raw statistics table.

## Assembly Instructions
1. Capture all 4 panels as separate screenshots
2. Open PowerPoint/Keynote
3. Create a slide at 7" × 5"
4. Arrange the 4 panels in a 2×2 grid with 10px gaps
5. Add panel labels: **A**, **B**, **C**, **D** in bold white 16pt font in the top-left corner of each panel
6. Add a thin white border (1pt) around each panel
7. Export as PNG at 300 DPI

## Caption (already in paper.md)
"ROI tools: (A) Rectangle, circle, and freehand polygon ROIs drawn on tissue with zoom-independent labels. (B) In-progress rectangle shown in yellow during drag. (C) Contents of an exported ROI folder: merged TIFF, per-channel TIFFs with scale bars, intensity statistics CSV, bar graph PNG, and annotations text file. (D) Exported analysis bar graph showing per-channel mean intensity with SEM error bars."

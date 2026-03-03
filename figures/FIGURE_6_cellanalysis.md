# Figure 6: Single-Cell Analysis Dialog

## Purpose
Show all 4 visualization modes for per-cell marker expression analysis. This demonstrates the analytical capability beyond simple visualization.

## Final Image Size
- **Width**: 7 inches (2100 px at 300 DPI)
- **Height**: 5 inches (1500 px at 300 DPI)
- **File**: `figures/cellanalysis.png`

## Layout: 2×2 panel grid (A, B, C, D)

### Prerequisites
Before capturing any panel:
1. Load a multiplex image (at least 3-4 channels)
2. Run segmentation (Cellpose or import a mask) — need at least 100+ cells
3. Click the "Cells" button (DNA icon 🧬) in the toolbar
4. The "Single-Cell Analysis" window will open
5. First time: it will quantify all cells (status bar: "Quantifying X cells...")

### Panel A (top-left): "Scatter Plot"
**What to show**: Two markers plotted against each other, colored by a third.

**How to capture**:
1. In the analysis dialog, select "Scatter (X vs Y)" radio button
2. Set X-axis marker to one channel (e.g., "DAPI")
3. Set Y-axis marker to another channel (e.g., "GFP" or your marker)
4. Set "Colour by marker" to a third channel
5. Click "Refresh"
6. The scatter plot should show:
   - Each dot = one cell
   - X/Y axes = mean marker intensity
   - Color = third marker intensity (coolwarm colormap)
   - Colorbar on the right
   - Title showing marker names
7. Screenshot the plot area

**Key details**:
- Axes labels clearly readable (mean_ChannelName)
- Points small (6pt) with some alpha transparency
- Colorbar visible with label
- Dark background matching the app theme
- At least 100+ visible data points

### Panel B (top-right): "Heatmap"
**What to show**: A cells × markers clustered heatmap.

**How to capture**:
1. Select "Heatmap (cells × markers)" radio button
2. Click "Refresh"
3. The heatmap should show:
   - Rows = cells (up to 500 randomly sampled)
   - Columns = all marker channels
   - Color = expression level (viridis colormap)
   - Column labels showing channel names (rotated 45°)
   - Hierarchical clustering visible (Ward linkage reorders rows)
4. Screenshot

**Key details**:
- Column labels (channel names) must be readable
- Clear color gradient from low (dark) to high (yellow/bright)
- Row clustering visible (similar cells grouped together)
- Y-axis labeled "Cells"

### Panel C (bottom-left): "Histogram"
**What to show**: Distribution of a single marker's expression.

**How to capture**:
1. Select "Histogram" radio button
2. Set X-axis marker to an interesting channel (one with bimodal distribution if possible)
3. Click "Refresh"
4. The histogram should show:
   - 80 bins
   - Blue bars (#6c8eff)
   - X-axis: "mean_ChannelName"
   - Y-axis: "Count"
   - Title: "Distribution of ChannelName expression"
5. Screenshot

**Key details**:
- Bars clearly visible with slight transparency
- Axis labels readable
- Good distribution shape (ideally bimodal or log-normal)

### Panel D (bottom-right): "Spatial Map"
**What to show**: Cells plotted at their physical coordinates, colored by expression.

**How to capture**:
1. Select "Spatial map" radio button
2. Set "Colour by marker" to an interesting channel
3. Click "Refresh"
4. The spatial map should show:
   - Each dot = one cell at its centroid (X, Y) position
   - Color = expression level (coolwarm colormap)
   - Inverted Y-axis (image convention)
   - Equal aspect ratio
   - Colorbar with label
   - Tissue architecture visible through the spatial pattern of dots
5. Screenshot

**Key details**:
- Spatial pattern should match the tissue structure (glands, stroma, etc.)
- Color variation visible (some hot, some cold cells)
- Axis labels showing pixel coordinates
- Title: "Spatial map coloured by ChannelName"

## Assembly Instructions
1. Capture all 4 panels from the analysis dialog (resize the dialog window to be large for each screenshot)
2. PowerPoint/Keynote: 7" × 5" slide
3. Arrange in 2×2 grid with 8px gaps
4. Add **A**, **B**, **C**, **D** labels (bold white 14pt) in top-left of each panel
5. Below each panel label, add a small descriptor:
   - A: "Scatter: GFP vs Cy5 (colored by DAPI)"
   - B: "Heatmap: 500 cells × 4 markers"
   - C: "Histogram: GFP expression distribution"
   - D: "Spatial: cells colored by GFP expression"
6. Export PNG at 300 DPI

## Caption (already in paper.md)
"Single-cell analysis dialog: (A) Scatter plot of two markers colored by a third. (B) Hierarchically clustered heatmap of cells × markers. (C) Single-marker histogram. (D) Spatial map with cells colored by expression level."

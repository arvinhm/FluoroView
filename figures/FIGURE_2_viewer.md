# Figure 2: Main Viewer Interface

## Purpose
The flagship screenshot — show the complete application with all key UI elements visible at once. This is what reviewers and readers will see first and it needs to look impressive.

## Final Image Size
- **Width**: 7 inches (2100 px at 300 DPI)
- **Height**: 4.5 inches (1350 px at 300 DPI)
- **File**: `figures/viewer.png`
- Take screenshot at highest resolution your display supports (Retina recommended)

## How to Capture

### Step 1: Prepare the data
1. Launch FluoroView: `python run_fluoroview.py`
2. Load a 4-channel multiplex fluorescence image (ideally a tissue section with visible structures — prostate, tumor, or any colorful tissue)
3. Make sure all 4 channels are visible and nicely pseudo-colored (Blue DAPI, Green, Red, Orange/Yellow)

### Step 2: Adjust the view
1. Zoom to a level where tissue structures are clearly visible (not too zoomed out, not too zoomed in — about 40–60% zoom)
2. Center on an interesting region (cells, glands, tumor border — something visually striking)
3. Make sure the channel controls show contrast sliders, histograms visible
4. Set a pixel size (e.g., 0.5 µm) so the scale bar shows µm units
5. Make sure the minimap thumbnail is visible in the top-right corner with the green viewport rectangle

### Step 3: Ensure all UI elements are showing
The screenshot MUST show:
- **Left panel**: File list with at least one file loaded, file info (dimensions, channels, DS factor), Save/Load session buttons
- **Toolbar** (top): All icon buttons visible — fit, rect, circle, freehand, clear, eye, brush, save, ROI export, CSV, segmentation, cells, AI
- **Center**: The fluorescence image with good composite colors
- **Top-right corner**: Minimap thumbnail with green viewport rectangle
- **Bottom-right corner**: Scale bar showing "XX µm" with white bar
- **Right panel - top**: Channel controls showing all 4 channels with:
  - Checkbox + color dot + channel name + color dropdown
  - Histogram for each channel
  - Min/Max/Brt/Gam sliders
  - Channel group dropdown ("All")
  - Segmentation overlay checkbox
- **Right panel - bottom tabs**: "Analysis" tab showing the Ratio to DAPI bar graph with colored bars and SEM error bars, "Notes" tab visible

### Step 4: Take the screenshot
- On macOS: `Cmd+Shift+4` then drag to select the entire app window, OR `Cmd+Shift+5` to capture a specific window
- Make sure window chrome (title bar, traffic lights) is visible
- Save as PNG

## Annotation Labels (add in PowerPoint/Keynote after capturing)
Add small white labels with thin lines pointing to key features:
- "Channel controls with live histograms" → right panel
- "Minimap with viewport" → top-right thumbnail
- "Scale bar (µm)" → bottom-right bar
- "Toolbar" → top icon bar
- "File browser" → left panel
- "Analysis graph (Mean ± SEM)" → bottom-right graph tab

Use 9pt Arial, white text on semi-transparent dark background, thin white leader lines.

## Caption (already in paper.md)
"Main viewer interface displaying a 4-channel multiplex fluorescence tissue image. Right panel shows per-channel controls with histograms, channel groups dropdown, and segmentation overlay toggle. Top-right: minimap with viewport rectangle. Bottom-right: adaptive scale bar. Bottom tabs: intensity analysis graph and annotation panel."

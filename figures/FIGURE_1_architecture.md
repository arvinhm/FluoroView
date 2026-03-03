# Figure 1: FluoroView Architecture Diagram

## Purpose
Show the modular package architecture — how the 6 subpackages connect to each other and to external libraries. This is the "system overview" figure that reviewers check first.

## Recommended Tool
PowerPoint, Keynote, or draw.io (diagrams.net). Export as PNG at 300 DPI.

## Final Image Size
- **Width**: 7 inches (2100 px at 300 DPI)
- **Height**: 4–5 inches (1200–1500 px at 300 DPI)
- **File**: `figures/architecture.png`

## Layout: Horizontal flow diagram with 3 layers

### Layer 1 (Top) — External Input/Output
Draw these as rounded rectangles with a light gray fill:
- `TIF / OME-TIFF / JPG / PNG / SVS / CZI` (left)
- `.fluoroview.npz Session File` (center)
- `CSV / TIFF / PNG Exports` (right)

### Layer 2 (Middle) — The 6 FluoroView Subpackages
Draw each as a colored rounded rectangle with the package name in bold and module names listed below in smaller font:

| Package | Color | Modules to list |
|---|---|---|
| **core/** | Blue (#0a84ff) | `channel.py`, `roi.py`, `annotations.py`, `session.py`, `tile_engine.py` |
| **ui/** | Green (#30d158) | `theme.py`, `channel_control.py`, `annotation_panel.py`, `tooltip.py`, `popups/` (merge, mask, cell_analysis) |
| **analysis/** | Orange (#ff9f0a) | `intensity.py`, `spatial.py`, `quantification.py` |
| **segmentation/** | Red (#ff453a) | `base.py`, `cellpose_seg.py`, `deepcell_seg.py`, `mask_import.py`, `overlay.py` |
| **io/** | Purple (#bf5af2) | `formats.py`, `session_io.py`, `export.py` |
| **ai/** | Teal (#64d2ff) | `providers.py`, `chat_ui.py`, `version_control.py` |

### Layer 3 (Bottom) — External Dependencies
Draw as smaller rounded rectangles with light outlines:
- `NumPy` / `SciPy` / `scikit-image`
- `tifffile` / `Pillow` / `OpenCV`
- `Cellpose` / `DeepCell` (dashed border = optional)
- `matplotlib`
- `CustomTkinter`
- `OpenAI` / `Gemini` / `Claude APIs` (dashed border = optional)

### Arrows
- Solid arrows from Layer 1 → `io/` and `core/` (data loading)
- Solid arrows from `core/` → `ui/` (data to display)
- Solid arrows from `core/` → `analysis/` (data to analyze)
- Solid arrows from `core/` → `segmentation/` (data to segment)
- Solid arrow from `segmentation/` → `analysis/` (masks to quantify)
- Solid arrow from `ai/` → all packages (can modify any module)
- Dashed arrows from Layer 3 → corresponding packages
- Solid arrows from `io/` → Layer 1 right (exports)

### Style Notes
- Black background (#000000) or white background — match your preference
- Use SF Pro or Arial font
- Arrows should be thin (1pt) with small arrowheads
- Keep spacing consistent (20px gaps between boxes)
- Add a small "40 modules | ~7,500 lines" label in the bottom-right corner

### Caption (already in paper.md)
"FluoroView architecture: six subpackages (core, ui, analysis, segmentation, io, ai) organized into 40 Python modules. Arrows indicate primary dependencies between packages."

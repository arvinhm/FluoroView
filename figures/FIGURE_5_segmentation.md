# Figure 5: Cell Segmentation

## Purpose
Show Cellpose segmentation in action — the overlay on tissue, the model menu, and ROI-based segmentation. This demonstrates the deep-learning integration.

## Final Image Size
- **Width**: 7 inches (2100 px at 300 DPI)
- **Height**: 4 inches (1200 px at 300 DPI)
- **File**: `figures/segmentation.png`

## Layout: 3-panel horizontal strip (A, B, C)

### Panel A (left, ~45% width): "Segmentation Overlay"
**What to show**: A zoomed-in view of tissue with yellow cell boundary outlines overlaid on the fluorescence composite.

**How to capture**:
1. Load a multiplex image
2. Either:
   - Run Cellpose segmentation (Seg menu → Cellpose: cyto3) — this may take several minutes
   - OR import a pre-computed segmentation mask (Seg menu → Import mask)
3. Check "Segmentation overlay" checkbox in the right panel
4. Zoom in to a region where individual cells are clearly visible
5. The yellow cell outlines should be visible on top of the fluorescence channels
6. Screenshot the zoomed-in canvas area

**Key details**:
- Yellow (#ffff00) cell boundaries clearly visible
- Individual cells distinguishable
- DAPI (blue) + at least one other channel visible underneath
- Good contrast between the yellow outlines and the tissue
- Zoom level should show ~50-200 cells

**Tips for best result**:
- If cells look too small, zoom in more
- If outlines are hard to see, adjust channel brightness down slightly
- A DAPI-only or DAPI+membrane view makes outlines most visible

### Panel B (center, ~25% width): "Segmentation Menu"
**What to show**: The Seg button's dropdown menu open, showing all options.

**How to capture**:
1. Click the microscope icon (Seg button) in the toolbar
2. The menu should appear showing:
   - 📂 Import mask (TIFF)...
   - ─────────
   - 🧪 Cellpose: whole image
   - 🧪 Cellpose: N ROI(s) only (if ROIs are drawn)
   - ⚙ More models... → submenu with cyto3, nuclei, cyto2, cyto, tissuenet_cp3
   - ─────────
   - ✕ Clear segmentation
3. Screenshot the open menu

**Key details**:
- All menu items must be readable
- The "More models..." submenu expanded if possible (click it to expand, then screenshot)
- Dark theme menu styling visible

**How to capture a menu screenshot on macOS**:
- `Cmd+Shift+4` then press Spacebar, then click the menu (captures the menu as a window)
- OR: use `Cmd+Shift+5` → Record Screen → click menu → stop recording → extract frame

### Panel C (right, ~30% width): "ROI-Based Segmentation"
**What to show**: Segmentation applied only within drawn ROIs (not the full image).

**How to capture**:
1. Draw 2-3 ROIs on different parts of the tissue
2. Run segmentation with "Cellpose: N ROI(s) only"
3. After completion, the cell outlines should appear ONLY inside the ROIs, not outside
4. Zoom out enough to see the ROI boundaries AND the segmented cells inside them
5. Screenshot showing the contrast: segmented cells inside ROIs, no outlines outside

**Key details**:
- Green ROI boundaries clearly visible
- Yellow cell outlines visible INSIDE the ROIs only
- Tissue outside ROIs has no cell outlines
- Status bar at bottom showing "✅ Cellpose (cyto3) — N cells on 3 ROI(s)"

## Assembly Instructions
1. Capture all 3 panels
2. PowerPoint/Keynote: 7" × 4" slide
3. Arrange side by side with 8px gaps
4. Add **A**, **B**, **C** labels (bold white 14pt)
5. Add thin borders
6. Add callout labels:
   - "Cell boundaries" → yellow outlines in Panel A
   - "5 Cellpose models" → menu in Panel B
   - "Segmentation limited to ROIs" → Panel C
7. Export PNG at 300 DPI

## Caption (already in paper.md)
"Cell segmentation: (A) Cellpose segmentation overlay showing cell boundaries in yellow on a multiplex image. (B) Segmentation menu with Cellpose model options, ROI-only segmentation, and mask import. (C) Segmentation applied to selected ROIs only."

# FluoroView v2 — Next-Generation Multiplex Fluorescence Microscopy Viewer

A powerful, macOS-native desktop application for viewing, annotating, and
analysing multiplexed fluorescence microscopy images. Built in Python with
**CustomTkinter** featuring a premium **Liquid Glass** aesthetic — no browser required.

---

## Quick Start

```bash
# 1. Open Terminal and cd into the project folder
cd /Users/Arvin/Downloads/Grants/OR51E2_grant/Images

# 2. Install dependencies (one-time)
pip install -r fluoroview/requirements.txt

# 3. Launch the app (pick any one of these)
python run_fluoroview.py          # simplest
python -m fluoroview              # module style
```

That's it — the dark-themed viewer window will open.

---

## Installation Details

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.10+ | macOS ships with 3.9; install 3.11+ via Homebrew (`brew install python@3.11`) |
| Tkinter | built-in | Included with Python on macOS. Verify: `python -c "import tkinter"` |

### Install dependencies

```bash
pip install numpy tifffile Pillow scipy scikit-image scikit-learn matplotlib customtkinter
```

Or use the bundled requirements file:

```bash
pip install -r fluoroview/requirements.txt
```

### Optional: Deep-learning segmentation

For single-cell analysis with DeepCell Mesmer (nuclear + membrane
segmentation), also install TensorFlow and DeepCell:

```bash
pip install tensorflow deepcell
```

This is **not required** — the app works perfectly without it.  You can always
import pre-computed segmentation masks (TIFF label images) instead.

---

## How to Use

### Loading Images

1. Click **Folder** to open a directory of TIF files, or **File** to pick
   individual TIFs.
2. Multi-channel TIFs and folders-of-single-channel-TIFs are both supported.
3. Channels appear in the right panel with colour, contrast, brightness, and
   gamma controls.

### Viewing

| Action | How |
|---|---|
| Pan | Left-click drag (or right-click drag) |
| Zoom | Scroll wheel / trackpad pinch |
| Fit to window | **Fit** button |
| Coordinates | Shown in the toolbar as you move the cursor |

### Drawing ROIs

Click **Rect**, **Circ**, or **Free** in the toolbar, then draw on the image.
- **Rect / Circle** — click and drag
- **Freehand** — click to place points; click the red start-point to close

Toggle visibility with **Eye**, clear all with **X**.

### Annotations / Notes

Click **Pin** in the Annotations panel (right side), then click on the image to
place a note.  Each note records:
- **Author name** — auto-detected from your PC hostname; click **Name** to
  change it
- **Date and time** of creation
- **Machine fingerprint** — only the machine that created a note can edit or
  delete it (multi-user safe)

Double-click an annotation to see full details.  Use **Link** to associate a
note with an ROI.

### Channel Groups

Create named presets of which channels are visible:
1. Turn on only the channels you want.
2. Click **+** next to the Group dropdown.
3. Name the group (e.g. "DAPI + Membrane").
4. Switch between groups instantly from the dropdown.

### Saving & Exporting

| Button | What it does |
|---|---|
| **Save** | Export full-resolution composite (TIFF or PNG) |
| **ROIs** | Save cropped ROI images (merged + per-channel) |
| **CSV** | Export per-ROI per-channel intensity statistics |
| **Mask / Brush** | Open the brush-mask tool for local adjustments with live Gaussian feathering and red tint preview |

### Sessions (Save / Load)

Save the **entire viewer state** (file paths, channel settings, ROIs,
annotations, segmentation mask, channel groups, zoom/pan, AND **brushed image modifications**) to a monolithic
`.fluoroview.npz` file:

- **Save Session** — left panel
- **Load Session** — left panel

Share the `.fluoroview.npz` with collaborators — they'll see everything exactly
as you left it (annotations are author-locked, and all masked edits are permanently baked into the session state).

### Segmentation & Single-Cell Analysis

1. Click **Seg** and choose:
   - **Import mask (TIFF)** — load a pre-computed label mask from CellProfiler,
     QuPath, ImageJ, etc.
   - **Run DeepCell Mesmer** — AI-powered whole-cell segmentation (requires
     TensorFlow + DeepCell)
2. Toggle **Show segmentation overlay** to see cell boundaries.
3. Click **Cells** to open the single-cell analysis popup with:
   - Scatter plots (marker X vs Y)
   - Heatmap (cells x markers, hierarchically clustered)
   - Histograms (marker distribution)
   - Spatial maps (cells coloured by expression)
   - CSV export of all per-cell data

### AI Assistant

Click the **AI** button in the toolbar to open the built-in AI chat:

1. **Setup:** Click **Settings** to choose a provider (OpenAI, Gemini, Claude) and enter an API key. 
2. **Connection Status:** A visual indicator (●) shows green when connected and red on error.
3. **Chat:** Ask the AI to write features or fix bugs. The AI has full context of the source tree.
4. **History:** Click **History** to view and restore past saved conversations.

The AI can write code edits directly. Every edit is backed up automatically via a local version control system — press **Apply** to write them.

---

## Project Structure

```
Images/
  run_fluoroview.py              <-- launch script
  fluoroview/
    __init__.py                  package root
    __main__.py                  python -m fluoroview entry point
    app.py                       main application window (1194 lines)
    constants.py                 colours, theme, LUT presets
    requirements.txt             pip dependencies
    core/
      channel.py                 ChannelData, loaders, folder scanner
      roi.py                     ROIData (rect, circle, freehand)
      annotations.py             Annotation with author identity
      session.py                 SessionState serialisation
    ui/
      theme.py                   dark theme for tkinter/ttk
      channel_control.py         per-channel sliders + histogram
      annotation_panel.py        notes sidebar with access control
      popups/
        merge_popup.py           channel merge viewer
        mask_popup.py            brush-mask adjustment tool
        cell_analysis.py         scatter, heatmap, histogram, spatial
    analysis/
      intensity.py               ratio-to-DAPI computation
      spatial.py                 BallTree nearest-cell queries
      quantification.py          per-cell marker quantification
    segmentation/
      base.py                    abstract segmenter interface
      deepcell_seg.py            optional DeepCell Mesmer wrapper
      mask_import.py             import TIFF label masks
      overlay.py                 cell outline / colour overlays
    io/
      formats.py                 multi-format image loader
      session_io.py              .fluoroview.npz read/write
      export.py                  CSV + image export
    ai/
      providers.py               OpenAI / Gemini / Claude backends
      chat_ui.py                 AI chat window with setup flow
      version_control.py         file versioning for AI edits
```

---

## Keyboard Shortcuts (macOS)

| Shortcut | Action |
|---|---|
| `Cmd+S` | Save session |
| `Cmd+O` | Load session |
| `Cmd+Z` | Undo last ROI |
| Scroll | Zoom in / out |
| Right-click drag | Pan |

---

## Troubleshooting

**"No module named tkinter"**
```bash
brew install python-tk@3.11
```

**"numpy.dtype size changed" errors**
```bash
pip install --upgrade numpy scikit-image scikit-learn scipy
```

**App doesn't start / blank window**
```bash
python -c "import tkinter; tkinter.Tk().mainloop()"
```
If this shows a window, tkinter works.  If not, reinstall Python with
Homebrew.

**DeepCell segmentation fails**
Make sure TensorFlow is installed and compatible with your Python version.
On Apple Silicon Macs use `pip install tensorflow-macos tensorflow-metal`.

---

## Credits

Inspired by and adapted from:
- [DeepCell-tf](https://github.com/vanvalenlab/deepcell-tf) — cell
  segmentation and overlay rendering
- [MCMICRO](https://github.com/labsyspharm/mcmicro) — multiplexed imaging
  pipeline and quantification patterns
- [Minerva Story](https://github.com/labsyspharm/minerva-story) — channel
  grouping and storytelling concepts
- [Scope2Screen](https://github.com/labsyspharm/scope2screen) — spatial
  queries, annotation patterns, transfer functions
- [UnMicst](https://github.com/HMS-IDAC/UnMicst) — UNet segmentation and
  patch-based inference

---

*FluoroView v2.0 — 34 Python modules, 4,281 lines of code.*

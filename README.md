<p align="center">
  <img src="figures/FluroView.jpg" alt="FluoroView Logo" width="600">
</p>

# FluoroView v2 — Multiplex Fluorescence Microscopy Viewer & Analysis Platform

[![DOI](https://zenodo.org/badge/1166381082.svg)](https://doi.org/10.5281/zenodo.19059504)
[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-green.svg)](https://www.python.org)
[![Tests](https://github.com/arvinhm/FluoroView/actions/workflows/python-app.yml/badge.svg)](https://github.com/arvinhm/FluoroView/actions)

A powerful, cross-platform desktop application for viewing, annotating, segmenting, and analyzing multiplexed fluorescence microscopy images. Built in Python with **CustomTkinter** — no browser, no server, no containers required.

---

## Figure 1: Software Architecture & Workflow

<p align="center">
  <img src="figures/Overview.png" alt="Figure 1: FluoroView Architecture" width="900">
</p>

**Figure 1.** FluoroView software architecture and data-flow diagram. The application comprises six subpackages: **core/** (memory-mapped channel data, ROIs, annotations, tile-based rendering engine), **ui/** (CustomTkinter interface with per-channel controls), **analysis/** (vectorized per-cell quantification and threshold-based phenotyping), **segmentation/** (Cellpose and DeepCell backends), **io/** (multi-format loading, session files, export), and **ai/** (multi-provider chat interface). Arrows indicate data flow between subpackages; external dependencies are shown at bottom.

---

## Figure 2: Main Viewer Interface

<p align="center">
  <img src="figures/Figure_1.png" alt="Figure 2: FluoroView Viewer" width="900">
</p>

**Figure 2.** FluoroView main viewer interface displaying a 5-channel multiplex fluorescence tissue image (5625 x 8500 px, merged from separate single-channel TIFFs). Key annotated elements: **Toolbar** with ROI drawing (Rect, Circle, Free), segmentation, and phenotyping (P±) tools; **Samples** list with multi-file channel merging; **AI Chat** panel with OpenAI provider connection; **Minimap** for viewport navigation; per-channel **Windowing** controls (min, max, brightness, gamma) with live histograms; physical **Scale bar** (100 μm, auto-detected from OME-TIFF metadata); and **Live analysis** panel showing Mean Intensity / DAPI ratios per channel. The tile-cached rendering engine achieves 69 FPS for 4-channel compositing using precomputed LUT-based contrast/gamma lookup tables and a 256-tile LRU cache.

---

## Figure 3: ROI Tools, Annotations & Publication-Quality Export

<p align="center">
  <img src="figures/Figure_2.png" alt="Figure 3: ROI and Annotations" width="900">
</p>

**Figure 3.** Interactive ROI tools, author-tracked annotations, and publication-quality export. **Top-left:** Two freehand ROIs (ROI-1, ROI-2) drawn on the tissue with linked author-tracked annotations ("Arvin's comment") and threaded conversation. **Top-right:** ROI-specific analysis showing per-channel intensity bar chart (Mean Intensity / DAPI with SEM error bars) with ROI-3 selected from the dropdown. **Bottom:** ROI export folder containing per-channel masked TIFF images (DAPI, ECM, Membrane, NM, PanC) with 50 μm embedded scale bars, merged composite, intensity statistics CSV (`ROI-1-stats.csv`), and publication-ready analysis graph (`ROI-1-analysis.png`).

---

## Figure 4: Cell Segmentation

<p align="center">
  <img src="figures/Figure_4.png" alt="Figure 4: Cell Segmentation" width="900">
</p>

**Figure 4.** Cell segmentation using multiple models. **Left:** Automated Cellpose segmentation overlay showing detected cell boundaries on a multiplex tissue image. **Center:** Segmentation menu offering TIFF mask import, whole-image Cellpose, ROI-only Cellpose, and a submenu with five model presets (cyto3, nuclei, cyto2, cyto, tissuenet_cp3) for different tissue types. **Right:** High-magnification view of segmentation boundaries (yellow outlines) overlaid on the composite image, showing individual cell morphology and accurate boundary detection.

---

## Figure 5: Single-Cell Analysis & Cell Phenotyping

<p align="center">
  <img src="figures/Figure_5.png" alt="Figure 5: Analysis and Phenotyping" width="900">
</p>

**Figure 5.** Single-cell analysis and threshold-based cell phenotyping (n = 13,017 cells, 5 markers). **Panel A:** Scatter plot showing PanC vs Membrane expression colored by Membrane intensity, revealing marker co-expression patterns. **Panel B:** Hierarchically clustered cell-by-marker heatmap (500 cells × 5 markers, ward linkage) showing distinct expression clusters. **Panel C:** PanC expression frequency histogram showing bimodal distribution. **Panel D:** Spatial map rendering actual cell mask shapes (not centroid dots) colored by Membrane intensity, preserving tissue architecture. **Bottom row:** Threshold-based cell phenotyping with combinatorial marker annotation — spatial phenotype map showing cells colored by phenotype (e.g., Membrane+ ECM− PanC+ NM−) with legend, and a sortable count table listing 15 distinct cell populations with counts and percentages.

---

## Quick Start

```bash
git clone https://github.com/arvinhm/FluoroView.git
cd FluoroView

pip install -r fluoroview/requirements.txt

python run_fluoroview.py
```

### Try with Example Data

The repository includes downsampled example images for immediate testing:

```bash
python run_fluoroview.py
```

1. Click **File** → select all 5 channel TIFs from `example_data/`
2. Select all 5 in the list → right-click → **Merge Selected as Channels**
3. Click **Seg** → **Import mask (TIFF)** → select `example_data/BEMS340264_Scene-002_cell_mask.tif`
4. Click **Cells** → **Current View** → four-panel analysis opens
5. Click **P±** → adjust thresholds → see phenotype distributions

---

## Installation

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.10+ | macOS: `brew install python@3.11` |
| Tkinter | built-in | Verify: `python -c "import tkinter"` |

### Install dependencies

```bash
pip install -r fluoroview/requirements.txt
```

Or install as a package:

```bash
pip install .
```

### Optional: Cellpose segmentation

```bash
pip install cellpose
```

### Optional: DeepCell Mesmer

```bash
pip install tensorflow deepcell
```

---

## How to Use

### Loading Images

1. Click **Folder** to open a directory of TIF files, or **File** to pick individual files.
2. Multi-channel TIFs and folders of single-channel TIFs are both supported.
3. To merge separate files as channels: select multiple files in the list (Cmd+Click / Ctrl+Click), right-click, and choose **Merge Selected as Channels**.

### Viewing

| Action | How |
|---|---|
| Pan | Left-click drag (or right-click drag) |
| Zoom | Scroll wheel / trackpad pinch |
| Fit to window | **Fit** button |

### Drawing ROIs

Click **Rect**, **Circle**, or **Free** in the toolbar, then draw on the image. Toggle visibility with **Eye**, clear all with **X**.

### Annotations

Click **Pin** in the Annotations panel, then click on the image to place a note. Each note records author name, timestamp, and machine fingerprint. Double-click to view details. Use **Link** to associate with an ROI.

### Segmentation & Analysis

1. Click **Seg** → choose **Import mask (TIFF)**, **Cellpose: whole image**, or **Cellpose: ROI(s) only**
2. Click **Cells** → choose scope (**ROI** / **Current View** / **Entire Slide**)
3. Four-panel analysis opens with scatter, heatmap, histogram, and spatial map
4. Click **P±** for cell phenotyping with threshold-based marker gating

### Saving & Exporting

| Button | What it does |
|---|---|
| **Save** | Export full-resolution composite (TIFF or PNG) |
| **ROIs** | Save cropped ROI images (merged + per-channel) with scale bars |
| **CSV** | Export per-ROI per-channel intensity statistics |
| **Save Session** / **Load Session** | Save/restore entire viewer state |

---

## Project Structure

```
FluoroView/
├── run_fluoroview.py              Launch script
├── pyproject.toml                 Package configuration (pip install .)
├── paper.md                       JOSS paper
├── paper.bib                      Bibliography
├── CITATION.cff                   Citation metadata
├── LICENSE                        BSD 3-Clause
├── example_data/                  Downsampled test images + segmentation mask
├── tests/                         Pytest test suite (24 tests)
├── figures/                       Paper and README figures
│
└── fluoroview/
    ├── __init__.py                Package root (v2.0.0)
    ├── __main__.py                python -m fluoroview entry point
    ├── app.py                     Main application window
    ├── constants.py               Colors, theme, LUT presets
    ├── requirements.txt           pip dependencies
    ├── core/                      Channel data, ROIs, annotations, tile engine
    ├── ui/                        CustomTkinter interface, popups
    ├── analysis/                  Quantification, phenotyping, spatial queries
    ├── segmentation/              Cellpose, DeepCell, mask import, overlay
    ├── io/                        Multi-format loading, session I/O, export
    ├── ai/                        Multi-provider chat, version control
    └── icons/                     Glass-style icon generator
```

---

## Running Tests

```bash
pip install pytest
pytest tests/ -v
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+S` / `Ctrl+S` | Save session |
| `Cmd+O` / `Ctrl+O` | Load session |
| `Cmd+Z` / `Ctrl+Z` | Undo last ROI |
| Scroll | Zoom in / out |
| Right-click drag | Pan |

---

## Troubleshooting

**"No module named tkinter"** — `brew install python-tk@3.11`

**"numpy.dtype size changed"** — `pip install --upgrade numpy scikit-image scikit-learn scipy`

**DeepCell segmentation fails** — ensure TensorFlow is installed. On Apple Silicon: `pip install tensorflow-macos tensorflow-metal`.

---

## Citation

If you use FluoroView in your research, please cite:

```bibtex
@article{hajmirzaian2026fluoroview,
  title={FluoroView: An Open-Source Desktop Application for Interactive Multiplex
         Fluorescence Microscopy Visualization, Annotation, and Single-Cell Phenotyping},
  author={Haj-Mirzaian, Arvin and Heidari, Pedram},
  journal={Journal of Open Source Software},
  year={2026},
  doi={10.5281/zenodo.19059504}
}
```

---

## License

BSD 3-Clause License. See [LICENSE](LICENSE) for details.

---

*FluoroView v2.0 — 42 Python modules, ~8,400 lines of code, 24 automated tests.*

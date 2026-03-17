---
title: "FluoroView: An Open-Source Desktop Application for Interactive Multiplex Fluorescence Microscopy Visualization, Annotation, and Single-Cell Phenotyping"
tags:
  - Python
  - fluorescence microscopy
  - multiplex imaging
  - cell segmentation
  - single-cell analysis
  - cell phenotyping
  - digital pathology
  - spatial biology
authors:
  - name: Arvin Haj-Mirzaian
    orcid: 0000-0001-8977-6865
    corresponding: true
    email: ahajmirzaian@mgh.harvard.edu
    affiliation: 1
  - name: Pedram Heidari
    email: Heidari.Pedram@mgh.harvard.edu
    affiliation: 1
affiliations:
  - name: Division of Nuclear Medicine and Molecular Imaging, Department of Radiology, Massachusetts General Hospital, Harvard Medical School, Boston, MA 02114, USA
    index: 1
date: 16 March 2026
bibliography: paper.bib
---

# Summary

Modern biomedical imaging technologies---including cyclic immunofluorescence
(CyCIF), CODEX, MIBI, Imaging Mass Cytometry, and conventional fluorescence
microscopy---can capture tens to hundreds of molecular markers per tissue section
at subcellular resolution [@bodenmiller2016multiplexed; @lin2018highly]. The
resulting datasets routinely exceed tens of gigabytes per whole-slide image,
creating a critical need for software that can interactively visualize,
annotate, segment, and quantify these images without requiring programming
expertise or expensive commercial licenses. FluoroView is a free, open-source
Python desktop application that addresses this need by providing a complete,
unified environment for multi-channel image analysis on macOS, Windows, and
Linux. Although originally developed for multiplex fluorescence microscopy,
FluoroView's architecture is format-agnostic and supports any multi-channel or
single-channel image (TIFF, OME-TIFF, JPEG, PNG, SVS, CZI). The application
combines a high-performance tile-cached viewer with LUT-based compositing for up
to 50 channels, interactive ROI tools with automated quantification,
author-tracked annotations with threaded replies, Cellpose-powered cell
segmentation [@cellpose; @cellpose3], vectorized per-cell expression
quantification, threshold-based cell phenotyping with combinatorial marker
annotation, and an integrated AI assistant supporting OpenAI, Google Gemini, and
Anthropic Claude---enabling researchers to extend and customize the software
through natural language without writing code. FluoroView is distributed under
the BSD 3-Clause license at <https://github.com/arvinhm/FluoroView>.

# Statement of need

Quantitative analysis of tissue images remains a significant bottleneck across
pathology, immunology, and spatial biology. A typical workflow requires
researchers to switch between separate tools for viewing, annotation,
segmentation, quantification, and cell phenotyping. This fragmentation wastes
time, introduces errors, and makes results difficult to reproduce. FluoroView is
designed for biomedical researchers who need all of these capabilities in a
single application---without programming, server infrastructure, or commercial
licenses. Critically, no existing open-source tool offers an integrated AI
assistant that allows non-programmers to add new features, modify workflows, or
customize the interface in natural language, making the software adaptable to
emerging research needs without developer involvement.

# State of the field

Existing open-source tools address subsets of the imaging analysis workflow.
QuPath [@bankhead2017qupath] excels at pathology annotation but lacks integrated
deep-learning segmentation with live overlay and built-in threshold-based
phenotyping. Napari [@napari] provides powerful n-dimensional visualization but
requires Python scripting. MCMICRO [@mcmicro] offers a comprehensive pipeline
but requires Nextflow and Docker. Minerva Story [@minerva_story] enables
web-based visualization but cannot perform segmentation or quantification.
Scope2Screen [@scope2screen] provides spatial queries but requires server
deployment. DeepCell [@deepcell] and UnMicst [@unmicst] provide segmentation but
lack integrated viewers. ImageJ/FIJI [@schindelin2012fiji] lacks native
multi-channel compositing with per-channel gamma correction and integrated
deep-learning segmentation. SCIMAP [@scimap] offers spatial analysis in Python
but has no graphical interface. Commercial platforms (HALO, Visiopharm, inForm)
impose license fees of \$10,000--\$50,000 per seat, operate as closed systems,
and none provide a built-in AI assistant for user-directed customization.

We built FluoroView as a standalone application because no single existing tool
integrates all six workflow stages---viewing, annotation, segmentation,
quantification, phenotyping, and export---in a zero-infrastructure desktop
application with AI-powered extensibility. FluoroView builds upon established
libraries (tifffile [@tifffile], Cellpose, scipy.ndimage [@scipy], scikit-image
[@scikit-image]) rather than reimplementing solved problems, focusing its
contribution on the integration layer, the tile-cached rendering engine, the
phenotyping workflow, and the AI customization interface.

# Software design

FluoroView comprises 42 Python modules (~8,400 lines) in six subpackages, as
shown in \autoref{fig:workflow}. The **core/** subpackage provides memory-mapped
channel arrays via tifffile [@tifffile], ROI geometry, annotations with
machine-fingerprint identity tracking, session serialization, and a tile-based
rendering engine with LRU cache. The **ui/** subpackage implements the graphical
interface using CustomTkinter [@customtkinter]. The **analysis/** subpackage
contains vectorized per-cell quantification via scipy.ndimage [@scipy], BallTree
spatial queries via scikit-learn [@scikit-learn], and threshold-based phenotyping.
The **segmentation/** subpackage offers pluggable Cellpose [@cellpose; @cellpose3]
and DeepCell Mesmer [@deepcell] backends. The **io/** subpackage handles
multi-format loading, multi-file channel merging, session persistence, and
export. The **ai/** subpackage provides multi-provider chat
(OpenAI/Gemini/Claude) with snapshot-based version control and module
hot-reloading, allowing researchers to describe desired features in natural
language and have the AI implement them with automatic backup.

![FluoroView software architecture and data-flow diagram. Six subpackages with data-flow arrows: core/ (channel data, ROIs, annotations, tile engine), ui/ (CustomTkinter interface), analysis/ (quantification, phenotyping), segmentation/ (Cellpose, DeepCell), io/ (multi-format loading, export), ai/ (multi-provider chat, version control). External dependencies shown at bottom.\label{fig:workflow}](figures/Overview.png)

A key design trade-off was choosing precomputed uint16$\rightarrow$uint8 lookup
tables for contrast/gamma over per-pixel floating-point math, achieving 14.6 ms
per frame (69 FPS) for 4-channel compositing with OpenCV-accelerated resize
[@opencv] and a 256-tile LRU cache. For cell quantification, vectorized
scipy.ndimage operations replace the conventional per-cell regionprops approach,
reducing quantification of 13,000 cells from minutes to seconds.
\autoref{fig:viewer} shows the main viewer displaying a 5-channel tissue image
(5625 $\times$ 8500 px) with per-channel windowing controls, adaptive minimap,
100 $\mu$m scale bar (auto-detected from OME-TIFF metadata), live
intensity-ratio analysis, and the integrated AI chat panel.

![Main viewer interface with annotated UI elements: toolbar with ROI/segmentation/phenotyping tools, sample list, AI chat panel, adaptive minimap, per-channel windowing controls with live histograms, 100 \textmu m scale bar, and live intensity-ratio analysis.\label{fig:viewer}](figures/Figure_1.png)

\autoref{fig:rois} demonstrates the ROI tools and export workflow. Freehand ROIs
are drawn with linked author-tracked annotations and threaded conversation. Each
ROI is analyzed independently with per-channel intensity bar charts (Mean
Intensity / DAPI with SEM error bars). Export produces per-channel masked TIFF
images with 50 $\mu$m scale bars, a merged composite, intensity statistics CSV,
and publication-ready analysis graphs.

![ROI tools, author-tracked annotations with threaded conversation, ROI-specific intensity analysis (Mean Intensity / DAPI with SEM), and export folder with per-channel masked TIFF images, statistics CSV, and analysis graphs.\label{fig:rois}](figures/Figure_2.png)

\autoref{fig:segmentation} shows cell segmentation with Cellpose (five model
presets: cyto3, nuclei, cyto2, cyto, tissuenet\_cp3), whole-image or ROI-only
processing with automatic tiled parallelization, and TIFF mask import for
pre-computed masks from any external pipeline.

![Cell segmentation. Left: Cellpose overlay. Center: segmentation menu with mask import, Cellpose options, and five model presets. Right: high-magnification cell boundary outlines.\label{fig:segmentation}](figures/Figure_4.png)

\autoref{fig:analysis} presents single-cell analysis and phenotyping applied to
13,017 cells across 5 markers. Panel A shows a PanC vs Membrane scatter plot
colored by Membrane intensity, revealing co-expression patterns. Panel B displays
a hierarchically clustered heatmap (500 cells $\times$ 5 markers, ward linkage).
Panel C shows the PanC expression histogram informing threshold selection.
Panel D renders a spatial map using actual cell mask shapes colored by intensity,
preserving tissue architecture and cell morphology. The bottom row demonstrates
threshold-based cell phenotyping: per-channel positivity thresholds (with Otsu,
median, or P75 auto-suggestions), excludable channels (DAPI auto-excluded), and
custom marker names produce combinatorial phenotype strings (e.g., Membrane^+^
ECM^-^ PanC^+^ NM^-^). The spatial phenotype map colors each cell by its
assigned phenotype, and the count table lists 15 distinct populations.

![Single-cell analysis and phenotyping (n = 13,017 cells, 5 markers). (A) PanC vs Membrane scatter; (B) cell-by-marker heatmap; (C) expression histogram; (D) spatial cell mask map. Bottom: threshold-based phenotyping with spatial map and count table (15 populations).\label{fig:analysis}](figures/Figure_5.png)

# Research impact statement

FluoroView is actively used for CyCIF tissue analysis at Massachusetts General
Hospital and Harvard Medical School. The software has been benchmarked on
whole-slide images containing over 33,000 segmented cells across 5 channels,
demonstrating real-time performance (69 FPS) and complete phenotyping workflows
with 15+ distinct cell populations. Session persistence (`.fluoroview.npz`)
enables reproducible sharing of complete analysis states. The repository includes
downsampled example data for immediate testing. The integrated AI assistant is a
distinguishing feature: because researchers can describe desired functionality in
natural language and the AI implements it with automatic version control,
FluoroView is designed to evolve with its users' needs---future directions
include pathological scoring systems, H&E-to-gene-expression conversion, and
direct microscope hardware integration for fully automated image acquisition and
analysis, none of which require users to write code.

# Acknowledgements

This work was supported by the Division of Nuclear Medicine and Molecular
Imaging, Department of Radiology, Massachusetts General Hospital. The authors
acknowledge the developers of Cellpose, MCMICRO, Minerva Story, Scope2Screen,
DeepCell, UnMicst, and SCIMAP for their open-source contributions.

# AI usage disclosure

Generative AI tools (Anthropic Claude 4.6 Opus, via the Cursor IDE) were used
during development for code generation, refactoring, debugging, performance
optimization, and documentation drafting. All AI-generated outputs were reviewed,
validated, and approved by the human authors. Core architectural decisions---
tile-based rendering with LUT lookup tables, integer screen blending, memory-
mapped channel arrays, machine-fingerprint annotation tracking, vectorized
scipy.ndimage cell quantification, threshold-based phenotyping with combinatorial
annotation, and the modular package structure---were conceived and directed
entirely by the authors.

# References

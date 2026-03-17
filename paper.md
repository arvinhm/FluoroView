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

Advances in highly multiplexed tissue imaging enable simultaneous detection of
10--100 proteins at subcellular resolution [@bodenmiller2016multiplexed].
Technologies such as cyclic immunofluorescence (CyCIF), CODEX, MIBI, and Imaging
Mass Cytometry generate datasets that routinely exceed tens of gigabytes per
whole-slide image [@lin2018highly], posing substantial challenges for interactive
visualization and quantitative analysis. FluoroView is a free, open-source Python
desktop application that provides a unified environment for multiplex
fluorescence image analysis on macOS, Windows, and Linux. It combines a
high-performance tile-cached viewer with LUT-based compositing for up to 50
channels, interactive ROI tools with automated quantification, author-tracked
annotations, Cellpose-powered cell segmentation [@cellpose; @cellpose3],
vectorized per-cell expression quantification, threshold-based cell phenotyping
with combinatorial marker annotation, and an integrated AI assistant supporting
OpenAI, Google Gemini, and Anthropic Claude. FluoroView is distributed under the
BSD 3-Clause license at <https://github.com/arvinhm/FluoroView>.

# Statement of need

Multiplexed tissue imaging has become a cornerstone of spatial biology, yet
analysis remains a significant bottleneck. The typical workflow requires
researchers to switch between multiple tools: one for viewing, another for
annotation, a separate pipeline for segmentation, and yet another for
quantitative analysis and cell phenotyping. This fragmentation wastes time,
introduces errors, and makes results difficult to reproduce. FluoroView is
designed for biomedical researchers---pathologists, immunologists, and spatial
biologists---who need to view, annotate, segment, quantify, and phenotype
multiplex fluorescence images in a single application without programming,
server infrastructure, or commercial licenses.

# State of the field

Existing open-source tools address subsets of the multiplex imaging workflow.
QuPath [@bankhead2017qupath] excels at pathology annotation but lacks integrated
deep-learning segmentation with live overlay and built-in threshold-based cell
phenotyping. Napari [@napari] provides powerful n-dimensional visualization but
requires Python scripting for analytical workflows. MCMICRO [@mcmicro] offers a
comprehensive command-line pipeline but requires Nextflow and Docker. Minerva
Story [@minerva_story] enables web-based narrative visualization but cannot
perform segmentation or quantitative analysis. Scope2Screen [@scope2screen]
provides spatial queries but requires server deployment. DeepCell [@deepcell] and
UnMicst [@unmicst] provide segmentation but lack integrated viewers. ImageJ/FIJI
[@schindelin2012fiji] lacks native multi-channel compositing with per-channel
gamma correction and integrated deep-learning segmentation. SCIMAP [@scimap]
offers downstream spatial analysis in Python but has no graphical viewer.
Commercial platforms (HALO, Visiopharm, inForm) offer polished interfaces but
impose license fees of \$10,000--\$50,000 per seat and prevent reproducible
sharing of workflows.

We chose to build FluoroView as a standalone application rather than contribute
to existing projects because no single tool integrates all six workflow stages
(viewing, annotation, segmentation, quantification, phenotyping, export) in a
zero-infrastructure desktop application. FluoroView deliberately builds upon
established libraries---tifffile [@tifffile] for image I/O, Cellpose for
segmentation, scipy.ndimage [@scipy] for quantification, scikit-image
[@scikit-image] for boundary detection---rather than reimplementing solved
problems, focusing its unique contribution on the integration layer, the
tile-cached rendering engine, and the phenotyping workflow.

# Software design

FluoroView comprises 42 Python modules (~8,400 lines) in six subpackages, as
illustrated in \autoref{fig:workflow}. The **core/** subpackage provides
memory-mapped channel arrays via tifffile [@tifffile], ROI geometry, annotations
with machine-fingerprint identity tracking, session serialization, and a
tile-based rendering engine with LRU cache. The **ui/** subpackage implements the
graphical interface using CustomTkinter [@customtkinter]. The **analysis/**
subpackage contains vectorized per-cell quantification via scipy.ndimage
[@scipy], BallTree spatial queries via scikit-learn [@scikit-learn], and
threshold-based phenotyping. The **segmentation/** subpackage offers pluggable
Cellpose [@cellpose; @cellpose3] and DeepCell Mesmer [@deepcell] backends. The
**io/** subpackage handles multi-format loading (TIFF, OME-TIFF, JPEG, PNG, SVS,
CZI), multi-file channel merging, session persistence, and export. The **ai/**
subpackage provides multi-provider chat (OpenAI/Gemini/Claude) with
snapshot-based version control.

![FluoroView software architecture and data-flow diagram. The six subpackages are shown with data-flow arrows: core/ provides memory-mapped channel data, ROIs, annotations, and the tile-based rendering engine; ui/ implements the CustomTkinter interface with per-channel controls and popup dialogs; analysis/ performs vectorized per-cell quantification and threshold-based phenotyping; segmentation/ wraps Cellpose and DeepCell backends; io/ handles multi-format image loading and CSV/image export; and ai/ provides the multi-provider chat interface with version control. External dependencies (NumPy, SciPy, tifffile, Cellpose, matplotlib, CustomTkinter, OpenAI/Gemini/Claude APIs) are shown at bottom.\label{fig:workflow}](figures/Overview.png)

A key design trade-off was choosing precomputed uint16$\rightarrow$uint8 lookup
tables for contrast/gamma over per-pixel floating-point math. This sacrifices
sub-integer precision but achieves 14.6 ms per frame (69 FPS) for 4-channel
compositing with OpenCV-accelerated resize [@opencv] and a 256-tile LRU cache.
For cell quantification, we chose vectorized scipy.ndimage operations
(single-pass mean/sum/median over all cells) over the conventional per-cell
regionprops approach, reducing quantification of 13,000 cells from minutes to
seconds. \autoref{fig:viewer} shows the main viewer interface with a 5-channel
multiplex fluorescence tissue image (5625 $\times$ 8500 px). The interface
includes: a toolbar with ROI drawing, segmentation, and phenotyping (P$\pm$)
tools; a file/sample list supporting multi-file channel merging; per-channel
windowing controls (min, max, brightness, gamma) with live histograms; an
adaptive minimap showing viewport position; a physical scale bar (100 $\mu$m,
auto-detected from OME-TIFF metadata); a live intensity-ratio analysis panel;
and an integrated AI chat panel with provider selection.

![FluoroView main viewer interface displaying a 5-channel multiplex fluorescence tissue image with annotated UI elements: toolbar, sample list, AI chat panel, adaptive minimap, per-channel windowing controls with live histograms, physical scale bar (100 \textmu m), and live intensity-ratio analysis.\label{fig:viewer}](figures/Figure_1.png)

\autoref{fig:rois} demonstrates the interactive ROI tools and publication-quality
export workflow. Two freehand ROIs (ROI-1, ROI-2) are drawn on the tissue with
linked author-tracked annotations ("Arvin's comment") and threaded conversation.
The right panel shows ROI-specific analysis with per-channel intensity bar charts
(Mean Intensity / DAPI with SEM error bars) and a dropdown selector for
individual ROIs. The bottom panel shows the export output: a folder containing
per-channel masked TIFF images (DAPI, ECM, Membrane, NM, PanC) with 50 $\mu$m
embedded scale bars, a merged composite, intensity statistics CSV, and a
publication-ready analysis graph.

![Interactive ROI tools, author-tracked annotations with threaded conversation, ROI-specific per-channel intensity analysis (Mean Intensity / DAPI with SEM error bars), and publication-quality export folder containing per-channel masked TIFF images with 50 \textmu m scale bars, merged composite, intensity statistics CSV, and analysis graph.\label{fig:rois}](figures/Figure_2.png)

\autoref{fig:segmentation} shows the cell segmentation capabilities. The left
panel displays an automated Cellpose segmentation overlay with detected cell
boundaries on a multiplex tissue image. The center panel shows the segmentation
menu offering TIFF mask import (for pre-computed masks from CellProfiler, QuPath,
or ImageJ), whole-image Cellpose, ROI-only Cellpose, and a submenu with five
model presets (cyto3, nuclei, cyto2, cyto, tissuenet\_cp3) optimized for
different tissue types. The right panel shows a high-magnification view of
segmentation boundaries (yellow outlines) overlaid on the composite image,
demonstrating accurate detection of individual cell morphology.

![Cell segmentation. Left: Cellpose segmentation overlay with cell boundaries. Center: segmentation menu with TIFF mask import, whole-image and ROI-only Cellpose, and five model presets (cyto3, nuclei, cyto2, cyto, tissuenet\_cp3). Right: high-magnification view of cell boundary outlines (yellow) on the composite image.\label{fig:segmentation}](figures/Figure_4.png)

\autoref{fig:analysis} presents the single-cell analysis and cell phenotyping
module applied to 13,017 cells across 5 markers. Panel A shows a scatter plot of
PanC versus Membrane expression, with cells colored by Membrane intensity,
revealing marker co-expression patterns across the tissue. Panel B displays a
hierarchically clustered cell-by-marker heatmap (500 cells $\times$ 5 markers,
ward linkage), identifying distinct expression clusters. Panel C shows the PanC
expression frequency histogram, revealing a bimodal distribution that helps
inform threshold selection. Panel D renders a spatial map using actual cell mask
shapes (not centroid dots) colored by Membrane intensity, preserving tissue
architecture and cell morphology. The bottom row demonstrates threshold-based
cell phenotyping: researchers set per-channel positivity thresholds (with
automatic Otsu, median, or P75 suggestions), exclude irrelevant channels (e.g.,
DAPI), and define custom marker names. Each cell receives a combinatorial
phenotype string (e.g., Membrane^+^ ECM^-^ PanC^+^ NM^-^). The spatial
phenotype map shows cells colored by their assigned phenotype, and the sortable
count table lists 15 distinct cell populations with counts and percentages.

![Single-cell analysis and cell phenotyping (n = 13,017 cells, 5 markers). Top: (A) PanC vs Membrane scatter plot colored by Membrane intensity; (B) hierarchically clustered cell-by-marker heatmap (500 cells x 5 markers). Middle: (C) PanC expression frequency histogram; (D) spatial map with actual cell mask shapes colored by Membrane intensity. Bottom: threshold-based cell phenotyping with spatial phenotype map and sortable count table showing 15 distinct cell populations.\label{fig:analysis}](figures/Figure_5.png)

# Research impact statement

FluoroView was developed to support ongoing multiplex immunofluorescence research
at Massachusetts General Hospital and Harvard Medical School, where it is
actively used for CyCIF tissue analysis in the Division of Nuclear Medicine and
Molecular Imaging. The software has been benchmarked on whole-slide images
containing over 33,000 segmented cells across 5 channels, demonstrating
real-time interactive performance (69 FPS) and complete phenotyping workflows
with 15+ distinct cell populations. FluoroView's session persistence format
(`.fluoroview.npz`) enables reproducible sharing of complete analysis states
between collaborators. The repository includes downsampled example data with
channel images and a pre-computed segmentation mask for immediate testing. The
combination of zero-infrastructure installation, no license fees, and an
integrated AI assistant for customization positions FluoroView as accessible
community infrastructure for spatial biology laboratories.

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

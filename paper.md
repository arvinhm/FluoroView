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

FluoroView comprises 42 Python modules (~8,400 lines) in six subpackages. The
software architecture and data-flow diagram is shown in \autoref{fig:workflow}.
The **core/** subpackage provides memory-mapped channel arrays via tifffile
[@tifffile], ROI geometry, annotations with machine-fingerprint identity
tracking, session serialization, and a tile-based rendering engine with LRU
cache. The **ui/** subpackage implements the graphical interface using
CustomTkinter [@customtkinter] with per-channel controls, annotation panel,
and popup dialogs for analysis and phenotyping. The **analysis/** subpackage
contains vectorized per-cell quantification via scipy.ndimage [@scipy], BallTree
spatial queries via scikit-learn [@scikit-learn], and threshold-based
phenotyping. The **segmentation/** subpackage offers pluggable Cellpose
[@cellpose; @cellpose3] and DeepCell Mesmer [@deepcell] backends with TIFF mask
import and boundary overlay via scikit-image [@scikit-image]. The **io/**
subpackage handles multi-format loading (TIFF, OME-TIFF, JPEG, PNG, SVS, CZI),
multi-file channel merging, session files, and export. The **ai/** subpackage
provides multi-provider chat (OpenAI/Gemini/Claude) with snapshot-based version
control.

A key design trade-off was choosing precomputed uint16$\rightarrow$uint8 lookup
tables for contrast/gamma over per-pixel floating-point math. This sacrifices
sub-integer precision but achieves 14.6 ms per frame (69 FPS) for 4-channel
compositing with OpenCV-accelerated resize [@opencv] and a 256-tile LRU cache.
For cell quantification, we chose vectorized scipy.ndimage operations
(single-pass mean/sum/median over all cells) over the conventional per-cell
regionprops approach, reducing quantification of 13,000 cells from minutes to
seconds.

The main viewer interface (\autoref{fig:viewer}) provides real-time multi-channel
compositing with per-channel windowing controls (min, max, brightness, gamma),
adaptive minimap, physical scale bar auto-detected from OME-TIFF metadata, live
intensity-ratio analysis, and an integrated AI chat panel.

Interactive ROI tools (\autoref{fig:rois}) support rectangle, ellipse, and
freehand polygon regions with author-tracked annotations and threaded
conversation. Each ROI can be analyzed independently with per-channel intensity
bar charts (Mean Intensity / DAPI with SEM error bars), and exported as
publication-ready figures including per-channel masked TIFF images with embedded
scale bars, merged composites, intensity statistics CSV, and analysis graphs.

Cell segmentation (\autoref{fig:segmentation}) is supported through Cellpose
with five model presets (cyto3, nuclei, cyto2, cyto, tissuenet\_cp3), applicable
to whole images or selected ROIs with automatic tiled parallel processing.
Imported segmentation masks from any external pipeline are equally supported.

The single-cell analysis and phenotyping module (\autoref{fig:analysis})
provides: (A) scatter plots showing expression of two markers with a third as
color channel; (B) hierarchically clustered cell-by-marker heatmaps with ward
linkage; (C) expression frequency histograms; and (D) spatial maps rendering
actual cell mask shapes colored by marker intensity. The bottom row shows
threshold-based cell phenotyping where researchers set per-channel positivity
thresholds, exclude irrelevant channels, and define custom marker names. Each
cell receives a combinatorial phenotype string (e.g., Membrane^+^ ECM^-^
PanC^+^ NM^-^), visualized as a spatial phenotype map with actual cell mask
shapes and a sortable count table showing distinct cell populations.

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

![FluoroView software architecture and data-flow diagram. The application comprises six subpackages with clear boundaries: core/ provides memory-mapped channel data, ROIs, annotations, and the tile-based rendering engine; ui/ implements the CustomTkinter interface; analysis/ performs vectorized per-cell quantification and threshold-based phenotyping; segmentation/ wraps Cellpose and DeepCell backends; io/ handles multi-format loading and export; and ai/ provides the multi-provider chat interface. External dependencies are shown at bottom.\label{fig:workflow}](figures/Overview.png)

![FluoroView main viewer interface. A 5-channel multiplex fluorescence tissue image (5625 x 8500 px) is displayed with per-channel windowing controls (min, max, brightness, gamma) and live histograms on the right panel. Annotated elements include the toolbar with ROI, segmentation, and phenotyping (P\textpm) tools; the file/sample list with multi-file channel merging; session save/load; adaptive minimap; physical scale bar (100 \textmu m); live intensity-ratio analysis; and the integrated AI chat panel with OpenAI provider.\label{fig:viewer}](figures/Figure_1.png)

![Interactive ROI tools, annotations, and publication-quality export. Top-left: two freehand ROIs (ROI-1, ROI-2) drawn on the tissue with linked author-tracked annotations and threaded conversation. Top-right: per-ROI intensity bar chart (Mean Intensity / DAPI with SEM error bars) with ROI-specific dropdown selector. Bottom: ROI export folder containing per-channel masked TIFF images (DAPI, ECM, Membrane, NM, PanC) with 50 \textmu m scale bars, merged composite, intensity statistics CSV, and publication-ready analysis graph.\label{fig:rois}](figures/Figure_2.png)

![Cell segmentation using multiple models. Left: automated Cellpose segmentation overlay showing detected cell boundaries on a multiplex tissue image. Center: segmentation menu offering TIFF mask import, whole-image Cellpose, ROI-only Cellpose, and a submenu with five model presets (cyto3, nuclei, cyto2, cyto, tissuenet\_cp3). Right: high-magnification view of segmentation boundaries (yellow outlines) overlaid on the composite image showing individual cell morphology.\label{fig:segmentation}](figures/Figure_4.png)

![Single-cell analysis and threshold-based cell phenotyping. Top row: (A) scatter plot of PanC vs Membrane expression colored by Membrane intensity (n = 13,017 cells); (B) hierarchically clustered cell-by-marker heatmap (500 cells x 5 markers). Middle row: (C) PanC expression frequency histogram; (D) spatial map with actual cell mask shapes colored by Membrane intensity showing tissue architecture. Bottom row: threshold-based cell phenotyping with combinatorial marker annotation---spatial phenotype map showing cells colored by phenotype (e.g., Membrane^+^ ECM^-^ PanC^+^ NM^-^) with legend, and a sortable count table listing 15 distinct cell populations with counts and percentages.\label{fig:analysis}](figures/Figure_5.png)

# Acknowledgements

This work was supported by the Division of Nuclear Medicine and Molecular
Imaging, Department of Radiology, Massachusetts General Hospital. The authors
acknowledge the developers of Cellpose, MCMICRO, Minerva Story, Scope2Screen,
DeepCell, UnMicst, and SCIMAP for their open-source contributions.

# AI usage disclosure

Generative AI tools (Anthropic Claude 4.6 Opus) were used
during development for debugging and performance
optimization. All AI-generated outputs were reviewed,
validated, and approved by the human authors. 

# References

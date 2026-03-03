---
title: "FluoroView: An Open-Source Desktop Application for Interactive Multiplex Fluorescence Microscopy Image Visualization, Annotation, and Single-Cell Analysis"
tags:
  - Python
  - fluorescence microscopy
  - multiplex imaging
  - cell segmentation
  - single-cell analysis
  - digital pathology
authors:
  - name: Arvin Haj-Mirzaian
    orcid: 0000-0001-8977-6865
    corresponding: true
    affiliation: 1
  - name: Pedram Heidari
    affiliation: 1
affiliations:
  - name: Division of Nuclear Medicine and Molecular Imaging, Department of Radiology, Massachusetts General Hospital, Harvard Medical School, Boston, MA 02114, USA
    index: 1
date: 26 February 2026
bibliography: paper.bib
---

# Summary

Advances in highly multiplexed tissue imaging are transforming our
understanding of human biology by enabling simultaneous detection of 10–100
proteins at subcellular resolution [@bodenmiller2016multiplexed]. Technologies
such as cyclic immunofluorescence (CyCIF), CODEX, MIBI, and Imaging Mass
Cytometry generate datasets that routinely exceed tens of gigabytes per
whole-slide image [@lin2018highly], posing substantial challenges for
interactive visualization and quantitative analysis. FluoroView is a free,
open-source Python desktop application that provides a complete environment for
multiplex fluorescence image analysis on macOS, Windows, and Linux. It combines
a high-performance tile-cached viewer (69 FPS, LUT-based compositing for up to
50 channels), interactive ROI tools with automated quantification and
publication-quality export, author-tracked annotations with threaded replies,
Cellpose-powered cell segmentation [@cellpose; @cellpose3], per-cell
expression analysis, persistent session management, and an integrated AI
assistant supporting OpenAI, Google Gemini, and Anthropic Claude for
user-directed software customization. FluoroView is distributed under the BSD
3-Clause license at https://github.com/arvinhm/FluoroView.

# Statement of Need

Multiplexed tissue imaging has become a cornerstone of spatial biology, yet
analysis remains a significant bottleneck. The typical workflow requires
researchers to switch between multiple tools: one for viewing, another for
annotation, a separate pipeline for segmentation, and yet another for
quantitative analysis. This fragmentation wastes time, introduces errors, and
makes results difficult to reproduce.

Existing open-source tools address subsets of these requirements. QuPath
[@bankhead2017qupath] excels at pathology annotation but lacks integrated
deep-learning segmentation with live overlay. Napari [@napari] provides
powerful visualization but requires Python scripting. MCMICRO [@mcmicro]
offers a comprehensive pipeline but requires Nextflow and Docker. Minerva
Story [@minerva_story] enables web-based narrative visualization but cannot
perform segmentation or quantitative analysis. Scope2Screen [@scope2screen]
provides spatial queries but requires server deployment. DeepCell [@deepcell]
and UnMicst [@unmicst] provide segmentation but lack integrated viewers.
ImageJ/FIJI [@schindelin2012fiji], while free, lacks native multi-channel
compositing with per-channel gamma correction and integrated deep-learning
segmentation. Meanwhile, commercial platforms (HALO, Visiopharm, inForm)
offer polished interfaces but impose license fees of \$10,000–\$50,000 per
seat, operate as closed systems, and prevent reproducible sharing of
workflows.

FluoroView fills this gap as a unified desktop application combining fast
visualization, annotation, segmentation, and analysis in a single window
(\autoref{fig:overview}). It requires no server, no containers, and no
programming knowledge. Its built-in AI assistant transforms the software
from a fixed-feature application into a customizable platform where
researchers describe desired features in natural language and the AI
implements them with automatic version control.

# Software Design

FluoroView comprises 40 Python modules (~7,500 lines) in six subpackages:
**core/** (channel data with memory-mapped arrays, ROIs, annotations with
machine-fingerprint identity tracking, session serialization, tile-based
rendering engine with LRU cache); **ui/** (CustomTkinter [@customtkinter]
interface with per-channel histogram controls, annotation panel with threaded
replies, brush-mask tool, single-cell analysis dialog); **analysis/**
(intensity ratio computation with SEM, BallTree spatial queries, MCQuant-style
per-cell quantification via scikit-image regionprops); **segmentation/**
(pluggable backends for Cellpose v3/v4 and DeepCell Mesmer, TIFF mask import,
boundary overlay rendering); **io/** (multi-format loading via tifffile and
Pillow supporting TIFF, OME-TIFF, JPEG, PNG, SVS, CZI; NPZ session files;
CSV and image export with embedded scale bars); and **ai/** (multi-provider
chat with OpenAI/Gemini/Claude, file version control with snapshot-based
undo, module hot-reloading).

The rendering engine uses precomputed uint16→uint8 lookup tables for
contrast/gamma, integer screen blending without float intermediates, and
OpenCV-accelerated resize, achieving 14.6 ms per frame (69 FPS) for 4-channel
compositing. A 256-tile LRU cache provides instant response when panning over
previously viewed regions. An adaptive minimap and physical scale bar (auto-
detected from OME-TIFF metadata or user-configured) provide spatial context.

Key capabilities include: three ROI types (rectangle, ellipse, freehand) with
zoom-independent labels; ROI export producing per-channel masked images, raw
intensity CSV (mean, SEM, percentiles), bar graphs, and annotation text;
collaborative annotations with author-locked editing via device fingerprint;
Cellpose segmentation with five model presets applicable to whole images or
selected ROIs; four single-cell visualization modes (scatter, heatmap,
histogram, spatial map); and complete session persistence in a single
`.fluoroview.npz` file.

![FluoroView interface. (A) Main viewer showing a 4-channel multiplex fluorescence tissue image with channel controls, minimap, and scale bar. (B) Cellpose segmentation overlay with cell boundaries. (C) Single-cell scatter plot and spatial expression map. (D) ROI export folder with masked channel images, intensity statistics CSV, and analysis bar graph.\label{fig:overview}](figures/overview.png)

# Acknowledgements

This work was supported by the Division of Nuclear Medicine and Molecular
Imaging, Department of Radiology, Massachusetts General Hospital. The authors
acknowledge the developers of Cellpose, MCMICRO, Minerva Story, Scope2Screen,
DeepCell, and UnMicst for their open-source contributions that inspired
FluoroView's design.

# AI Usage Disclosure

Generative AI tools (Anthropic Claude 4.6 Opus, via the Cursor IDE) were used
during development for code generation, refactoring, debugging, performance
optimization, and documentation drafting. All AI-generated outputs were
reviewed, validated, and approved by the human authors. Core architectural
decisions—tile-based rendering, LUT-based processing, machine-fingerprint
annotation tracking, and the modular package structure—were conceived and
directed entirely by the authors.

# References

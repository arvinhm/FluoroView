"""FluoroView v2 — main application window.

Combines the refactored modules into a single cohesive application with:
  - Multi-channel fluorescence composite viewer
  - Session save / load (.fluoroview.npz)
  - Annotations / notes with author-identity tracking
  - Optional deep-learning segmentation (DeepCell Mesmer)
  - Pre-computed mask import
  - Segmentation outline overlay
  - Single-cell quantification & analysis
  - Channel grouping, gamma correction, LUT presets
  - Spatial BallTree queries
"""

from __future__ import annotations

import os
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

import tkinter as tk
from tkinter import filedialog, messagebox

import customtkinter as ctk
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageTk
import tifffile

from fluoroview.constants import (
    IF_COLORS, DEFAULT_COLORS, MAX_PREVIEW_DIM, NUM_WORKERS, LUT_PRESETS,
    THEME,
)
from fluoroview.core.channel import (
    ChannelData, load_channel, load_multichannel_tif, load_any_image,
    scan_folder, get_pixel_size_um,
)
from fluoroview.core.tile_engine import (
    ViewportRenderer, render_minimap, render_scale_bar,
)
from fluoroview.core.roi import ROIData
from fluoroview.core.annotations import Annotation
from fluoroview.core.session import SessionState
from fluoroview.io.session_io import save_session, load_session
from fluoroview.io.export import export_roi_csv, save_composite_tif
from fluoroview.analysis.intensity import compute_ratios
from fluoroview.segmentation.overlay import make_outline_overlay, make_cell_color_overlay, make_unique_outline_overlay
from fluoroview.ui.theme import apply_dark_theme
from fluoroview.ui.channel_control import ChannelControl
from fluoroview.ui.annotation_panel import AnnotationPanel
from fluoroview.ui.popups.merge_popup import MergePopup
from fluoroview.ui.popups.mask_popup import MaskAdjustPopup
from fluoroview.ui.tooltip import ToolTip


class FluoroView(ctk.CTk):
    """Main application window — Apple iOS-inspired design."""

    def __init__(self):
        apply_dark_theme(None)
        super().__init__()
        self.title("FluoroView v2 — Multiplex Fluorescence Viewer")
        self.geometry("1600x950")
        self.minsize(1000, 600)

        # ── state ──────────────────────────────────────────────────────
        self.file_entries: dict = {}
        self.channels: list[ChannelData] = []
        self.channel_controls: list[ChannelControl] = []
        self.current_file: str | None = None
        self.file_settings: dict = {}

        self.zoom_level = 1.0
        self.pan_offset = [0, 0]
        self._pan_sx = 0
        self._pan_sy = 0
        self._pan_so = [0, 0]

        self.rois: list[ROIData] = []
        self.roi_mode: str | None = None
        self.roi_drawing = False
        self.roi_start = None
        self.roi_freehand_pts: list = []
        self.show_rois = True
        self._temp_roi_bbox = None

        self.annotations: list[Annotation] = []
        self.annotation_pin_mode = False

        self.seg_mask: np.ndarray | None = None
        self.show_seg_overlay = False
        self.cell_data: dict | None = None

        # Brush mask (integrated into main canvas)
        self.brush_mask: np.ndarray | None = None
        self.brush_mode_active = False
        self.brush_painting = False
        self.brush_erase = False
        self.brush_size = 20
        self._brush_history: list[np.ndarray] = []
        self._brush_frame = None  # UI controls frame

        # Cell group brush selection
        self.cell_groups: dict[str, set[int]] = {}  # group_name → set of cell IDs
        self.cell_brush_active = False
        self.cell_brush_painting = False
        self.cell_brush_size = 30
        self.current_cell_group: str = "Group 1"
        self._cell_brush_frame = None

        self.channel_groups: dict[str, list[int]] = {}
        self.active_group: str | None = None

        self._update_pending = False
        self._composite_cache = None
        self.executor = ThreadPoolExecutor(max_workers=NUM_WORKERS)
        self._renderer: ViewportRenderer | None = None
        self.pixel_size_um: float = 0.0
        self.show_minimap = True
        self.show_scale_bar = True

        self._load_icons()
        self._build_ui()
        self._bind_events()
        self.after(50, self._set_initial_layout)
        self.after(500, self._bg_check_deps)

    # ══════════════════════════════════════════════════════════════════
    #  UI CONSTRUCTION
    # ══════════════════════════════════════════════════════════════════

    def _load_icons(self):
        from pathlib import Path
        from PIL import Image
        import customtkinter as ctk

        self._icons = {}
        icon_dir = Path(__file__).parent / "icons"
        if not icon_dir.exists():
            return

        for path in icon_dir.glob("*.png"):
            name = path.stem
            try:
                img = Image.open(path)
                ctk_img = ctk.CTkImage(light_image=img, dark_image=img, size=(20, 20))
                self._icons[name] = ctk_img
            except Exception:
                pass

    def _build_ui(self):
        T = THEME

        # ── Main 3-column PanedWindow for drag-resize ─────────────────
        self.main_pane = tk.PanedWindow(self, orient="horizontal",
                                        bg="#0a0b10", sashwidth=4,
                                        sashrelief="flat",
                                        opaqueresize=True)
        self.main_pane.grid(row=0, column=0, sticky="nsew")
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(0, weight=1)

        # ── LEFT SIDEBAR ──────────────────────────────────────────────
        left = ctk.CTkFrame(self.main_pane, width=230, corner_radius=0)
        self.main_pane.add(left, width=320, minsize=260, stretch="never")

        ctk.CTkLabel(left, text="\U0001F4C2  Files",
                     font=ctk.CTkFont(size=16, weight="bold"),
                     text_color="#0a84ff").pack(padx=16, pady=(16, 8), anchor="w")

        btn_fr = ctk.CTkFrame(left, fg_color="transparent")
        btn_fr.pack(fill="x", padx=12, pady=4)
        ctk.CTkButton(btn_fr, text="\U0001F4C1 Folder", width=85, height=32,
                      command=self._open_folder).pack(side="left", padx=(0, 4))
        ctk.CTkButton(btn_fr, text="\U0001F4C4 File", width=85, height=32,
                      command=self._open_file).pack(side="left", padx=(0, 4))
        ctk.CTkButton(btn_fr, text="\u2715", width=32, height=32,
                      fg_color="#ff453a", hover_color="#cc3630",
                      command=self._remove_file).pack(side="right")

        self.file_listbox = tk.Listbox(
            left, font=("SF Mono", 10), selectmode="single",
            bg="#16181f", fg="#e5e5ea", selectbackground="#0a84ff",
            selectforeground="#ffffff", relief="flat", bd=0,
            highlightthickness=0, activestyle="none")
        self.file_listbox.pack(fill="both", expand=True, padx=12, pady=6)
        self.file_listbox.bind("<<ListboxSelect>>", self._on_file_select)

        self.file_info_label = ctk.CTkLabel(left, text="No file loaded",
                                            wraplength=200, text_color="#8e8e93",
                                            font=ctk.CTkFont(size=11))
        self.file_info_label.pack(padx=12, pady=2)

        sess_fr = ctk.CTkFrame(left, fg_color="transparent")
        sess_fr.pack(fill="x", padx=12, pady=(4, 12))
        ctk.CTkButton(sess_fr, text="Save", height=30,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._save_session_dialog).pack(side="left", expand=True, fill="x", padx=(0, 4))
        ctk.CTkButton(sess_fr, text="Load", height=30,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._load_session_dialog).pack(side="left", expand=True, fill="x")

        # ── AI Chat panel (inline, below files) ──────────────────────
        from fluoroview.ai.chat_ui import AIChatPanel
        self._ai_chat_panel = AIChatPanel(left, self)
        self._ai_chat_panel.pack(fill="both", expand=True, padx=4, pady=(4, 8))

        # ── CENTER: toolbar + canvas ──────────────────────────────────
        center = ctk.CTkFrame(self.main_pane, corner_radius=0, fg_color="transparent")
        self.main_pane.add(center, minsize=400, stretch="always")
        center.grid_rowconfigure(1, weight=1)
        center.grid_columnconfigure(0, weight=1)

        # Premium toolbar
        toolbar = ctk.CTkFrame(center, height=52, corner_radius=0,
                               fg_color=T["BG2"])
        toolbar.grid(row=0, column=0, sticky="ew")
        toolbar.grid_propagate(False)

        b_fit = ctk.CTkButton(toolbar, text="", image=self._icons.get("fit"), width=36, height=30,
                      fg_color="#1c1e26", hover_color="#2c2e36",
                      command=self._zoom_fit)
        b_fit.pack(side="left", padx=(8, 2), pady=8)
        ToolTip(b_fit, "Fit image to window")

        ctk.CTkFrame(toolbar, width=1, height=24,
                     fg_color="#2c2e36").pack(side="left", padx=4, pady=12)

        # ROI — segmented button
        self._roi_seg = ctk.CTkSegmentedButton(
            toolbar, values=["Rect", "Circle", "Free"],
            height=30, font=ctk.CTkFont(size=10),
            command=self._on_roi_seg_click)
        self._roi_seg.pack(side="left", padx=4, pady=8)
        self._roi_seg.set("")

        b_clr = ctk.CTkButton(toolbar, text="", image=self._icons.get("clear"), width=32, height=30,
                      fg_color="#1c1e26", hover_color="#ff453a",
                      command=self._clear_all_rois)
        b_clr.pack(side="left", padx=1, pady=8)
        ToolTip(b_clr, "Clear all ROIs")
        b_vis = ctk.CTkButton(toolbar, text="", image=self._icons.get("eye"), width=32, height=30,
                      fg_color="#1c1e26", hover_color="#2c2e36",
                      command=self._toggle_roi_visibility)
        b_vis.pack(side="left", padx=1, pady=8)
        ToolTip(b_vis, "Toggle ROI visibility")

        ctk.CTkFrame(toolbar, width=1, height=24,
                     fg_color="#2c2e36").pack(side="left", padx=4, pady=12)

        for ico_name, cmd, tip in [
            ("brush", self._open_mask_popup, "Brush mask tool"),
            ("save",  self._save_composite, "Save composite"),
            ("roi",   self._save_all_rois, "Export ROIs"),
            ("csv",   self._export_csv, "Export CSV"),
        ]:
            b = ctk.CTkButton(toolbar, text="", image=self._icons.get(ico_name), width=36, height=30,
                              fg_color="#1c1e26", hover_color="#2c2e36",
                              command=cmd)
            b.pack(side="left", padx=1, pady=8)
            ToolTip(b, tip)

        ctk.CTkFrame(toolbar, width=1, height=24,
                     fg_color="#2c2e36").pack(side="left", padx=4, pady=12)

        b_seg = ctk.CTkButton(toolbar, text="", image=self._icons.get("segment"), width=36, height=30,
                      fg_color="#1c1e26", hover_color="#2c2e36",
                      command=self._segmentation_menu)
        b_seg.pack(side="left", padx=1, pady=8)
        ToolTip(b_seg, "Run segmentation")
        b_cell = ctk.CTkButton(toolbar, text="", image=self._icons.get("cells"), width=36, height=30,
                      fg_color="#1c1e26", hover_color="#2c2e36",
                      command=self._open_cell_analysis)
        b_cell.pack(side="left", padx=1, pady=8)
        ToolTip(b_cell, "Cell analysis")
        b_cellbrush = ctk.CTkButton(toolbar, text="", image=self._icons.get("group"), width=36, height=30,
                      fg_color="#1c1e26", hover_color="#30d158",
                      command=self._toggle_cell_brush)
        b_cellbrush.pack(side="left", padx=1, pady=8)
        ToolTip(b_cellbrush, "Cell group brush - select cells into groups")
        b_cellanalysis = ctk.CTkButton(toolbar, text="", image=self._icons.get("plot"), width=36, height=30,
                      fg_color="#1c1e26", hover_color="#0a84ff",
                      command=self._open_cell_group_analysis)
        b_cellanalysis.pack(side="left", padx=1, pady=8)
        ToolTip(b_cellanalysis, "Cell group box plot analysis")

        ctk.CTkFrame(toolbar, width=1, height=24,
                     fg_color="#2c2e36").pack(side="left", padx=4, pady=12)

        ctk.CTkButton(toolbar, text="", image=self._icons.get("ai"), width=36, height=30,
                      fg_color="#0a84ff", hover_color="#0070e0",
                      command=self._open_ai_chat).pack(side="left", padx=4, pady=8)

        self.coord_label = ctk.CTkLabel(toolbar, text="",
                                        font=ctk.CTkFont(family="SF Mono", size=10),
                                        text_color="#48494e")
        self.coord_label.pack(side="right", padx=8)
        self.zoom_label = ctk.CTkLabel(toolbar, text="\u2316 fit",
                                       font=ctk.CTkFont(family="SF Mono", size=10),
                                       text_color="#0a84ff",
                                       fg_color="#1c1e26", corner_radius=6)
        self.zoom_label.pack(side="right", padx=4)

        self.scale_btn = ctk.CTkButton(
            toolbar, text="\U0001F4CF px", width=60, height=24,
            font=ctk.CTkFont(size=10), fg_color="#1c1e26",
            hover_color="#2c2e36", text_color="#8e8e93",
            command=self._set_pixel_size)
        self.scale_btn.pack(side="right", padx=2)
        ToolTip(self.scale_btn,
                "Set pixel size for scale bar\n"
                "(e.g. 0.5 = each pixel is 0.5 \u00b5m)")

        # Image canvas
        self.canvas = tk.Canvas(center, bg="#08090c", highlightthickness=0,
                                cursor="crosshair")
        self.canvas.grid(row=1, column=0, sticky="nsew", padx=2, pady=(0, 2))

        # Brush panel (hidden by default, shown when brush mode active)
        self._brush_frame = ctk.CTkFrame(center, corner_radius=0,
                                          fg_color="#1c1e26")
        # Not shown by default; will be shown via grid() when brush mode activated

        # Row 1 — brush controls
        bf_top = ctk.CTkFrame(self._brush_frame, fg_color="transparent")
        bf_top.pack(fill="x", padx=8, pady=(4, 2))
        ctk.CTkLabel(bf_top, text="Brush",
                     font=ctk.CTkFont(size=12, weight="bold"),
                     text_color="#0a84ff").pack(side="left", padx=(0, 8))
        self._brush_size_var = tk.IntVar(value=20)
        ctk.CTkLabel(bf_top, text="Size:", text_color="#8e8e93").pack(side="left")
        ctk.CTkSlider(bf_top, from_=3, to=150, variable=self._brush_size_var,
                      width=100, height=14,
                      command=lambda v: setattr(self, 'brush_size', int(v))).pack(
            side="left", padx=4)
        self._brush_size_label = ctk.CTkLabel(bf_top, text="20", width=30,
                                               text_color="#8e8e93")
        self._brush_size_label.pack(side="left")
        self._brush_size_var.trace_add("write",
            lambda *a: self._brush_size_label.configure(text=str(self._brush_size_var.get())))
        ctk.CTkSegmentedButton(bf_top, values=["Paint", "Erase"],
                               height=26, font=ctk.CTkFont(size=10),
                               command=lambda v: setattr(self, 'brush_erase', v == "Erase")
                               ).pack(side="left", padx=8)
        ctk.CTkButton(bf_top, text="Undo", width=46, height=24,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      font=ctk.CTkFont(size=10),
                      command=self._brush_undo).pack(side="left", padx=1)
        ctk.CTkButton(bf_top, text="Clear", width=46, height=24,
                      fg_color="#2c2e36", hover_color="#ff453a",
                      font=ctk.CTkFont(size=10),
                      command=self._brush_clear).pack(side="left", padx=1)
        self._brush_pct_label = ctk.CTkLabel(bf_top, text="0%", width=36,
                                              text_color="#8e8e93")
        self._brush_pct_label.pack(side="left", padx=2)
        ctk.CTkButton(bf_top, text="\u2716 Done", width=56, height=24,
                      fg_color="#ff453a", hover_color="#cc3630",
                      font=ctk.CTkFont(size=10),
                      command=self._toggle_brush_mode).pack(side="right")

        # Row 2 — per-channel mask adjustments
        mask_hdr = ctk.CTkFrame(self._brush_frame, fg_color="transparent")
        mask_hdr.pack(fill="x", padx=8, pady=(2, 0))
        ctk.CTkLabel(mask_hdr, text="Mask Adjustments (live preview):",
                     font=ctk.CTkFont(size=10, weight="bold"),
                     text_color="#8e8e93").pack(side="left")
        ctk.CTkButton(mask_hdr, text="\u2705 Apply All Permanently", width=140, height=22,
                      font=ctk.CTkFont(size=10), fg_color="#30d158",
                      hover_color="#28b04d",
                      command=self._brush_apply_all).pack(side="right", padx=2)

        self._brush_ch_frame = ctk.CTkScrollableFrame(
            self._brush_frame, fg_color="transparent",
            orientation="horizontal", height=130)
        self._brush_ch_frame.pack(fill="x", padx=4, pady=(0, 4))
        self._brush_ch_vars: list[dict] = []

        # Cell Group Brush panel (hidden by default)
        self._cell_brush_frame = ctk.CTkFrame(center, corner_radius=0,
                                               fg_color="#1c1e26")
        cb_row = ctk.CTkFrame(self._cell_brush_frame, fg_color="transparent")
        cb_row.pack(fill="x", padx=8, pady=4)
        ctk.CTkLabel(cb_row, text="Cell Groups",
                     font=ctk.CTkFont(size=12, weight="bold"),
                     text_color="#30d158").pack(side="left", padx=(0, 6))
        ctk.CTkLabel(cb_row, text="Group:", text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(side="left")
        self._cell_group_entry = ctk.CTkEntry(cb_row, width=100, height=26,
                                               font=ctk.CTkFont(size=10),
                                               placeholder_text="Group 1")
        self._cell_group_entry.pack(side="left", padx=4)
        self._cell_group_entry.insert(0, "Group 1")
        ctk.CTkButton(cb_row, text="+ New", width=50, height=24,
                      font=ctk.CTkFont(size=10),
                      fg_color="#2c2e36", hover_color="#30d158",
                      command=self._cell_brush_new_group).pack(side="left", padx=2)
        self._cb_size_var = tk.IntVar(value=30)
        ctk.CTkLabel(cb_row, text="Size:", text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(side="left", padx=(8, 0))
        ctk.CTkSlider(cb_row, from_=5, to=200, variable=self._cb_size_var,
                      width=80, height=12,
                      command=lambda v: setattr(self, 'cell_brush_size', int(v))).pack(
            side="left", padx=2)
        ctk.CTkButton(cb_row, text="\u2716 Done", width=56, height=24,
                      font=ctk.CTkFont(size=10),
                      fg_color="#ff453a", hover_color="#cc3630",
                      command=self._toggle_cell_brush).pack(side="right")

        # Group list row
        cb_groups = ctk.CTkFrame(self._cell_brush_frame, fg_color="transparent")
        cb_groups.pack(fill="x", padx=8, pady=(0, 4))
        self._cell_group_list_frame = cb_groups
        ctk.CTkLabel(cb_groups, text="Groups: (none yet)",
                     font=ctk.CTkFont(size=9), text_color="#48494e").pack(side="left")


        right = ctk.CTkFrame(self.main_pane, width=320, corner_radius=0)
        self.main_pane.add(right, width=320, minsize=250, stretch="never")
        right.grid_columnconfigure(0, weight=1)
        # row 0 = header, row 1 = group/seg, row 2 = channel list (expand),
        # row 3 = apply btn, row 4 = tabs
        right.grid_rowconfigure(2, weight=3)
        right.grid_rowconfigure(4, weight=1)

        # Row 0 — Channel header with ON / OFF
        ch_hdr = ctk.CTkFrame(right, fg_color="transparent")
        ch_hdr.grid(row=0, column=0, sticky="ew", padx=10, pady=(10, 2))
        ctk.CTkLabel(ch_hdr, text="\U0001F3A8  Channels",
                     font=ctk.CTkFont(size=15, weight="bold"),
                     text_color="#0a84ff").pack(side="left")
        ctk.CTkButton(ch_hdr, text="ON", width=42, height=26,
                      fg_color="#2c2e36", hover_color="#30d158",
                      font=ctk.CTkFont(size=10),
                      command=self._all_on).pack(side="right", padx=(2, 0))
        ctk.CTkButton(ch_hdr, text="OFF", width=42, height=26,
                      fg_color="#2c2e36", hover_color="#ff453a",
                      font=ctk.CTkFont(size=10),
                      command=self._all_off).pack(side="right", padx=(2, 0))

        # Row 1 — Group selector + seg overlay
        ctrl_row = ctk.CTkFrame(right, fg_color="transparent")
        ctrl_row.grid(row=1, column=0, sticky="ew", padx=10, pady=(2, 2))
        self.group_var = tk.StringVar(value="All")
        self.group_combo = ctk.CTkComboBox(ctrl_row, variable=self.group_var,
                                           values=["All"], width=130, height=28,
                                           command=lambda v: self._apply_channel_group())
        self.group_combo.pack(side="left")
        ctk.CTkButton(ctrl_row, text="+", width=28, height=28,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._add_channel_group).pack(side="left", padx=4)

        self.seg_overlay_var = tk.BooleanVar(value=False)
        ctk.CTkCheckBox(ctrl_row, text="Seg",
                        variable=self.seg_overlay_var,
                        command=self._schedule_update,
                        width=50, font=ctk.CTkFont(size=11)).pack(side="right")

        # Row 2 — Scrollable channel list
        self.controls_frame = ctk.CTkScrollableFrame(
            right, fg_color="transparent", corner_radius=0)
        self.controls_frame.grid(row=2, column=0, sticky="nsew", padx=4, pady=4)

        # Row 3 — Apply button
        ctk.CTkButton(right, text="\U0001F4CB Apply to All", height=30,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._apply_settings_to_all).grid(
            row=3, column=0, sticky="ew", padx=8, pady=4)

        # Row 4 — Tabs: Analysis + Annotations
        self.tabview = ctk.CTkTabview(right, corner_radius=10, height=200)
        self.tabview.grid(row=4, column=0, sticky="nsew", padx=6, pady=(0, 8))

        analysis_tab = self.tabview.add("\U0001F4CA Analysis")
        ah = ctk.CTkFrame(analysis_tab, fg_color="transparent")
        ah.pack(fill="x", padx=4, pady=2)
        ctk.CTkLabel(ah, text="Mean Intensity / DAPI",
                     font=ctk.CTkFont(size=11, weight="bold"),
                     text_color="#8e8e93").pack(side="left")
        self.scope_var = tk.StringVar(value="All Image")
        self.scope_combo = ctk.CTkComboBox(ah, variable=self.scope_var,
                                           values=["All Image"], width=100,
                                           command=lambda v: self._update_analysis_graph())
        self.scope_combo.pack(side="right")
        self.analysis_canvas = tk.Canvas(analysis_tab, height=140,
                                         bg=T["CHART_BG"], highlightthickness=0)
        self.analysis_canvas.pack(fill="both", expand=True, padx=4, pady=4)

        annot_tab = self.tabview.add("\U0001F4CC Notes")
        self.annotation_panel = AnnotationPanel(annot_tab, self)
        self.annotation_panel.pack(fill="both", expand=True)

        self.dpi_var = tk.StringVar(value="300")

        # Status bar
        self.status_var = tk.StringVar(value="\u2713  Ready \u2014 Open a folder to begin")
        status_bar = ctk.CTkFrame(self, height=30, corner_radius=0, fg_color=T["BG2"])
        status_bar.grid(row=1, column=0, sticky="ew")
        ctk.CTkLabel(status_bar, textvariable=self.status_var,
                     font=ctk.CTkFont(size=11),
                     text_color="#8e8e93").pack(side="left", padx=12)

    def _bg_check_deps(self):
        """Check for Cellpose availability (no heavy import at startup)."""
        from fluoroview.segmentation import HAS_CELLPOSE
        if HAS_CELLPOSE:
            return
        self.after(0, lambda: self.status_var.set(
            "\u26A0 Cellpose not installed \u2014 click Seg to install or import masks"))

    def _set_initial_layout(self):
        """Set initial PanedWindow sash positions."""
        self.update_idletasks()
        total_w = self.winfo_width()
        if total_w < 400:
            total_w = 1600
        try:
            self.main_pane.sash_place(0, 230, 0)
            self.main_pane.sash_place(1, total_w - 320, 0)
        except Exception:
            pass

    def _on_roi_seg_click(self, value):
        """Handle the segmented ROI button click."""
        mode_map = {
            "Rect": "rect",
            "Circle": "circle",
            "Free": "freehand",
        }
        mode = mode_map.get(value)
        if mode:
            self._set_roi_mode(mode)

    # ══════════════════════════════════════════════════════════════════
    #  EVENT BINDINGS
    # ══════════════════════════════════════════════════════════════════

    def _bind_events(self):
        self.canvas.bind("<MouseWheel>", self._on_scroll)
        self.canvas.bind("<Button-4>", self._on_scroll)
        self.canvas.bind("<Button-5>", self._on_scroll)
        self.canvas.bind("<ButtonPress-1>", self._on_mouse_press)
        self.canvas.bind("<B1-Motion>", self._on_mouse_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_mouse_release)
        self.canvas.bind("<ButtonPress-2>", self._on_pan_start)
        self.canvas.bind("<B2-Motion>", self._on_pan_drag)
        self.canvas.bind("<ButtonPress-3>", self._on_pan_start)
        self.canvas.bind("<B3-Motion>", self._on_pan_drag)
        self.canvas.bind("<Motion>", self._on_mouse_move)
        self.canvas.bind("<Configure>", lambda e: self._schedule_update())
        # Cross-platform keyboard shortcuts (Cmd on macOS, Ctrl on Windows/Linux)
        import platform as _pf
        _mod = "Command" if _pf.system() == "Darwin" else "Control"
        self.bind(f"<{_mod}-s>", lambda e: self._save_session_dialog())
        self.bind(f"<{_mod}-o>", lambda e: self._load_session_dialog())
        self.bind(f"<{_mod}-z>", lambda e: self._undo_last_roi())

    # ══════════════════════════════════════════════════════════════════
    #  FILE MANAGEMENT
    # ══════════════════════════════════════════════════════════════════

    def _open_folder(self):
        folder = filedialog.askdirectory(title="Select folder with TIF files")
        if not folder:
            return
        self.status_var.set(f"Scanning {folder}...")
        self.update_idletasks()
        entries = scan_folder(folder)
        if not entries:
            messagebox.showinfo("No files", "No TIF files found.")
            self.status_var.set("Ready"); return
        self.file_entries = entries
        self.file_listbox.delete(0, "end")
        for name in entries:
            self.file_listbox.insert("end", name)
        self.status_var.set(f"Found {len(entries)} items in {os.path.basename(folder)}")
        if entries and not self.current_file:
            first = list(entries.keys())[0]
            self.file_listbox.selection_set(0)
            self._load_file(first)

    def _open_file(self):
        files = filedialog.askopenfilenames(
            title="Select TIF file(s)",
            filetypes=[("All Images", "*.tif *.tiff *.jpg *.jpeg *.png *.bmp *.webp *.svs *.ndpi"),
                       ("TIFF", "*.tif *.tiff"), ("JPEG", "*.jpg *.jpeg"),
                       ("PNG", "*.png"), ("All", "*.*")])
        if not files:
            return
        for fp in files:
            bn = os.path.splitext(os.path.basename(fp))[0]
            if bn in self.file_entries:
                bn = f"{bn} ({len(self.file_entries)})"
            self.file_entries[bn] = ("multi", fp)
            self.file_listbox.insert("end", bn)
        self.status_var.set(f"Added {len(files)} file(s)")
        if len(files) == 1 and not self.current_file:
            self.file_listbox.selection_clear(0, "end")
            idx = self.file_listbox.size() - 1
            self.file_listbox.selection_set(idx)
            self._load_file(list(self.file_entries.keys())[idx])

    def _remove_file(self):
        sel = self.file_listbox.curselection()
        if not sel:
            return
        name = self.file_listbox.get(sel[0])
        self.file_listbox.delete(sel[0])
        self.file_entries.pop(name, None)
        if name == self.current_file:
            self.channels = []; self._clear_controls()
            self.canvas.delete("all"); self.current_file = None
            self.file_info_label.configure(text="No file loaded")

    def _on_file_select(self, _event):
        sel = self.file_listbox.curselection()
        if not sel:
            return
        name = self.file_listbox.get(sel[0])
        if name != self.current_file:
            self._load_file(name)

    def _save_current_settings(self):
        if self.current_file and self.channel_controls:
            self.file_settings[self.current_file] = [
                c.get_params() for c in self.channel_controls]

    def _load_file(self, name: str):
        self._save_current_settings()
        self.current_file = name
        entry = self.file_entries[name]
        self.status_var.set(f"Loading {name}..."); self.update_idletasks()
        self.channels = []; self._clear_controls()
        self.rois = []; self._composite_cache = None
        self.seg_mask = None; self.cell_data = None
        self._renderer = None

        try:
            if entry[0] == "folder":
                paths = entry[1]
                futs = {self.executor.submit(load_channel, p): i
                        for i, p in enumerate(paths)}
                results = [None] * len(paths)
                for f in futs:
                    results[futs[f]] = f.result()
                self.channels = results
            else:
                self.channels = load_any_image(entry[1])

            for i, ch in enumerate(self.channels):
                cn = f"Channel {i + 1}"
                if entry[0] == "folder":
                    cn = os.path.splitext(os.path.basename(ch.path))[0]
                    parts = cn.split("_")
                    if len(parts) > 1:
                        cn = parts[-1]
                ctrl = ChannelControl(
                    self.controls_frame, i, cn,
                    vmin=ch.vmin, vmax=ch.vmax, data_max=float(ch.preview.max()),
                    on_change=self._schedule_update, preview_data=ch.preview)
                ctrl.pack(fill="x", padx=2)
                self.channel_controls.append(ctrl)

            if self.channels:
                c0 = self.channels[0]
                self.file_info_label.configure(
                    text=f"{c0.full_h} x {c0.full_w}\n"
                         f"{len(self.channels)} channels\n"
                         f"Preview: {c0.preview.shape[0]}x{c0.preview.shape[1]}\n"
                         f"DS: {c0.ds_factor}x")

            saved = self.file_settings.get(name)
            if saved and len(saved) == len(self.channel_controls):
                for ctrl, p in zip(self.channel_controls, saved):
                    ctrl.set_params(p)

            self._rebuild_group_list()

            # Detect pixel size from TIFF metadata
            src_path = entry[1] if entry[0] == "multi" else entry[1][0]
            self.pixel_size_um = get_pixel_size_um(src_path)
            self._update_scale_btn()
            ps_info = f", {self.pixel_size_um:.3f}\u00b5m/px" if self.pixel_size_um > 0 else ""

            self.zoom_level = 1.0; self.pan_offset = [0, 0]
            self._zoom_fit()
            self.status_var.set(
                f"Loaded {name} \u2014 {len(self.channels)} ch{ps_info}")
        except Exception as e:
            messagebox.showerror("Load Error", f"Failed to load {name}:\n{e}")
            self.status_var.set(f"Error loading {name}")
            traceback.print_exc()

    def _clear_controls(self):
        for c in self.channel_controls:
            c.destroy()
        self.channel_controls = []

    def _all_on(self):
        for c in self.channel_controls:
            c.visible_var.set(True)
        self._schedule_update()

    def _all_off(self):
        for c in self.channel_controls:
            c.visible_var.set(False)
        self._schedule_update()

    def _apply_settings_to_all(self):
        if not self.channel_controls:
            return
        cur = [c.get_params() for c in self.channel_controls]
        cnt = 0
        for n in self.file_entries:
            if n != self.current_file:
                self.file_settings[n] = [dict(p) for p in cur]; cnt += 1
        self.status_var.set(f"Applied settings to {cnt} sample(s)")

    # ══════════════════════════════════════════════════════════════════
    #  CHANNEL GROUPS
    # ══════════════════════════════════════════════════════════════════

    def _rebuild_group_list(self):
        vals = ["All"] + list(self.channel_groups.keys())
        self.group_combo.configure(values=vals)

    def _add_channel_group(self):
        if not self.channel_controls:
            return
        from tkinter import simpledialog
        name = simpledialog.askstring("Channel Group", "Group name:", parent=self)
        if not name:
            return
        visible_idx = [i for i, c in enumerate(self.channel_controls)
                       if c.visible_var.get()]
        self.channel_groups[name] = visible_idx
        self._rebuild_group_list()
        self.group_var.set(name)
        self.status_var.set(f"Created group '{name}' with {len(visible_idx)} channels")

    def _apply_channel_group(self):
        g = self.group_var.get()
        if g == "All":
            self._all_on(); return
        indices = self.channel_groups.get(g, [])
        for i, c in enumerate(self.channel_controls):
            c.visible_var.set(i in indices)
        self._schedule_update()

    # ── channel canvas scroll helpers ──────────────────────────────────



    # ══════════════════════════════════════════════════════════════════
    #  SESSION SAVE / LOAD
    # ══════════════════════════════════════════════════════════════════

    def _save_session_dialog(self):
        path = filedialog.asksaveasfilename(
            title="Save Session", defaultextension=".fluoroview.npz",
            filetypes=[("FluoroView Session", "*.fluoroview.npz"), ("All", "*.*")],
            initialfile=f"{self.current_file or 'session'}.fluoroview.npz")
        if not path:
            return
        self._save_current_settings()
        state = SessionState(
            file_entries=self.file_entries,
            current_file=self.current_file,
            channel_settings=self.file_settings,
            rois=self.rois,
            annotations=self.annotations,
            zoom_level=self.zoom_level,
            pan_offset=list(self.pan_offset),
            seg_mask=self.seg_mask,
            cell_data=self.cell_data,
            channel_groups=self.channel_groups,
            channels_full=[ch.full_data for ch in self.channels],
            channels_preview=[ch.preview for ch in self.channels],
        )
        try:
            save_session(path, state)
            self.status_var.set(f"Session saved → {os.path.basename(path)}")
        except Exception as e:
            messagebox.showerror("Save Error", str(e))

    def _load_session_dialog(self):
        path = filedialog.askopenfilename(
            title="Load Session",
            filetypes=[("FluoroView Session", "*.fluoroview.npz *.npz"), ("All", "*.*")])
        if not path:
            return
        try:
            state = load_session(path)
            self.file_entries = state.file_entries
            self.file_settings = state.channel_settings
            self.rois = state.rois
            self.annotations = state.annotations
            self.channel_groups = state.channel_groups
            if state.seg_mask is not None:
                self.seg_mask = state.seg_mask
            self.file_listbox.delete(0, "end")
            for n in self.file_entries:
                self.file_listbox.insert("end", n)
            self._rebuild_group_list()
            if state.current_file and state.current_file in self.file_entries:
                self.current_file = None
                idx = list(self.file_entries.keys()).index(state.current_file)
                self.file_listbox.selection_set(idx)
                
                self.current_file = state.current_file
                self._clear_controls()
                
                if state.channels_full and state.channels_preview:
                    from fluoroview.core.channel import ChannelData
                    self.channels = []
                    names = self.file_settings.get(self.current_file, [])
                    for i, (full, prev) in enumerate(zip(state.channels_full, state.channels_preview)):
                        h, w = full.shape
                        ds = max(1, max(h, w) // 2500)
                        vmin, vmax = 0.0, 65535.0
                        if i < len(names):
                            vmin = names[i].get("min", vmin)
                            vmax = names[i].get("max", vmax)
                        self.channels.append(ChannelData(
                            path=self.current_file, full_data=full, preview=prev, 
                            ds_factor=ds, vmin=vmin, vmax=vmax))
                    self._build_channel_controls()
                else:
                    self._load_file(state.current_file)
            self.zoom_level = state.zoom_level
            self.pan_offset = list(state.pan_offset)
            self.annotation_panel.refresh()
            self._schedule_update()
            self.status_var.set(f"Session loaded from {os.path.basename(path)}")
        except Exception as e:
            messagebox.showerror("Load Error", str(e))
            traceback.print_exc()

    # ══════════════════════════════════════════════════════════════════
    #  COMPOSITE RENDERING
    # ══════════════════════════════════════════════════════════════════

    def _schedule_update(self):
        if not self._update_pending:
            self._update_pending = True
            self.after(16, self._do_update)  # ~60fps target

    def _do_update(self):
        self._update_pending = False
        self._render_composite()
        self._update_analysis_graph()

    def _render_composite(self):
        if not self.channels:
            return
        cw = self.canvas.winfo_width(); ch_ = self.canvas.winfo_height()
        if cw < 10 or ch_ < 10:
            return

        if self._renderer is None:
            self._renderer = ViewportRenderer(self.channels, self.executor)

        params_list = [c.get_params() for c in self.channel_controls]
        pil = self._renderer.render(
            cw, ch_, self.zoom_level, self.pan_offset,
            params_list, self.seg_mask, self.seg_overlay_var.get())

        # Brush mask overlay — semi-transparent red tint where painted
        if self.brush_mode_active and self.brush_mask is not None:
            pil = self._overlay_brush_mask(pil, cw, ch_)

        # Draw ROI / annotation overlays onto the PIL image
        draw = ImageDraw.Draw(pil)
        self._draw_overlays(draw, cw, ch_)

        # Minimap overlay (top-right corner)
        if self.show_minimap and self.channels:
            c0 = self.channels[0]
            ds = c0.ds_factor
            prev_h, prev_w = c0.preview.shape
            fz = self.zoom_level / ds if self.zoom_level > ds * 0.5 else self.zoom_level
            cx_img = prev_w / 2 - self.pan_offset[0] / self.zoom_level
            cy_img = prev_h / 2 - self.pan_offset[1] / self.zoom_level
            vw = cw / self.zoom_level / 2
            vh = ch_ / self.zoom_level / 2
            vp_rect = (cx_img - vw, cy_img - vh, cx_img + vw, cy_img + vh)
            mm = render_minimap(self.channels, params_list, 140, vp_rect)
            pil.paste(mm, (cw - mm.width - 8, 8),
                      mm if mm.mode == "RGBA" else None)

        # Scale bar overlay (bottom-right)
        if self.show_scale_bar:
            ds = self.channels[0].ds_factor if self.channels else 1
            sb = render_scale_bar(cw, ch_, self.zoom_level, ds,
                                  self.pixel_size_um)
            if sb is not None:
                pil.paste(sb, (0, 0), sb)

        self._tk_image = ImageTk.PhotoImage(pil)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self._tk_image, anchor="nw")

    def _overlay_brush_mask(self, pil: Image.Image, cw: int, ch_: int) -> Image.Image:
        """Live preview: show adjusted image inside mask, red tint on edges."""
        if self.brush_mask is None or not self.channels:
            return pil
        from fluoroview.core.tile_engine import _apply_channel_params

        ih, iw = self.channels[0].preview.shape
        ox = int(cw / 2 + self.pan_offset[0] - iw * self.zoom_level / 2)
        oy = int(ch_ / 2 + self.pan_offset[1] - ih * self.zoom_level / 2)
        dw = max(1, int(iw * self.zoom_level))
        dh = max(1, int(ih * self.zoom_level))

        mask = self.brush_mask
        has_adjustments = False

        # Check if user has changed any sliders from the original
        if hasattr(self, '_brush_ch_vars') and self._brush_ch_vars:
            for d in self._brush_ch_vars:
                idx = d["index"]
                if idx >= len(self.channel_controls):
                    continue
                p = self.channel_controls[idx].get_params()
                if (abs(d["min"].get() - p["min"]) > 1 or
                    abs(d["max"].get() - p["max"]) > 1 or
                    abs(d["brt"].get() - p["brightness"]) > 0.05 or
                    abs(d["gamma"].get() - p.get("gamma", 1.0)) > 0.05):
                    has_adjustments = True
                    break

        if has_adjustments:
            # Render the adjusted composite at preview resolution
            adj_comp = np.zeros((ih, iw, 3), dtype=np.float32)
            for d in self._brush_ch_vars:
                idx = d["index"]
                if idx >= len(self.channels):
                    continue
                p_orig = self.channel_controls[idx].get_params()
                if not p_orig["visible"]:
                    continue
                adj_p = dict(p_orig)
                adj_p["min"] = d["min"].get()
                adj_p["max"] = d["max"].get()
                adj_p["brightness"] = d["brt"].get()
                adj_p["gamma"] = d["gamma"].get()
                rgb = _apply_channel_params(self.channels[idx].preview, adj_p)
                if rgb is not None:
                    adj_comp = 1 - (1 - adj_comp) * (1 - rgb)
            adj_comp = np.clip(adj_comp * 255, 0, 255).astype(np.uint8)
            adj_pil = Image.fromarray(adj_comp).resize(
                (dw, dh), Image.NEAREST if self.zoom_level > 2 else Image.LANCZOS)

            # Blend: inside mask = adjusted, outside = original
            mask_resized = Image.fromarray(
                (mask * 255).astype(np.uint8), "L").resize((dw, dh), Image.LANCZOS)

            full_overlay = Image.new("RGB", (cw, ch_), (0, 0, 0))
            full_overlay.paste(adj_pil, (ox, oy))

            pil_arr = np.array(pil)
            over_arr = np.array(full_overlay)
            # Build screen-space alpha from positioned mask
            alpha_full = np.zeros((ch_, cw), dtype=np.float32)
            ma = np.array(mask_resized).astype(np.float32) / 255.0
            # Clip paste region
            py1, py2 = max(0, oy), min(ch_, oy + dh)
            px1, px2 = max(0, ox), min(cw, ox + dw)
            my1, my2 = max(0, -oy), my1 + (py2 - py1) if (my1 := max(0, -oy)) is not None else 0
            mx1 = max(0, -ox)
            my2 = my1 + (py2 - py1)
            mx2 = mx1 + (px2 - px1)
            if py2 > py1 and px2 > px1 and my2 <= ma.shape[0] and mx2 <= ma.shape[1]:
                alpha_full[py1:py2, px1:px2] = ma[my1:my2, mx1:mx2]

            a3 = alpha_full[:, :, np.newaxis]
            blended = (pil_arr * (1 - a3) + over_arr * a3).astype(np.uint8)

            # Add thin red border on mask edge
            from scipy.ndimage import binary_dilation, binary_erosion
            m_bool = alpha_full > 0.3
            edge = binary_dilation(m_bool, iterations=1) ^ m_bool
            blended[edge] = [255, 60, 60]

            return Image.fromarray(blended)
        else:
            # No adjustments yet — just show red tint where mask is painted
            mask_img = Image.fromarray((mask * 255).astype(np.uint8), "L")
            mask_resized = mask_img.resize((dw, dh), Image.NEAREST)

            overlay = Image.new("RGBA", (cw, ch_), (0, 0, 0, 0))
            tint = Image.new("RGBA", (dw, dh), (255, 60, 60, 100))
            mask_alpha = mask_resized.point(lambda v: 100 if v > 128 else 0)
            tint.putalpha(mask_alpha)
            overlay.paste(tint, (ox, oy), tint)

            pil = pil.convert("RGBA")
            pil = Image.alpha_composite(pil, overlay)
            return pil.convert("RGB")

    def _draw_overlays(self, draw, cw, ch_):
        """Draw ROIs, annotations, freehand onto *draw* at fixed screen size."""
        if not self.channels:
            return
        ih, iw = self.channels[0].preview.shape
        ox = int(cw / 2 + self.pan_offset[0] - iw * self.zoom_level / 2)
        oy = int(ch_ / 2 + self.pan_offset[1] - ih * self.zoom_level / 2)
        z = self.zoom_level
        fnt = self._label_font
        fnt_sm = self._label_font_sm
        LW = 2  # fixed line width in screen pixels

        def _img2scr(px, py):
            return int(px * z) + ox, int(py * z) + oy

        # ROIs
        if self.rois and self.show_rois:
            for roi in self.rois:
                rx1, ry1, rx2, ry2 = roi.bbox
                sx1, sy1 = _img2scr(rx1, ry1)
                sx2, sy2 = _img2scr(rx2, ry2)
                rc = "#00ff88"
                if roi.roi_type == "circle":
                    draw.ellipse([sx1, sy1, sx2, sy2], outline=rc, width=LW)
                elif roi.roi_type == "freehand" and roi.points:
                    pts = [_img2scr(px, py) for px, py in roi.points]
                    if len(pts) > 2:
                        for j in range(len(pts)):
                            draw.line([pts[j], pts[(j + 1) % len(pts)]],
                                      fill=rc, width=LW)
                else:
                    draw.rectangle([sx1, sy1, sx2, sy2], outline=rc, width=LW)
                    for cx, cy in [(sx1, sy1), (sx2, sy1), (sx1, sy2), (sx2, sy2)]:
                        draw.rectangle([cx - 3, cy - 3, cx + 3, cy + 3], fill=rc)
                # Label — always 13px, never scales
                draw.text((sx1 + 5, sy1 - 18), roi.name, fill="#000000",
                          font=fnt, anchor="lt")
                draw.text((sx1 + 4, sy1 - 19), roi.name, fill=rc,
                          font=fnt, anchor="lt")

        # In-progress rect/circle ROI preview
        if self._temp_roi_bbox is not None and self.roi_drawing:
            tx1, ty1, tx2, ty2 = self._temp_roi_bbox
            tsx1, tsy1 = _img2scr(tx1, ty1)
            tsx2, tsy2 = _img2scr(tx2, ty2)
            if self.roi_mode == "circle":
                draw.ellipse([tsx1, tsy1, tsx2, tsy2],
                             outline="#ffff00", width=LW)
            else:
                draw.rectangle([tsx1, tsy1, tsx2, tsy2],
                               outline="#ffff00", width=LW)

        # Freehand in-progress
        if self.roi_freehand_pts and self.roi_mode == "freehand":
            pts = [_img2scr(px, py) for px, py in self.roi_freehand_pts]
            for j in range(len(pts) - 1):
                draw.line([pts[j], pts[j + 1]], fill="#ffff00", width=LW)
            for j, (px, py) in enumerate(pts):
                r = 4 if j == 0 else 3
                col = "#ff4444" if j == 0 else "#ffff00"
                draw.ellipse([px - r, py - r, px + r, py + r], fill=col,
                             outline="white")
            if len(pts) > 2:
                draw.text((pts[0][0] + 8, pts[0][1] - 12), "click to close",
                          fill="#ff4444", font=fnt_sm)

        # Annotation pins — fixed 8px radius, fixed font
        if self.annotations and self.annotation_panel.show_annotations:
            PR = 8
            for ann in self.annotations:
                ax, ay = _img2scr(ann.x, ann.y)
                col = ann.color
                draw.ellipse([ax - PR, ay - PR, ax + PR, ay + PR],
                             fill=col, outline="white", width=2)
                draw.ellipse([ax - 2, ay - 2, ax + 2, ay + 2], fill="white")
                label = ann.author
                if ann.replies:
                    label += f" ({len(ann.replies)})"
                draw.text((ax + PR + 4, ay - PR - 1), label,
                          fill="#000000", font=fnt, anchor="lt")
                draw.text((ax + PR + 3, ay - PR - 2), label,
                          fill=col, font=fnt, anchor="lt")

    def _display_array(self, rgb):
        """Legacy display path — used by export functions."""
        if rgb is None:
            return
        cw = self.canvas.winfo_width(); ch_ = self.canvas.winfo_height()
        if cw < 10 or ch_ < 10:
            return
        ih, iw = rgb.shape[:2]
        dw = max(1, int(iw * self.zoom_level))
        dh = max(1, int(ih * self.zoom_level))
        pil = Image.fromarray(rgb).resize(
            (dw, dh), Image.NEAREST if self.zoom_level > 2 else Image.LANCZOS)
        result = Image.new("RGB", (cw, ch_), (0, 0, 0))
        x = int(cw / 2 + self.pan_offset[0] - dw / 2)
        y = int(ch_ / 2 + self.pan_offset[1] - dh / 2)
        result.paste(pil, (x, y))
        draw = ImageDraw.Draw(result)
        self._draw_overlays(draw, cw, ch_)
        self._tk_image = ImageTk.PhotoImage(result)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self._tk_image, anchor="nw")

    # ══════════════════════════════════════════════════════════════════
    #  ANALYSIS GRAPH
    # ══════════════════════════════════════════════════════════════════

    def _update_analysis_graph(self):
        T = THEME
        c = self.analysis_canvas; c.delete("all")
        if not self.channels or not self.channel_controls:
            return
        w = c.winfo_width(); h = c.winfo_height()
        if w < 30 or h < 30:
            w, h = 260, 150
        c.create_rectangle(0, 0, w, h, fill=T["CHART_BG"], outline="")
        scope_vals = ["All Image"] + [r.name for r in self.rois]
        self.scope_combo.configure(values=scope_vals)
        sel = self.scope_var.get()
        if sel not in scope_vals:
            self.scope_var.set("All Image"); sel = "All Image"
        selected_roi = None
        if sel != "All Image":
            for r in self.rois:
                if r.name == sel:
                    selected_roi = r; break
        params_list = [ctrl.get_params() for ctrl in self.channel_controls]
        dapi_idx = 0
        for i, p in enumerate(params_list):
            if "dapi" in p.get("name", "").lower():
                dapi_idx = i; break
        names, ratios, sems, colors = compute_ratios(
            self.channels, params_list, dapi_idx, selected_roi)
        if not ratios:
            return
        ml, mr, mt, mb = 40, 10, 14, 30
        pw, ph = w - ml - mr, h - mt - mb
        mx = max(r + s for r, s in zip(ratios, sems))
        if mx <= 0:
            mx = 1
        nb = len(ratios)
        bw = max(10, pw // max(1, nb) - 8)
        gap = max(4, (pw - nb * bw) // max(1, nb + 1))
        # Axes
        c.create_line(ml, mt, ml, h - mb, fill=T["CHART_GRID"], width=1)
        c.create_line(ml, h - mb, w - mr, h - mb, fill=T["CHART_GRID"], width=1)
        c.create_text(12, h // 2, text="Mean\u00b1SEM", anchor="center", angle=90,
                      fill=T["CHART_TEXT"], font=("SF Pro Display", 8))
        for frac in [0, 0.5, 1.0]:
            y = int(h - mb - frac * ph)
            c.create_text(ml - 3, y, text=f"{frac * mx:.2f}", anchor="e",
                          fill=T["CHART_TEXT"], font=("SF Pro Display", 8))
            c.create_line(ml, y, w - mr, y, fill=T["CHART_GRID"], width=1)
        for i in range(nb):
            x = ml + gap + i * (bw + gap)
            bh = (ratios[i] / mx) * ph
            yt = h - mb - bh
            c.create_rectangle(x, yt, x + bw, h - mb, fill=colors[i],
                               outline=T["BORDER"], width=1)
            if sems[i] > 0:
                et = h - mb - ((ratios[i] + sems[i]) / mx) * ph
                eb = h - mb - (max(0, ratios[i] - sems[i]) / mx) * ph
                mx_ = x + bw // 2
                c.create_line(mx_, et, mx_, eb, fill=T["FG2"], width=1)
                c.create_line(mx_ - 3, et, mx_ + 3, et, fill=T["FG2"], width=1)
                c.create_line(mx_ - 3, eb, mx_ + 3, eb, fill=T["FG2"], width=1)
            c.create_text(x + bw // 2, yt - 4, text=f"{ratios[i]:.2f}",
                          anchor="s", fill=T["FG"], font=("SF Pro Display", 8))
            c.create_text(x + bw // 2, h - mb + 4, text=names[i], anchor="n",
                          fill=T["CHART_TEXT"], font=("SF Pro Display", 8))

    # ══════════════════════════════════════════════════════════════════
    #  ZOOM / PAN
    # ══════════════════════════════════════════════════════════════════

    def _on_scroll(self, event):
        if event.num == 4 or event.delta > 0:
            factor = 1.35
        elif event.num == 5 or event.delta < 0:
            factor = 1 / 1.35
        else:
            return
        cx = self.canvas.winfo_width() / 2; cy = self.canvas.winfo_height() / 2
        mx = event.x - cx - self.pan_offset[0]
        my = event.y - cy - self.pan_offset[1]
        old = self.zoom_level
        self.zoom_level = max(0.01, old * factor)
        r = self.zoom_level / old
        self.pan_offset[0] -= mx * (r - 1)
        self.pan_offset[1] -= my * (r - 1)
        self.zoom_label.configure(text=f"\u2316 {self.zoom_level:.0%}")
        self._schedule_update()

    def _zoom_fit(self):
        if not self.channels:
            return
        cw = max(self.canvas.winfo_width(), 900)
        ch_ = max(self.canvas.winfo_height(), 700)
        ih, iw = self.channels[0].preview.shape
        self.zoom_level = min(cw / iw, ch_ / ih) * 0.95
        self.pan_offset = [0, 0]
        self.zoom_label.configure(text=f"\u2316 {self.zoom_level:.0%}")
        self._schedule_update()

    def _set_pixel_size(self):
        """Ask user for pixel size in microns and update the scale bar."""
        from tkinter import simpledialog
        current = self.pixel_size_um
        msg = (
            "Enter the physical size of one pixel in microns (\u00b5m).\n\n"
            "Example: if each pixel = 0.5 \u00b5m, enter 0.5\n"
            "This means 1 pixel length = 0.5 \u00b5m\n"
            "A 100-pixel line = 50 \u00b5m\n\n"
            f"Current value: {current if current > 0 else 'not set'}"
        )
        val = simpledialog.askfloat(
            "Pixel Size (\u00b5m/pixel)", msg,
            initialvalue=current if current > 0 else 0.5,
            minvalue=0.001, maxvalue=1000.0, parent=self)
        if val is not None and val > 0:
            self.pixel_size_um = val
            self._update_scale_btn()
            self._schedule_update()
            self.status_var.set(
                f"Pixel size set to {val} \u00b5m/px \u2014 "
                f"scale bar updated")

    def _update_scale_btn(self):
        """Update the scale button label to show current pixel size."""
        if self.pixel_size_um > 0:
            self.scale_btn.configure(
                text=f"\U0001F4CF {self.pixel_size_um:.2f}\u00b5m",
                text_color="#30d158")
        else:
            self.scale_btn.configure(
                text="\U0001F4CF px",
                text_color="#8e8e93")

    def _on_pan_start(self, event):
        self._pan_sx = event.x; self._pan_sy = event.y
        self._pan_so = list(self.pan_offset)

    def _on_pan_drag(self, event):
        self.pan_offset[0] = self._pan_so[0] + (event.x - self._pan_sx)
        self.pan_offset[1] = self._pan_so[1] + (event.y - self._pan_sy)
        self._schedule_update()

    def _canvas_to_image(self, ex, ey):
        cw = self.canvas.winfo_width(); ch_ = self.canvas.winfo_height()
        cx = cw // 2 + self.pan_offset[0]; cy = ch_ // 2 + self.pan_offset[1]
        if not self.channels:
            return None, None
        ih, iw = self.channels[0].preview.shape
        il = cx - (iw * self.zoom_level) / 2
        it = cy - (ih * self.zoom_level) / 2
        return (ex - il) / self.zoom_level, (ey - it) / self.zoom_level

    # ══════════════════════════════════════════════════════════════════
    #  MOUSE EVENTS — ROI drawing + annotation pins
    # ══════════════════════════════════════════════════════════════════

    def _on_mouse_press(self, event):
        # Cell group brush intercept
        if self.cell_brush_active:
            self.cell_brush_painting = True
            self._cell_brush_paint_at(event.x, event.y)
            return

        # Brush mode intercept
        if self.brush_mode_active:
            self._brush_save_undo()
            self.brush_painting = True
            self._brush_paint_at(event.x, event.y)
            return

        # Annotation pin mode
        if self.annotation_pin_mode:
            px, py = self._canvas_to_image(event.x, event.y)
            if px is not None:
                self.annotation_panel.add_annotation_at(px, py)
            self.annotation_pin_mode = False
            self.canvas.config(cursor="crosshair")
            return

        if self.roi_drawing:
            if self.roi_mode == "freehand":
                px, py = self._canvas_to_image(event.x, event.y)
                if px is None:
                    return
                if len(self.roi_freehand_pts) > 2:
                    sx, sy = self.roi_freehand_pts[0]
                    if ((px - sx) ** 2 + (py - sy) ** 2) ** 0.5 * self.zoom_level < 12:
                        pts = self.roi_freehand_pts
                        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                        roi = ROIData("freehand", (min(xs), min(ys), max(xs), max(ys)),
                                      points=pts)
                        self.rois.append(roi)
                        self.roi_freehand_pts = []
                        self.roi_drawing = False
                        self.roi_mode = None
                        self.canvas.config(cursor="crosshair")
                        self.status_var.set(f"Added {roi.name}")
                        self._schedule_update(); return
                self.roi_freehand_pts.append((px, py))
                self._schedule_update()
            else:
                self.roi_start = (event.x, event.y); self._temp_roi_bbox = None
        else:
            self._pan_sx = event.x; self._pan_sy = event.y
            self._pan_so = list(self.pan_offset)

    def _on_mouse_drag(self, event):
        # Cell group brush intercept
        if self.cell_brush_active and self.cell_brush_painting:
            self._cell_brush_paint_at(event.x, event.y)
            return

        # Brush mode intercept
        if self.brush_mode_active and self.brush_painting:
            self._brush_paint_at(event.x, event.y)
            return

        if self.roi_drawing and self.roi_start and self.roi_mode != "freehand":
            px1, py1 = self._canvas_to_image(self.roi_start[0], self.roi_start[1])
            px2, py2 = self._canvas_to_image(event.x, event.y)
            if px1 is None or px2 is None:
                return
            ih, iw = self.channels[0].preview.shape
            px1 = max(0, min(iw, px1)); py1 = max(0, min(ih, py1))
            px2 = max(0, min(iw, px2)); py2 = max(0, min(ih, py2))
            x1, x2 = sorted([px1, px2]); y1, y2 = sorted([py1, py2])
            self._temp_roi_bbox = (x1, y1, x2, y2)
            self._schedule_update()
        elif not self.roi_drawing:
            self.pan_offset[0] = self._pan_so[0] + (event.x - self._pan_sx)
            self.pan_offset[1] = self._pan_so[1] + (event.y - self._pan_sy)
            self._schedule_update()

    def _on_mouse_release(self, event):
        # Cell brush — stop
        if self.cell_brush_active:
            self.cell_brush_painting = False
            return

        # Brush mode — stop painting
        if self.brush_mode_active:
            self.brush_painting = False
            return

        if self.roi_drawing and self.roi_mode != "freehand":
            if self._temp_roi_bbox is not None:
                x1, y1, x2, y2 = self._temp_roi_bbox
                if abs(x2 - x1) > 3 and abs(y2 - y1) > 3:
                    roi = ROIData(self.roi_mode or "rect", (x1, y1, x2, y2))
                    self.rois.append(roi)
                    self.status_var.set(f"Added {roi.name}")
                self._temp_roi_bbox = None
            self.roi_drawing = False
            self.roi_mode = None
            self.canvas.config(cursor="crosshair")
            self._schedule_update()

    def _on_mouse_move(self, event):
        if not self.channels:
            return
        px, py = self._canvas_to_image(event.x, event.y)
        if px is not None:
            ih, iw = self.channels[0].preview.shape
            if 0 <= px < iw and 0 <= py < ih:
                ds = self.channels[0].ds_factor
                self.coord_label.configure(text=f"({int(px * ds)}, {int(py * ds)})")
                return
        self.coord_label.configure(text="")

    # ══════════════════════════════════════════════════════════════════
    #  ROI ACTIONS
    # ══════════════════════════════════════════════════════════════════

    def _set_roi_mode(self, mode):
        self.roi_mode = mode; self.roi_drawing = True
        self.roi_freehand_pts = []; self._temp_roi_bbox = None
        self.canvas.config(cursor="cross")
        self.status_var.set(f"ROI mode: {mode}")

    def _clear_all_rois(self):
        self.rois = []; self.roi_drawing = False; self.roi_mode = None
        self.canvas.config(cursor="crosshair")
        ROIData.reset_counter()
        self._schedule_update()
        self.status_var.set("All ROIs cleared")

    def _undo_last_roi(self):
        if self.rois:
            self.rois.pop()
            self._schedule_update()

    def _toggle_roi_visibility(self):
        self.show_rois = not self.show_rois
        self._schedule_update()
        self.status_var.set(f"ROIs {'visible' if self.show_rois else 'hidden'}")

    def _pan_to_annotation(self, ann: Annotation):
        """Pan the view so annotation *ann* is centered."""
        if not self.channels:
            return
        ih, iw = self.channels[0].preview.shape
        self.pan_offset[0] = -(ann.x - iw / 2) * self.zoom_level
        self.pan_offset[1] = -(ann.y - ih / 2) * self.zoom_level
        self._schedule_update()

    # ══════════════════════════════════════════════════════════════════
    #  SAVE / EXPORT
    # ══════════════════════════════════════════════════════════════════

    def _render_fullres(self, region=None, params_list=None):
        if not self.channels:
            return None
        if params_list is None:
            params_list = [c.get_params() for c in self.channel_controls]
        c0 = self.channels[0]
        if region:
            x1, y1, x2, y2 = [int(v) for v in region]
            x1 = max(0, x1); y1 = max(0, y1)
            x2 = min(c0.full_w, x2); y2 = min(c0.full_h, y2)
            h, w = y2 - y1, x2 - x1
        else:
            h, w = c0.full_h, c0.full_w
            x1, y1, x2, y2 = 0, 0, w, h
        comp = np.zeros((h, w, 3), dtype=np.float64)
        for cd, p in zip(self.channels, params_list):
            if not p["visible"]:
                continue
            d = cd.full_data[y1:y2, x1:x2].astype(np.float64)
            cmin, cmax = p["min"], p["max"]
            if cmax <= cmin:
                cmax = cmin + 1
            d = np.clip((d - cmin) / (cmax - cmin), 0, 1)
            g = p.get("gamma", 1.0)
            if g != 1.0:
                d = np.power(d, 1.0 / g)
            d *= p["brightness"]; np.clip(d, 0, 1, out=d)
            r, g2, b = p["color"]
            cr = np.zeros((h, w, 3), dtype=np.float64)
            cr[:, :, 0] = d * (r / 255.0)
            cr[:, :, 1] = d * (g2 / 255.0)
            cr[:, :, 2] = d * (b / 255.0)
            comp = 1 - (1 - comp) * (1 - cr)
        return np.clip(comp * 255, 0, 255).astype(np.uint8)

    def _save_composite(self):
        if not self.channels:
            return
        path = filedialog.asksaveasfilename(
            title="Save Composite", defaultextension=".tif",
            filetypes=[("TIFF", "*.tif"), ("PNG", "*.png")],
            initialfile=f"{self.current_file}_composite.tif")
        if not path:
            return
        self.status_var.set("Rendering full-res composite..."); self.update_idletasks()
        def _do():
            try:
                rgb = self._render_fullres()
                if rgb is not None:
                    save_composite_tif(path, rgb, int(self.dpi_var.get()))
                self.after(0, lambda: self.status_var.set(
                    f"Saved → {os.path.basename(path)}"))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Error", str(e)))
        threading.Thread(target=_do, daemon=True).start()

    def _save_all_rois(self):
        if not self.channels or not self.rois:
            messagebox.showinfo("No data", "Load an image and draw ROIs first.")
            return
        base = filedialog.askdirectory(title="Save ROI images to")
        if not base:
            return
        self.status_var.set("Saving ROIs..."); self.update_idletasks()
        params_list = [c.get_params() for c in self.channel_controls]
        ds = self.channels[0].ds_factor

        def _do():
            try:
                c0 = self.channels[0]
                for roi in self.rois:
                    rf = os.path.join(base, roi.name)
                    os.makedirs(rf, exist_ok=True)
                    x1, y1, x2, y2 = roi.bbox
                    fx1 = max(0, int(x1 * ds))
                    fy1 = max(0, int(y1 * ds))
                    fx2 = min(c0.full_w, int(x2 * ds))
                    fy2 = min(c0.full_h, int(y2 * ds))
                    if fx2 <= fx1 or fy2 <= fy1:
                        continue
                    rgb = self._render_fullres(
                        region=(fx1, fy1, fx2, fy2), params_list=params_list)
                    if rgb is not None:
                        rh, rw = rgb.shape[:2]
                        if roi.roi_type != "rect":
                            mask_local = roi.get_mask(
                                c0.full_h, c0.full_w, ds)[fy1:fy1 + rh, fx1:fx1 + rw]
                            for ci in range(3):
                                rgb[:, :, ci] = rgb[:, :, ci] * mask_local
                        Image.fromarray(rgb).save(
                            os.path.join(rf, f"{roi.name}-merged.tif"))
                    # Build ROI mask once for per-channel exports
                    rh_ch, rw_ch = fy2 - fy1, fx2 - fx1
                    if roi.roi_type != "rect":
                        ch_mask = roi.get_mask(
                            c0.full_h, c0.full_w, ds)[fy1:fy1 + rh_ch, fx1:fx1 + rw_ch]
                    else:
                        ch_mask = None

                    # ── Per-channel images ──
                    ch_names_list = []
                    ch_means = []
                    ch_sems = []
                    ch_colors_hex = []

                    for i, (cd, p) in enumerate(zip(self.channels, params_list)):
                        if not p["visible"]:
                            continue
                        cd_ = cd.full_data[fy1:fy2, fx1:fx2].astype(np.float64)
                        cmin, cmax = p["min"], p["max"]
                        if cmax <= cmin:
                            cmax = cmin + 1
                        cn = np.clip((cd_ - cmin) / (cmax - cmin), 0, 1) * p["brightness"]
                        np.clip(cn, 0, 1, out=cn)
                        r, g, b = p["color"]
                        fh, fw = cd_.shape
                        cr = np.zeros((fh, fw, 3), dtype=np.uint8)
                        cr[:, :, 0] = np.clip(cn * r, 0, 255).astype(np.uint8)
                        cr[:, :, 1] = np.clip(cn * g, 0, 255).astype(np.uint8)
                        cr[:, :, 2] = np.clip(cn * b, 0, 255).astype(np.uint8)
                        if ch_mask is not None:
                            m = ch_mask[:fh, :fw]
                            for ci in range(3):
                                cr[:, :, ci] = cr[:, :, ci] * m
                        Image.fromarray(cr).save(
                            os.path.join(rf, f"{roi.name}-{p.get('name', f'ch{i+1}')}.tif"))

                        # Collect stats (inside ROI mask)
                        if ch_mask is not None:
                            pixels = cn[ch_mask[:fh, :fw] > 0]
                        else:
                            pixels = cn.ravel()
                        nz = pixels[pixels > 0.01]
                        ch_name = p.get("name", f"Ch{i+1}")
                        ch_names_list.append(ch_name)
                        ch_colors_hex.append(f"#{r:02x}{g:02x}{b:02x}")
                        if len(nz) > 10:
                            ch_means.append(float(np.mean(nz)))
                            ch_sems.append(float(np.std(nz) / np.sqrt(len(nz))))
                        else:
                            ch_means.append(0.0)
                            ch_sems.append(0.0)

                    # ── CSV stats ──
                    import csv
                    csv_path = os.path.join(rf, f"{roi.name}-stats.csv")
                    with open(csv_path, "w", newline="") as f:
                        w = csv.writer(f)
                        w.writerow(["Channel", "Mean_Intensity", "SEM",
                                    "Std", "Median", "Min", "Max", "N_pixels"])
                        for i, (cd, p) in enumerate(zip(self.channels, params_list)):
                            if not p["visible"]:
                                continue
                            cd_ = cd.full_data[fy1:fy2, fx1:fx2].astype(np.float64)
                            if ch_mask is not None:
                                pixels = cd_[ch_mask[:cd_.shape[0], :cd_.shape[1]] > 0]
                            else:
                                pixels = cd_.ravel()
                            nz = pixels[pixels > 0]
                            nm = p.get("name", f"Ch{i+1}")
                            if len(nz) > 0:
                                w.writerow([nm,
                                            f"{np.mean(nz):.2f}",
                                            f"{np.std(nz)/np.sqrt(len(nz)):.4f}",
                                            f"{np.std(nz):.2f}",
                                            f"{np.median(nz):.2f}",
                                            f"{np.min(nz):.2f}",
                                            f"{np.max(nz):.2f}",
                                            len(nz)])
                            else:
                                w.writerow([nm, 0, 0, 0, 0, 0, 0, 0])

                    # ── Bar graph PNG ──
                    try:
                        import matplotlib
                        matplotlib.use("Agg")
                        import matplotlib.pyplot as plt
                        fig, ax = plt.subplots(figsize=(5, 3.5), dpi=150)
                        fig.patch.set_facecolor("white")
                        x_pos = range(len(ch_names_list))
                        bars = ax.bar(x_pos, ch_means, yerr=ch_sems,
                                      color=ch_colors_hex, edgecolor="#333333",
                                      capsize=4, error_kw={"linewidth": 1.5})
                        ax.set_xticks(x_pos)
                        ax.set_xticklabels(ch_names_list, fontsize=11,
                                           fontweight="bold")
                        ax.set_ylabel("Mean Intensity", fontsize=12,
                                      fontweight="bold")
                        ax.set_title(f"{roi.name} \u2014 Channel Intensities",
                                     fontsize=13, fontweight="bold")
                        ax.tick_params(axis="y", labelsize=10)
                        for bar, val in zip(bars, ch_means):
                            ax.text(bar.get_x() + bar.get_width() / 2,
                                    bar.get_height(), f"{val:.2f}",
                                    ha="center", va="bottom", fontsize=9,
                                    fontweight="bold")
                        ax.spines["top"].set_visible(False)
                        ax.spines["right"].set_visible(False)
                        fig.tight_layout()
                        fig.savefig(os.path.join(rf, f"{roi.name}-analysis.png"),
                                    dpi=150, bbox_inches="tight")
                        plt.close(fig)
                    except Exception:
                        pass

                    # ── Notes text file ──
                    roi_notes = [a for a in annotations_copy
                                 if a.linked_roi == roi.name]
                    # Also include notes positioned inside this ROI
                    for a in annotations_copy:
                        if a.linked_roi is None:
                            if (x1 <= a.x <= x2 and y1 <= a.y <= y2
                                    and a not in roi_notes):
                                roi_notes.append(a)
                    if roi_notes:
                        notes_path = os.path.join(rf, f"{roi.name}-notes.txt")
                        with open(notes_path, "w") as f:
                            f.write(f"Notes for {roi.name}\n")
                            f.write(f"{'=' * 40}\n\n")
                            for a in roi_notes:
                                f.write(f"[{a.author}] {a.pretty_time()}\n")
                                f.write(f"{a.text}\n")
                                for rep in a.replies:
                                    f.write(f"  \u21b3 [{rep.author}] "
                                            f"{rep.pretty_time()}: {rep.text}\n")
                                f.write("\n")

                self.after(0, lambda: self.status_var.set(
                    f"\u2705 Saved {len(self.rois)} ROIs "
                    f"(images + CSV + graphs + notes)"))
            except Exception as ex:
                err = str(ex)
                self.after(0, lambda: messagebox.showerror("Error", err))

        # Capture annotations in main thread (thread safety)
        annotations_copy = list(self.annotations)
        threading.Thread(target=_do, daemon=True).start()

    def _export_csv(self):
        if not self.channels:
            return
        path = filedialog.asksaveasfilename(
            title="Export CSV", defaultextension=".csv",
            filetypes=[("CSV", "*.csv")],
            initialfile=f"{self.current_file or 'analysis'}_stats.csv")
        if not path:
            return
        params_list = [c.get_params() for c in self.channel_controls]
        export_roi_csv(path, self.channels, params_list, self.rois, self.annotations)
        self.status_var.set(f"CSV → {os.path.basename(path)}")

    # ══════════════════════════════════════════════════════════════════
    #  POPUPS
    # ══════════════════════════════════════════════════════════════════

    def _open_mask_popup(self):
        """Toggle brush mask mode on the main canvas."""
        if not self.channels:
            return
        self._toggle_brush_mode()

    def _toggle_brush_mode(self):
        """Toggle brush painting mode on/off."""
        self.brush_mode_active = not self.brush_mode_active
        if self.brush_mode_active:
            # Initialize mask if needed
            if self.brush_mask is None or self.brush_mask.shape != self.channels[0].preview.shape:
                h, w = self.channels[0].preview.shape
                self.brush_mask = np.zeros((h, w), dtype=np.float32)
            self._brush_frame.grid(row=2, column=0, sticky="ew")
            self.canvas.config(cursor="circle")
            self._brush_populate_channels()
            self.status_var.set("Brush mode ON — paint mask, adjust channels, Apply to commit")
        else:
            self._brush_frame.grid_forget()
            self.canvas.config(cursor="crosshair")
            self.status_var.set("Brush mode OFF")
        self._schedule_update()

    def _brush_populate_channels(self):
        """Populate per-channel adjustment cards in the brush panel."""
        for w in self._brush_ch_frame.winfo_children():
            w.destroy()
        self._brush_ch_vars.clear()
        if not self.channel_controls:
            return

        def _on_slider_change(*args):
            self._schedule_update()

        for i, ctrl in enumerate(self.channel_controls):
            p = ctrl.get_params()
            card = ctk.CTkFrame(self._brush_ch_frame, corner_radius=8,
                                fg_color="#16181f", border_width=1,
                                border_color="#2c2e36", width=180)
            card.pack(side="left", padx=3, pady=2, fill="y")

            nm = p.get("name", f"Ch{i+1}")
            if len(nm) > 14:
                nm = nm[:13] + "…"
            r_c, g_c, b_c = p["color"]
            ch_color = f"#{r_c:02x}{g_c:02x}{b_c:02x}"
            ctk.CTkLabel(card, text=nm, font=ctk.CTkFont(size=10, weight="bold"),
                         text_color=ch_color).pack(padx=6, pady=(4, 2))

            d = {"index": i}
            dm = float(self.channels[i].preview.max()) if i < len(self.channels) else 65535
            for lbl, key, val, lo, hi in [
                ("Min",        "min",   p["min"],           0,   dm),
                ("Max",        "max",   p["max"],           0,   dm),
                ("Brightness", "brt",   p["brightness"],    0,   3.0),
                ("Gamma",      "gamma", p.get("gamma", 1.0), 0.1, 5.0),
            ]:
                row = ctk.CTkFrame(card, fg_color="transparent")
                row.pack(fill="x", padx=4, pady=0)
                ctk.CTkLabel(row, text=lbl, width=55,
                             font=ctk.CTkFont(size=9),
                             text_color="#8e8e93", anchor="w").pack(side="left")
                v = tk.DoubleVar(value=val)
                ctk.CTkSlider(row, from_=lo, to=hi, variable=v,
                              height=12, width=70,
                              command=lambda val, *a: self._schedule_update()).pack(
                    side="left", padx=2)
                vl = ctk.CTkLabel(row, text=f"{val:.1f}", width=35,
                                  font=ctk.CTkFont(size=8),
                                  text_color="#e5e5ea")
                vl.pack(side="left")
                v.trace_add("write",
                    lambda *a, var=v, label=vl: label.configure(
                        text=f"{var.get():.1f}"))
                d[key] = v

            ctk.CTkButton(card, text="\u2705 Apply to Mask", width=100, height=22,
                          font=ctk.CTkFont(size=9),
                          fg_color="#30d158", hover_color="#28b04d",
                          command=lambda idx=i: self._brush_apply_channel(idx)).pack(
                pady=(3, 5))
            self._brush_ch_vars.append(d)

    def _brush_apply_channel(self, idx):
        """Apply adjustments to channel preview inside the mask (fast)."""
        if idx >= len(self._brush_ch_vars) or idx >= len(self.channels):
            return
        if self.brush_mask is None:
            return
        d = self._brush_ch_vars[idx]
        ch = self.channels[idx]

        mask = self.brush_mask
        ph, pw = ch.preview.shape
        m = mask[:ph, :pw]
        mask_px = m > 0.5
        if not mask_px.any():
            self.status_var.set("No masked area to apply")
            return

        mn_ = d["min"].get()
        mx_ = d["max"].get()
        brt_ = d["brt"].get()
        gam_ = d["gamma"].get()
        rng = max(1, mx_ - mn_)

        # Apply to preview (instant)
        px = ch.preview[mask_px].astype(np.float64)
        normed = np.clip((px - mn_) / rng, 0, 1)
        if abs(gam_ - 1.0) > 0.01:
            normed = np.power(normed, 1.0 / max(0.01, gam_))
        normed *= brt_
        np.clip(normed, 0, 1, out=normed)
        prev_max = float(ch.preview.max()) or 65535
        alpha = m[mask_px]
        ch.preview[mask_px] = (px * (1 - alpha) + normed * prev_max * alpha).astype(
            ch.preview.dtype)

        # Apply to full_data in background thread (non-blocking)
        ds = ch.ds_factor
        self.status_var.set(f"\u23F3 Applying to full-res ({ch.full_h}x{ch.full_w})...")
        self.update_idletasks()

        def _bg():
            try:
                from scipy.ndimage import zoom as sz
                if ds > 1:
                    fm = sz(mask, ds, order=0)[:ch.full_h, :ch.full_w]
                else:
                    fm = mask[:ch.full_h, :ch.full_w]
                fp = fm > 0.5
                if fp.any():
                    fd = ch.full_data[fp].astype(np.float64)
                    fn = np.clip((fd - mn_) / rng, 0, 1)
                    if abs(gam_ - 1.0) > 0.01:
                        fn = np.power(fn, 1.0 / max(0.01, gam_))
                    fn *= brt_; np.clip(fn, 0, 1, out=fn)
                    fmax = float(ch.full_data.max()) or 65535
                    fa = fm[fp]
                    ch.full_data[fp] = (fd * (1 - fa) + fn * fmax * fa).astype(
                        ch.full_data.dtype)
                nm = self.channel_controls[idx].get_params().get("name", f"Ch{idx+1}")
                self.after(0, lambda: self.status_var.set(f"\u2705 Applied to {nm}"))
            except Exception as ex:
                self.after(0, lambda: self.status_var.set(f"\u274C Apply failed: {ex}"))
        threading.Thread(target=_bg, daemon=True).start()

        # Invalidate tile cache so preview updates immediately
        if self._renderer:
            self._renderer.invalidate()
        self._schedule_update()

    def _brush_apply_all(self):
        """Apply mask adjustments to all channels."""
        for i in range(len(self._brush_ch_vars)):
            self._brush_apply_channel(i)
        self.status_var.set("\u2705 Applied to all channels")

    def _brush_paint_at(self, sx, sy):
        """Paint or erase at screen coords."""
        px, py = self._canvas_to_image(sx, sy)
        if px is None or self.brush_mask is None:
            return
        h, w = self.brush_mask.shape
        bs = max(1, int(self.brush_size / max(0.01, self.zoom_level)))
        ix, iy = int(px), int(py)
        y1, y2 = max(0, iy - bs), min(h, iy + bs)
        x1, x2 = max(0, ix - bs), min(w, ix + bs)
        if y2 <= y1 or x2 <= x1:
            return
        yy, xx = np.ogrid[y1:y2, x1:x2]
        dist = np.sqrt((yy - iy) ** 2 + (xx - ix) ** 2)
        circle = dist <= bs
        if not self.brush_erase:
            self.brush_mask[y1:y2, x1:x2][circle] = 1.0
        else:
            self.brush_mask[y1:y2, x1:x2][circle] = 0.0
        # Update percentage
        try:
            pct = 100.0 * np.sum(self.brush_mask > 0.5) / max(1, self.brush_mask.size)
            self._brush_pct_label.configure(text=f"{pct:.1f}%")
        except Exception:
            pass
        self._schedule_update()

    def _brush_save_undo(self):
        if self.brush_mask is not None:
            self._brush_history.append(self.brush_mask.copy())
            if len(self._brush_history) > 30:
                self._brush_history.pop(0)

    def _brush_undo(self):
        if self._brush_history:
            self.brush_mask = self._brush_history.pop()
            self._schedule_update()

    def _brush_clear(self):
        if self.brush_mask is not None:
            self._brush_save_undo()
            self.brush_mask[:] = 0
            self._brush_pct_label.configure(text="0%")
            self._schedule_update()

    # ══════════════════════════════════════════════════════════════════
    #  CELL GROUP BRUSH
    # ══════════════════════════════════════════════════════════════════

    def _toggle_cell_brush(self):
        """Toggle cell group brush mode."""
        if self.seg_mask is None:
            from tkinter import messagebox
            messagebox.showinfo("No segmentation",
                                "Run segmentation or import a mask first.",
                                parent=self)
            return
        self.cell_brush_active = not self.cell_brush_active
        if self.cell_brush_active:
            self._cell_brush_frame.grid(row=3, column=0, sticky="ew")
            self.canvas.config(cursor="target")
            self.current_cell_group = self._cell_group_entry.get().strip() or "Group 1"
            self.status_var.set(
                f"Cell brush ON — paint to select cells → \"{self.current_cell_group}\"")
        else:
            self._cell_brush_frame.grid_forget()
            self.canvas.config(cursor="crosshair")
            self.status_var.set("Cell brush OFF")
        self._schedule_update()

    def _cell_brush_new_group(self):
        """Create a new group name from the entry field."""
        name = self._cell_group_entry.get().strip()
        if not name:
            return
        self.current_cell_group = name
        if name not in self.cell_groups:
            self.cell_groups[name] = set()
        self._update_cell_group_list()
        self.status_var.set(f"Painting cells → \"{name}\"")

    def _cell_brush_paint_at(self, sx, sy):
        """Select cells under the brush cursor and add to current group."""
        if self.seg_mask is None:
            return
        px, py = self._canvas_to_image(sx, sy)
        if px is None:
            return
        ds = self.channels[0].ds_factor if self.channels else 1
        # Find full-res coords
        fx, fy = int(px * ds), int(py * ds)
        fh, fw = self.seg_mask.shape
        bs = max(1, int(self.cell_brush_size / self.zoom_level * ds))
        y1 = max(0, fy - bs); y2 = min(fh, fy + bs)
        x1 = max(0, fx - bs); x2 = min(fw, fx + bs)
        if y2 <= y1 or x2 <= x1:
            return
        region = self.seg_mask[y1:y2, x1:x2]
        cell_ids = set(np.unique(region))
        cell_ids.discard(0)  # remove background
        if not cell_ids:
            return
        name = self.current_cell_group
        if name not in self.cell_groups:
            self.cell_groups[name] = set()
        self.cell_groups[name] |= cell_ids
        self._update_cell_group_list()
        self._schedule_update()

    def _update_cell_group_list(self):
        """Refresh the group list display in the cell brush panel."""
        for w in self._cell_group_list_frame.winfo_children():
            w.destroy()
        if not self.cell_groups:
            ctk.CTkLabel(self._cell_group_list_frame, text="Groups: (none yet)",
                         font=ctk.CTkFont(size=9), text_color="#48494e").pack(side="left")
            return
        ctk.CTkLabel(self._cell_group_list_frame, text="Groups:",
                     font=ctk.CTkFont(size=9, weight="bold"),
                     text_color="#8e8e93").pack(side="left", padx=(0, 4))
        for gname, cids in self.cell_groups.items():
            color = "#30d158" if gname == self.current_cell_group else "#8e8e93"
            ctk.CTkButton(self._cell_group_list_frame,
                          text=f"{gname} ({len(cids)})",
                          width=80, height=20,
                          font=ctk.CTkFont(size=9),
                          fg_color="#2c2e36", hover_color="#30d158",
                          text_color=color,
                          command=lambda n=gname: self._select_cell_group(n)).pack(
                side="left", padx=1)

    def _select_cell_group(self, name):
        """Switch to an existing group for painting."""
        self.current_cell_group = name
        self._cell_group_entry.delete(0, "end")
        self._cell_group_entry.insert(0, name)
        self._update_cell_group_list()
        self.status_var.set(f"Painting cells → \"{name}\" ({len(self.cell_groups.get(name, set()))} cells)")

    def _render_cell_group_overlay(self, comp):
        """Overlay cell groups with distinct colors on the composite."""
        if not self.cell_groups or self.seg_mask is None:
            return comp
        import colorsys
        ds = self.channels[0].ds_factor if self.channels else 1
        seg_ds = self.seg_mask[::ds, ::ds]
        sh, sw = comp.shape[:2]
        seg_ds = seg_ds[:sh, :sw]
        overlay = comp.copy()
        group_colors = [
            (76, 217, 100), (255, 69, 58), (0, 122, 255),
            (255, 159, 10), (191, 90, 242), (255, 214, 10),
            (48, 209, 88), (94, 92, 230), (255, 55, 95),
            (100, 210, 255)
        ]
        for gi, (gname, cids) in enumerate(self.cell_groups.items()):
            gc = group_colors[gi % len(group_colors)]
            for cid in cids:
                mask = seg_ds == cid
                if mask.any():
                    overlay[mask, 0] = np.clip(
                        overlay[mask, 0].astype(np.int16) * 0.5 + gc[0] * 0.5,
                        0, 255).astype(np.uint8)
                    overlay[mask, 1] = np.clip(
                        overlay[mask, 1].astype(np.int16) * 0.5 + gc[1] * 0.5,
                        0, 255).astype(np.uint8)
                    overlay[mask, 2] = np.clip(
                        overlay[mask, 2].astype(np.int16) * 0.5 + gc[2] * 0.5,
                        0, 255).astype(np.uint8)
        return overlay

    def _open_cell_group_analysis(self):
        """Open the cell group box plot analysis window."""
        if not self.cell_groups:
            from tkinter import messagebox
            messagebox.showinfo("No groups",
                                "Use the Grp cell brush to select cells into groups first.",
                                parent=self)
            return
        if self.seg_mask is None:
            from tkinter import messagebox
            messagebox.showinfo("No segmentation",
                                "Run segmentation or import a mask first.",
                                parent=self)
            return
        from fluoroview.analysis.cell_group_analysis import CellGroupAnalysis
        CellGroupAnalysis(self, self.channels, self.channel_controls,
                          self.seg_mask, self.cell_groups)

    # ══════════════════════════════════════════════════════════════════
    #  SEGMENTATION
    # ══════════════════════════════════════════════════════════════════

    def _segmentation_menu(self):
        T = THEME
        menu = tk.Menu(self, tearoff=0, bg=T["BG3"], fg=T["FG"],
                       activebackground="#0a84ff", activeforeground="#ffffff",
                       font=("SF Pro Display", 11), relief="flat", bd=1)
        menu.add_command(label="\U0001F4C2  Import mask (TIFF)...",
                         command=self._import_mask)
        menu.add_separator()
        from fluoroview.segmentation import HAS_CELLPOSE, HAS_DEEPCELL
        if HAS_CELLPOSE:
            from fluoroview.segmentation.cellpose_seg import CELLPOSE_MODELS
            menu.add_command(
                label="\U0001F9EA  Cellpose: whole image",
                command=lambda: self._run_cellpose("cyto3"))
            if self.rois:
                menu.add_command(
                    label=f"\U0001F9EA  Cellpose: {len(self.rois)} ROI(s) only",
                    command=lambda: self._run_cellpose("cyto3", rois_only=True))
            sub = tk.Menu(menu, tearoff=0, bg=T["BG3"], fg=T["FG"],
                          activebackground="#0e3a4a", activeforeground=T["ACCENT"])
            for m in CELLPOSE_MODELS:
                sub.add_command(label=m,
                                command=lambda model=m: self._run_cellpose(model))
            menu.add_cascade(label="\u2699  More models...", menu=sub)
        else:
            menu.add_command(
                label="\U0001F9EA  Cellpose (install: pip install cellpose)",
                command=self._install_cellpose)
        menu.add_separator()
        if HAS_DEEPCELL:
            menu.add_command(label="\U0001F52C  DeepCell Mesmer",
                             command=self._run_deepcell)
        if self.seg_mask is not None:
            menu.add_separator()
            menu.add_command(label="\u2715  Clear segmentation",
                             command=self._clear_seg)
        menu.tk_popup(self.winfo_pointerx(), self.winfo_pointery())

    def _install_cellpose(self):
        self.status_var.set("\u23F3 Installing Cellpose...")
        self.update_idletasks()
        def _do():
            import subprocess, sys
            try:
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", "cellpose"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.after(0, lambda: self.status_var.set(
                    "\u2705 Cellpose installed! Click Seg again to use it."))
            except Exception:
                self.after(0, lambda: self.status_var.set(
                    "\u274C Cellpose install failed. Try: pip install cellpose"))
        threading.Thread(target=_do, daemon=True).start()

    def _import_mask(self):
        path = filedialog.askopenfilename(
            title="Import Segmentation Mask",
            filetypes=[("TIFF", "*.tif *.tiff"), ("All", "*.*")])
        if not path:
            return
        from fluoroview.segmentation.mask_import import load_mask
        try:
            self.seg_mask = load_mask(path)
            self.seg_overlay_var.set(True)
            self._schedule_update()
            n = int(self.seg_mask.max())
            self.status_var.set(f"\u2705 Loaded mask \u2014 {n} cells")
        except Exception as ex:
            messagebox.showerror("Error", str(ex))

    def _run_cellpose(self, model_type: str = "cyto3", rois_only: bool = False):
        """Run Cellpose segmentation — full image or within ROIs."""
        if not self.channels:
            messagebox.showinfo("No data", "Load an image first.")
            return
        if rois_only and not self.rois:
            messagebox.showinfo("No ROIs", "Draw ROIs first.")
            return
        from tkinter import simpledialog
        nuc_idx = simpledialog.askinteger(
            "Nuclear channel",
            "DAPI / nuclear channel (1-based):",
            initialvalue=1, minvalue=1,
            maxvalue=len(self.channels), parent=self)
        if nuc_idx is None:
            return
        mem_idx = None
        if len(self.channels) >= 2 and model_type not in ("nuclei",):
            mem_idx = simpledialog.askinteger(
                "Membrane channel",
                "Membrane channel (1-based), or Cancel for nuclei-only:",
                initialvalue=2, minvalue=1,
                maxvalue=len(self.channels), parent=self)

        scope = f"{len(self.rois)} ROI(s)" if rois_only else "whole image"
        self.status_var.set(f"\u23F3 Cellpose ({model_type}) on {scope}...")
        self.update_idletasks()
        ds = self.channels[0].ds_factor
        rois_copy = list(self.rois) if rois_only else None

        def _run():
            try:
                from fluoroview.segmentation.cellpose_seg import CellposeSegmenter
                seg = CellposeSegmenter(model_type=model_type)
                ch0 = self.channels[0]
                full_h, full_w = ch0.full_h, ch0.full_w
                nuc_full = self.channels[nuc_idx - 1].full_data
                mem_full = self.channels[mem_idx - 1].full_data if mem_idx else None

                if rois_copy:
                    combined = np.zeros((full_h, full_w), dtype=np.int32)
                    cell_offset = 0
                    for roi in rois_copy:
                        x1, y1, x2, y2 = roi.bbox
                        fx1, fy1 = int(x1 * ds), int(y1 * ds)
                        fx2, fy2 = int(x2 * ds), int(y2 * ds)
                        fx1 = max(0, fx1); fy1 = max(0, fy1)
                        fx2 = min(full_w, fx2); fy2 = min(full_h, fy2)
                        nuc_r = nuc_full[fy1:fy2, fx1:fx2].astype(np.float32)
                        mem_r = mem_full[fy1:fy2, fx1:fx2].astype(np.float32) if mem_full is not None else None
                        m = seg.segment(nuc_r, mem_r)
                        m[m > 0] += cell_offset
                        cell_offset = int(m.max())
                        combined[fy1:fy2, fx1:fx2] = np.maximum(
                            combined[fy1:fy2, fx1:fx2], m)
                    mask = combined
                else:
                    nuc = nuc_full[:, :].astype(np.float32)
                    mem = mem_full[:, :].astype(np.float32) if mem_full is not None else None
                    mask = seg.segment(nuc, mem)

                self.seg_mask = mask
                self.cell_data = None
                self.seg_overlay_var.set(True)
                n = int(mask.max())
                self.after(0, lambda n=n: self.status_var.set(
                    f"\u2705 Cellpose ({model_type}) \u2014 {n} cells on {scope}"))
                self.after(0, self._schedule_update)
            except Exception as ex:
                err_msg = str(ex)
                self.after(0, lambda: messagebox.showerror("Segmentation Error", err_msg))
                self.after(0, lambda: self.status_var.set("\u274C Segmentation failed"))
        threading.Thread(target=_run, daemon=True).start()

    def _run_deepcell(self):
        if not self.channels or len(self.channels) < 2:
            messagebox.showinfo("Need channels",
                                "At least 2 channels (nuclear + membrane) required.")
            return
        from tkinter import simpledialog
        nuc_idx = simpledialog.askinteger("Nuclear channel",
                                          "DAPI/nuclear (1-based):",
                                          initialvalue=1, minvalue=1,
                                          maxvalue=len(self.channels), parent=self)
        mem_idx = simpledialog.askinteger("Membrane channel",
                                          "Membrane (1-based):",
                                          initialvalue=2, minvalue=1,
                                          maxvalue=len(self.channels), parent=self)
        if nuc_idx is None or mem_idx is None:
            return
        self.status_var.set("\u23F3 Running DeepCell Mesmer...")
        self.update_idletasks()
        def _run():
            try:
                from fluoroview.segmentation.deepcell_seg import DeepCellSegmenter
                seg = DeepCellSegmenter()
                nuc = self.channels[nuc_idx - 1].full_data[:, :].astype(np.float32)
                mem = self.channels[mem_idx - 1].full_data[:, :].astype(np.float32)
                mask = seg.segment(nuc, mem)
                self.seg_mask = mask
                self.cell_data = None
                self.seg_overlay_var.set(True)
                n = int(mask.max())
                self.after(0, lambda n=n: self.status_var.set(
                    f"\u2705 DeepCell \u2014 {n} cells"))
                self.after(0, self._schedule_update)
            except Exception as ex:
                err_msg = str(ex)
                self.after(0, lambda: messagebox.showerror("Segmentation Error", err_msg))
                self.after(0, lambda: self.status_var.set("\u274C Segmentation failed"))
        threading.Thread(target=_run, daemon=True).start()

    def _clear_seg(self):
        self.seg_mask = None; self.cell_data = None
        self.seg_overlay_var.set(False)
        self._schedule_update()
        self.status_var.set("Segmentation cleared")

    # ══════════════════════════════════════════════════════════════════
    #  SINGLE-CELL ANALYSIS
    # ══════════════════════════════════════════════════════════════════

    def _open_cell_analysis(self):
        if self.seg_mask is None:
            messagebox.showinfo("No segmentation",
                                "Import or run segmentation first (Seg button).")
            return
        if self.cell_data is None:
            self.status_var.set("Quantifying cells...")
            self.update_idletasks()
            from fluoroview.analysis.quantification import quantify_cells
            params_list = [c.get_params() for c in self.channel_controls]
            ch_names = [p.get("name", f"ch{i + 1}") for i, p in enumerate(params_list)]
            ch_arrays = [cd.full_data for cd in self.channels]
            self.cell_data = quantify_cells(self.seg_mask, ch_arrays, ch_names)
            self.status_var.set(f"Quantified {len(self.cell_data['cell_id'])} cells")

        params_list = [c.get_params() for c in self.channel_controls]
        ch_names = [p.get("name", f"ch{i + 1}") for i, p in enumerate(params_list)]
        from fluoroview.ui.popups.cell_analysis import CellAnalysisPopup
        CellAnalysisPopup(self, self.cell_data, self.seg_mask, ch_names)

    # ══════════════════════════════════════════════════════════════════
    #  AI ASSISTANT
    # ══════════════════════════════════════════════════════════════════

    def _open_ai_chat(self):
        """Focus the AI chat input in the left sidebar."""
        if hasattr(self, '_ai_chat_panel') and hasattr(self._ai_chat_panel, '_input_entry'):
            self._ai_chat_panel._input_entry.focus_set()
            self.status_var.set("AI chat ready")


# ── Load UI fonts once (fixed screen-space size) ────────────────────

def _load_ui_font(size: int):
    import platform as _pf
    _candidates = []
    if _pf.system() == "Darwin":
        _candidates = [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
    elif _pf.system() == "Windows":
        _candidates = [
            "C:/Windows/Fonts/arialbd.ttf",
            "C:/Windows/Fonts/arial.ttf",
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/calibri.ttf",
        ]
    else:
        _candidates = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ]
    # Also try by name (works cross-platform if font is installed)
    _candidates += ["Arial Bold", "Arial", "DejaVu Sans", "Segoe UI"]
    for p in _candidates:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()

FluoroView._label_font = _load_ui_font(13)
FluoroView._label_font_sm = _load_ui_font(11)


# ══════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ══════════════════════════════════════════════════════════════════════

def main():
    app = FluoroView()
    app.mainloop()


if __name__ == "__main__":
    main()

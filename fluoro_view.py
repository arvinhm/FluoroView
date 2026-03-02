#!/usr/bin/env python3
"""
FluoroView — High-Performance Fluorescence Image Viewer for macOS
Memory-mapped TIF loading, per-channel IF colors, contrast/brightness,
overlay compositing, ROI selection, publication-quality export.
"""

import os
import sys
import glob
import threading
import tempfile
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, colorchooser
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import tifffile
from PIL import Image, ImageTk, ImageDraw, ImageFont

# ─── Constants ────────────────────────────────────────────────────────────────

MAX_PREVIEW_DIM = 2500  # max pixels for interactive preview (higher = sharper zoom)
NUM_WORKERS = os.cpu_count() or 4

IF_COLORS = {
    "Blue (DAPI)":    (0, 100, 255),
    "Green (FITC)":   (0, 255, 0),
    "Red (Cy5)":      (255, 0, 0),
    "Orange":         (255, 165, 0),
    "Magenta (Cy3)":  (255, 0, 255),
    "Cyan":           (0, 255, 255),
    "Yellow":         (255, 255, 0),
    "White":          (255, 255, 255),
    "Hot Pink":       (255, 50, 120),
}

DEFAULT_COLORS = ["Blue (DAPI)", "Green (FITC)", "Red (Cy5)", "Orange",
                  "Magenta (Cy3)", "Cyan", "Yellow", "White", "Hot Pink"]


# ─── ROI Data ─────────────────────────────────────────────────────────────────

class ROIData:
    """Represents a single ROI: rectangle, circle, or freehand polygon."""
    _counter = 0

    def __init__(self, roi_type, bbox, points=None, name=None):
        """
        roi_type: 'rect', 'circle', or 'freehand'
        bbox: (x1, y1, x2, y2) in preview coordinates
        points: list of (x, y) for freehand polygon
        """
        ROIData._counter += 1
        self.roi_type = roi_type
        self.bbox = bbox  # (x1,y1,x2,y2) preview coords
        self.points = points or []
        self.name = name or f"ROI-{ROIData._counter}"

    def get_mask(self, h, w, ds_factor=1):
        """Return boolean mask of shape (h, w) for this ROI.
        Coordinates are in preview space; ds_factor scales to target resolution."""
        mask = np.zeros((h, w), dtype=bool)
        x1, y1, x2, y2 = self.bbox
        # Scale from preview to target
        sx1 = max(0, int(x1 * ds_factor))
        sy1 = max(0, int(y1 * ds_factor))
        sx2 = min(w, int(x2 * ds_factor))
        sy2 = min(h, int(y2 * ds_factor))

        if self.roi_type == 'rect':
            mask[sy1:sy2, sx1:sx2] = True
        elif self.roi_type == 'circle':
            cy = (sy1 + sy2) / 2
            cx = (sx1 + sx2) / 2
            ry = (sy2 - sy1) / 2
            rx = (sx2 - sx1) / 2
            yy, xx = np.ogrid[:h, :w]
            ellipse = ((xx - cx) / max(1, rx)) ** 2 + ((yy - cy) / max(1, ry)) ** 2
            mask[ellipse <= 1.0] = True
        elif self.roi_type == 'freehand' and self.points:
            from PIL import ImageDraw as ID2
            img = Image.new('L', (w, h), 0)
            scaled_pts = [(int(px * ds_factor), int(py * ds_factor)) for px, py in self.points]
            if len(scaled_pts) > 2:
                ID2.Draw(img).polygon(scaled_pts, fill=255)
            mask = np.array(img) > 127
        return mask


# ─── Image Loader ─────────────────────────────────────────────────────────────

class ChannelData:
    """Holds one channel: memory-mapped full-res + downsampled preview."""

    def __init__(self, path, full_data, preview, ds_factor, vmin, vmax):
        self.path = path
        self.original_path = path   # remember original for reference
        self.full_data = full_data      # memmap or ndarray, full resolution
        self.preview = preview          # float32 downsampled array
        self.ds_factor = ds_factor
        self.vmin = vmin                # data min
        self.vmax = vmax                # data max
        self.full_h, self.full_w = full_data.shape
        self.is_edited = False          # has temp edits been applied?

    def reload_from(self, new_path):
        """Reload channel data from a new file (temp edited version)."""
        try:
            full = tifffile.memmap(new_path, mode='r')
        except Exception:
            full = tifffile.imread(new_path)
        while full.ndim > 2:
            full = full[0]
        self.full_data = full
        self.full_h, self.full_w = full.shape
        ds = max(1, max(self.full_h, self.full_w) // MAX_PREVIEW_DIM)
        self.ds_factor = ds
        self.preview = full[::ds, ::ds].astype(np.float32)
        self.path = new_path
        self.is_edited = True
        # Update percentiles
        sample_step = max(1, self.full_h // 500)
        sample = full[::sample_step, ::ds].astype(np.float32).ravel()
        nonzero = sample[sample > 0]
        if len(nonzero) > 100:
            self.vmin = float(np.percentile(nonzero, 0.5))
            self.vmax = float(np.percentile(nonzero, 99.5))
        else:
            self.vmin = float(self.preview.min())
            self.vmax = float(self.preview.max())


def load_channel(path, max_dim=MAX_PREVIEW_DIM):
    """Load a single-channel TIF with memory mapping and create downsampled preview."""
    try:
        # Try memory-mapped first
        full = tifffile.memmap(path, mode='r')
    except Exception:
        full = tifffile.imread(path)

    # Handle multi-dim: squeeze to 2D
    while full.ndim > 2:
        full = full[0]

    h, w = full.shape
    ds = max(1, max(h, w) // max_dim)

    # Downsample by slicing (fast, no interpolation needed for preview)
    preview = full[::ds, ::ds].astype(np.float32)

    # Compute percentile-based min/max for better contrast defaults
    # Sample a subset to avoid loading entire memmap
    sample_step = max(1, h // 500)
    sample = full[::sample_step, ::ds].astype(np.float32).ravel()
    nonzero = sample[sample > 0]
    if len(nonzero) > 100:
        vmin = float(np.percentile(nonzero, 0.5))
        vmax = float(np.percentile(nonzero, 99.5))
    else:
        vmin = float(preview.min())
        vmax = float(preview.max())

    return ChannelData(path, full, preview, ds, vmin, vmax)


def load_multichannel_tif(path, max_dim=MAX_PREVIEW_DIM):
    """Load a multi-channel TIF, return list of ChannelData."""
    try:
        img = tifffile.memmap(path, mode='r')
    except Exception:
        img = tifffile.imread(path)

    if img.ndim == 2:
        channels_data = [img]
    elif img.ndim == 3:
        if img.shape[0] <= 10:  # (C, H, W)
            channels_data = [img[c] for c in range(img.shape[0])]
        elif img.shape[2] <= 10:  # (H, W, C)
            channels_data = [img[:, :, c] for c in range(img.shape[2])]
        else:
            channels_data = [img]
    else:
        channels_data = [img[0]] if img.ndim > 2 else [img]

    results = []
    for i, ch_data in enumerate(channels_data):
        while ch_data.ndim > 2:
            ch_data = ch_data[0]
        h, w = ch_data.shape
        ds = max(1, max(h, w) // max_dim)
        preview = ch_data[::ds, ::ds].astype(np.float32)

        sample_step = max(1, h // 500)
        sample = ch_data[::sample_step, ::ds].astype(np.float32).ravel()
        nonzero = sample[sample > 0]
        if len(nonzero) > 100:
            vmin = float(np.percentile(nonzero, 0.5))
            vmax = float(np.percentile(nonzero, 99.5))
        else:
            vmin = float(preview.min())
            vmax = float(preview.max())

        results.append(ChannelData(
            path=path, full_data=ch_data, preview=preview,
            ds_factor=ds, vmin=vmin, vmax=vmax
        ))
    return results


def scan_folder(folder_path):
    """
    Scan folder for TIF files. Returns dict of {display_name: file_info}.
    file_info is either:
      - ('multi', path) for a multi-channel TIF
      - ('folder', [path1, path2, ...]) for a folder of single-channel TIFs
    """
    results = {}

    # Check for subfolders containing channel TIFs
    for entry in sorted(os.listdir(folder_path)):
        full = os.path.join(folder_path, entry)
        if os.path.isdir(full):
            tifs = sorted(glob.glob(os.path.join(full, "*.tif")) +
                         glob.glob(os.path.join(full, "*.tiff")))
            if tifs:
                results[entry] = ('folder', tifs)

    # Also check for TIFs directly in the folder
    for tif in sorted(glob.glob(os.path.join(folder_path, "*.tif")) +
                     glob.glob(os.path.join(folder_path, "*.tiff"))):
        basename = os.path.splitext(os.path.basename(tif))[0]
        if basename not in results:
            results[basename] = ('multi', tif)

    return results


# ─── Channel Control Widget ──────────────────────────────────────────────────

class ChannelControl(ttk.Frame):
    """Controls for a single channel: visibility, color, contrast, brightness."""

    def __init__(self, parent, index, name, vmin, vmax, data_max, on_change,
                 preview_data=None):
        super().__init__(parent, padding=4)
        self.index = index
        self.on_change = on_change
        self.data_max = data_max
        self._preview_data = preview_data

        # Row 0: visibility + name (editable) + color
        row0 = ttk.Frame(self)
        row0.pack(fill='x', pady=(0, 2))

        self.visible_var = tk.BooleanVar(value=True)
        cb = ttk.Checkbutton(row0, variable=self.visible_var, command=self._changed)
        cb.pack(side='left')

        self.name_var = tk.StringVar(value=name)
        name_entry = tk.Entry(row0, textvariable=self.name_var, width=10,
                             font=('Helvetica Neue', 11, 'bold'),
                             bg='#232437', fg='#e2e4f0', insertbackground='#e2e4f0',
                             relief='flat', bd=1, highlightthickness=1,
                             highlightcolor='#6c8eff', highlightbackground='#3a3b55')
        name_entry.pack(side='left', padx=4)

        # Color selector
        default_color = DEFAULT_COLORS[index % len(DEFAULT_COLORS)]
        self.color_var = tk.StringVar(value=default_color)
        color_menu = ttk.Combobox(row0, textvariable=self.color_var,
                                  values=list(IF_COLORS.keys()), width=14, state='readonly')
        color_menu.pack(side='right')
        color_menu.bind('<<ComboboxSelected>>', lambda e: self._changed())

        # Color preview swatch
        self.swatch = tk.Canvas(row0, width=18, height=18, highlightthickness=1)
        self.swatch.pack(side='right', padx=4)
        self._update_swatch()
        self.color_var.trace_add('write', lambda *a: self._update_swatch())

        # ── Histogram ──
        self.hist_canvas = tk.Canvas(self, width=200, height=40, bg='#1e1e2e',
                                     highlightthickness=0)
        self.hist_canvas.pack(fill='x', pady=(2, 1))
        if preview_data is not None:
            self.after(200, self._draw_histogram)

        # Row 1: Contrast (min/max sliders)
        contrast_frame = ttk.Frame(self)
        contrast_frame.pack(fill='x', pady=1)
        ttk.Label(contrast_frame, text="Min:", width=4).pack(side='left')
        self.min_var = tk.DoubleVar(value=vmin)
        self.min_slider = ttk.Scale(contrast_frame, from_=0, to=data_max,
                                    variable=self.min_var, orient='horizontal',
                                    command=lambda v: self._changed())
        self.min_slider.pack(side='left', fill='x', expand=True)
        self.min_label = ttk.Label(contrast_frame, text=f"{vmin:.0f}", width=7)
        self.min_label.pack(side='left')

        contrast_frame2 = ttk.Frame(self)
        contrast_frame2.pack(fill='x', pady=1)
        ttk.Label(contrast_frame2, text="Max:", width=4).pack(side='left')
        self.max_var = tk.DoubleVar(value=vmax)
        self.max_slider = ttk.Scale(contrast_frame2, from_=0, to=data_max,
                                    variable=self.max_var, orient='horizontal',
                                    command=lambda v: self._changed())
        self.max_slider.pack(side='left', fill='x', expand=True)
        self.max_label = ttk.Label(contrast_frame2, text=f"{vmax:.0f}", width=7)
        self.max_label.pack(side='left')

        # Row 2: Brightness
        bright_frame = ttk.Frame(self)
        bright_frame.pack(fill='x', pady=1)
        ttk.Label(bright_frame, text="Brt:", width=4).pack(side='left')
        self.brightness_var = tk.DoubleVar(value=1.0)
        self.bright_slider = ttk.Scale(bright_frame, from_=0.0, to=3.0,
                                       variable=self.brightness_var, orient='horizontal',
                                       command=lambda v: self._changed())
        self.bright_slider.pack(side='left', fill='x', expand=True)
        self.bright_label = ttk.Label(bright_frame, text="1.00", width=7)
        self.bright_label.pack(side='left')

        # Separator
        ttk.Separator(self, orient='horizontal').pack(fill='x', pady=4)

    def _update_swatch(self):
        color_name = self.color_var.get()
        r, g, b = IF_COLORS.get(color_name, (255, 255, 255))
        hex_color = f"#{r:02x}{g:02x}{b:02x}"
        self.swatch.delete("all")
        self.swatch.create_rectangle(1, 1, 17, 17, fill=hex_color, outline='gray')

    def _changed(self):
        self.min_label.config(text=f"{self.min_var.get():.0f}")
        self.max_label.config(text=f"{self.max_var.get():.0f}")
        self.bright_label.config(text=f"{self.brightness_var.get():.2f}")
        self.on_change()

    def _draw_histogram(self):
        """Draw a histogram of channel pixel intensities."""
        data = self._preview_data
        if data is None:
            return
        c = self.hist_canvas
        c.delete('all')
        w = c.winfo_width()
        h = c.winfo_height()
        if w < 20 or h < 10:
            w, h = 200, 40

        # Compute histogram (100 bins)
        flat = data.ravel()
        flat = flat[flat > 0]  # skip zero background
        if len(flat) < 50:
            return
        bins = 100
        hist_vals, bin_edges = np.histogram(flat, bins=bins)
        hist_vals = hist_vals.astype(np.float32)
        # Log scale for better visualization
        hist_vals = np.log1p(hist_vals)
        max_val = hist_vals.max() if hist_vals.max() > 0 else 1

        # Get channel color for the bars
        r, g, b = IF_COLORS.get(self.color_var.get(), (100, 150, 255))
        color = f"#{min(255,r+40):02x}{min(255,g+40):02x}{min(255,b+40):02x}"
        dim_color = f"#{r//3:02x}{g//3:02x}{b//3:02x}"

        # Draw bars
        bar_w = w / bins
        points = [(0, h)]
        for i, val in enumerate(hist_vals):
            bar_h = val / max_val * (h - 4)
            x = int(i * bar_w)
            y = int(h - bar_h)
            points.append((x, y))
        points.append((w, h))

        if len(points) > 2:
            c.create_polygon(points, fill=dim_color, outline=color, width=1)

    def get_params(self):
        color_name = self.color_var.get()
        rgb = IF_COLORS.get(color_name, (255, 255, 255))
        return {
            'visible': self.visible_var.get(),
            'color': rgb,
            'color_name': color_name,
            'min': self.min_var.get(),
            'max': self.max_var.get(),
            'brightness': self.brightness_var.get(),
            'name': self.name_var.get(),
        }

    def set_params(self, params):
        """Restore saved settings."""
        self.visible_var.set(params.get('visible', True))
        self.color_var.set(params.get('color_name', DEFAULT_COLORS[self.index % len(DEFAULT_COLORS)]))
        self.min_var.set(params.get('min', 0))
        self.max_var.set(params.get('max', self.data_max))
        self.brightness_var.set(params.get('brightness', 1.0))
        if 'name' in params:
            self.name_var.set(params['name'])
        self.min_label.config(text=f"{self.min_var.get():.0f}")
        self.max_label.config(text=f"{self.max_var.get():.0f}")
        self.bright_label.config(text=f"{self.brightness_var.get():.2f}")
        self._update_swatch()


# ─── Main Application ────────────────────────────────────────────────────────

class FluoroView(tk.Tk):
    """Main application window."""

    def __init__(self):
        super().__init__()
        self.title("FluoroView — Fluorescence Image Viewer")
        self.geometry("1500x900")
        self.minsize(1000, 600)

        # State
        self.file_entries = {}   # name -> ('multi', path) or ('folder', [paths])
        self.channels = []       # list of ChannelData
        self.channel_controls = []
        self.current_file = None
        self.file_settings = {}  # name -> list of param dicts (persisted per file)
        self.zoom_level = 1.0
        self.pan_offset = [0, 0]
        # Multi-ROI state
        self.rois = []            # list of ROIData
        self.roi_mode = None      # None, 'rect', 'circle', 'freehand'
        self.roi_drawing = False
        self.roi_start = None
        self.roi_freehand_pts = []
        self.show_rois = True
        self.analysis_scope = 'all'  # 'all' or 'rois'
        self._update_pending = False
        self._composite_cache = None
        self.executor = ThreadPoolExecutor(max_workers=NUM_WORKERS)

        self._build_ui()
        self._bind_events()

    def _build_ui(self):
        # ── Modern Dark Theme ──
        self.configure(bg='#1a1b2e')
        style = ttk.Style()
        style.theme_use('clam')

        # Color palette
        BG = '#1a1b2e'
        BG2 = '#232437'
        BG3 = '#2d2e44'
        FG = '#e2e4f0'
        ACCENT = '#6c8eff'
        ACCENT2 = '#4a6cf7'
        BORDER = '#3a3b55'
        DIM = '#8888aa'

        style.configure('.', background=BG, foreground=FG, font=('Helvetica Neue', 11),
                       borderwidth=0, focuscolor=ACCENT)
        style.configure('TFrame', background=BG)
        style.configure('TLabel', background=BG, foreground=FG, font=('Helvetica Neue', 11))
        style.configure('Header.TLabel', background=BG, foreground=ACCENT,
                       font=('Helvetica Neue', 13, 'bold'))
        style.configure('TButton', background=BG3, foreground=FG,
                       font=('Helvetica Neue', 11), padding=(10, 5),
                       borderwidth=1, relief='flat')
        style.map('TButton',
                 background=[('active', ACCENT2), ('pressed', ACCENT)],
                 foreground=[('active', '#ffffff')],
                 relief=[('pressed', 'flat')])
        style.configure('Accent.TButton', background=ACCENT2, foreground='#ffffff',
                       font=('Helvetica Neue', 11, 'bold'), padding=(12, 6))
        style.map('Accent.TButton',
                 background=[('active', ACCENT), ('pressed', '#3a5ce0')])
        style.configure('TCheckbutton', background=BG, foreground=FG)
        style.configure('TRadiobutton', background=BG, foreground=FG)
        style.configure('TCombobox', fieldbackground=BG3, background=BG3,
                       foreground=FG, arrowcolor=FG, selectbackground=ACCENT2,
                       selectforeground='#ffffff')
        style.map('TCombobox',
                 fieldbackground=[('readonly', BG3)],
                 foreground=[('readonly', FG)])
        # Fix tk widget colors (Listbox popdowns, dialogs, etc.)
        self.option_add('*TCombobox*Listbox.background', BG3)
        self.option_add('*TCombobox*Listbox.foreground', FG)
        self.option_add('*TCombobox*Listbox.selectBackground', ACCENT2)
        self.option_add('*TCombobox*Listbox.selectForeground', '#ffffff')
        self.option_add('*Toplevel.background', BG)
        self.option_add('*Label.background', BG)
        self.option_add('*Label.foreground', FG)
        self.option_add('*Listbox.background', BG2)
        self.option_add('*Listbox.foreground', FG)
        style.configure('TLabelframe', background=BG, foreground=ACCENT,
                       bordercolor=BORDER)
        style.configure('TLabelframe.Label', background=BG, foreground=ACCENT,
                       font=('Helvetica Neue', 10, 'bold'))
        style.configure('TSeparator', background=BORDER)
        style.configure('TScale', background=BG, troughcolor=BG3,
                       sliderrelief='flat')
        style.configure('Vertical.TScrollbar', background=BG3, troughcolor=BG,
                       borderwidth=0, arrowsize=0)
        style.configure('TPanedwindow', background=BORDER)
        style.configure('TNotebook', background=BG, borderwidth=0)
        style.configure('TNotebook.Tab', background=BG3, foreground=DIM,
                       padding=(12, 4))

        # Main paned window
        self.main_pane = ttk.PanedWindow(self, orient='horizontal')
        self.main_pane.pack(fill='both', expand=True)

        # ── Left panel: file list ──
        left_frame = ttk.Frame(self.main_pane, width=250)
        self.main_pane.add(left_frame, weight=0)

        ttk.Label(left_frame, text="📂 Files", style='Header.TLabel').pack(pady=(8, 4), padx=8, anchor='w')

        btn_frame = ttk.Frame(left_frame)
        btn_frame.pack(fill='x', padx=8, pady=4)
        ttk.Button(btn_frame, text="📂 Folder", style='Accent.TButton',
                  command=self._open_folder).pack(side='left', fill='x', expand=True, padx=(0,2))
        ttk.Button(btn_frame, text="📄 File", style='Accent.TButton',
                  command=self._open_file).pack(side='left', fill='x', expand=True, padx=(2,0))
        ttk.Button(btn_frame, text="✕",
                  command=self._remove_file).pack(side='right', padx=(4, 0))

        self.file_listbox = tk.Listbox(left_frame, font=('Menlo', 11), selectmode='single',
                                       bg='#1e1e2e', fg='#cdd6f4', selectbackground='#45475a',
                                       selectforeground='#f5e0dc', relief='flat', bd=0)
        self.file_listbox.pack(fill='both', expand=True, padx=8, pady=4)
        self.file_listbox.bind('<<ListboxSelect>>', self._on_file_select)

        # File info label
        self.file_info_label = ttk.Label(left_frame, text="No file loaded", wraplength=230)
        self.file_info_label.pack(padx=8, pady=4)

        # ── Center: image viewer ──
        center_frame = ttk.Frame(self.main_pane)
        self.main_pane.add(center_frame, weight=1)

        # Toolbar
        toolbar = ttk.Frame(center_frame)
        toolbar.pack(fill='x', padx=4, pady=4)

        ttk.Button(toolbar, text="Fit", command=self._zoom_fit, width=4).pack(side='left', padx=1)
        ttk.Button(toolbar, text="▭", command=lambda: self._set_roi_mode('rect'), width=3).pack(side='left', padx=1)
        ttk.Button(toolbar, text="○", command=lambda: self._set_roi_mode('circle'), width=3).pack(side='left', padx=1)
        ttk.Button(toolbar, text="✏", command=lambda: self._set_roi_mode('freehand'), width=3).pack(side='left', padx=1)
        ttk.Button(toolbar, text="✕", command=self._clear_all_rois, width=3).pack(side='left', padx=1)
        ttk.Button(toolbar, text="👁", command=self._toggle_roi_visibility, width=3).pack(side='left', padx=1)
        ttk.Separator(toolbar, orient='vertical').pack(side='left', fill='y', padx=4)
        ttk.Button(toolbar, text="Mask", command=self._open_mask_popup, width=5).pack(side='left', padx=1)
        ttk.Button(toolbar, text="Save", command=self._save_composite, width=5).pack(side='left', padx=1)
        ttk.Button(toolbar, text="ROIs", command=self._save_all_rois, width=5).pack(side='left', padx=1)
        ttk.Button(toolbar, text="CSV", command=self._export_csv, width=4).pack(side='left', padx=1)

        self.zoom_label = ttk.Label(toolbar, text="Zoom: fit")
        self.zoom_label.pack(side='right', padx=8)

        self.coord_label = ttk.Label(toolbar, text="")
        self.coord_label.pack(side='right', padx=8)

        # Canvas for image
        self.canvas = tk.Canvas(center_frame, bg='#11111b', highlightthickness=0, cursor='crosshair')
        self.canvas.pack(fill='both', expand=True)

        # ── Right panel: channel controls ──
        right_outer = ttk.Frame(self.main_pane, width=280)
        self.main_pane.add(right_outer, weight=0)

        ttk.Label(right_outer, text="🎨 Channels (Composite Overlay)", style='Header.TLabel').pack(pady=(8, 4), padx=8, anchor='w')

        # All On / All Off buttons
        toggle_frame = ttk.Frame(right_outer)
        toggle_frame.pack(fill='x', padx=8, pady=(0, 4))
        ttk.Button(toggle_frame, text="All On", command=self._all_channels_on).pack(side='left', padx=2, fill='x', expand=True)
        ttk.Button(toggle_frame, text="All Off", command=self._all_channels_off).pack(side='left', padx=2, fill='x', expand=True)

        # Scrollable controls area (limited height so analysis fits below)
        scroll_frame = ttk.Frame(right_outer)
        scroll_frame.pack(fill='both', expand=True, padx=4)

        controls_canvas = tk.Canvas(scroll_frame, highlightthickness=0, width=260)
        scrollbar = ttk.Scrollbar(scroll_frame, orient='vertical', command=controls_canvas.yview)
        self.controls_frame = ttk.Frame(controls_canvas)

        self.controls_frame.bind('<Configure>',
            lambda e: controls_canvas.configure(scrollregion=controls_canvas.bbox('all')))
        controls_canvas.create_window((0, 0), window=self.controls_frame, anchor='nw')
        controls_canvas.configure(yscrollcommand=scrollbar.set)

        scrollbar.pack(side='right', fill='y')
        controls_canvas.pack(side='left', fill='both', expand=True)

        # Apply to all samples button
        apply_frame = ttk.Frame(right_outer)
        apply_frame.pack(fill='x', padx=8, pady=4)
        ttk.Button(apply_frame, text="📋 Apply Settings to All Samples",
                  command=self._apply_settings_to_all).pack(fill='x')

        ttk.Separator(right_outer, orient='horizontal').pack(fill='x', padx=8, pady=2)

        # ── Intensity Analysis Graph ──
        analysis_header = ttk.Frame(right_outer)
        analysis_header.pack(fill='x', padx=8)
        ttk.Label(analysis_header, text="📊 Ratio to DAPI",
                 style='Header.TLabel').pack(side='left')
        self.analysis_scope_var = tk.StringVar(value='All Image')
        scope_combo = ttk.Combobox(analysis_header, textvariable=self.analysis_scope_var,
                                   values=['All Image'], width=12, state='readonly')
        scope_combo.pack(side='right', padx=4)
        scope_combo.bind('<<ComboboxSelected>>', lambda e: self._update_analysis_graph())
        self.scope_combo = scope_combo

        self.analysis_canvas = tk.Canvas(right_outer, height=150, bg='#ffffff',
                                         highlightthickness=0)
        self.analysis_canvas.pack(fill='x', padx=8, pady=4)

        # DPI is 300 by default (no UI clutter)
        self.dpi_var = tk.StringVar(value='300')

        # Status bar
        self.status_var = tk.StringVar(value="Ready — Open a folder to begin")
        ttk.Label(self, textvariable=self.status_var, relief='sunken',
                  anchor='w', padding=4).pack(fill='x', side='bottom')

    def _bind_events(self):
        self.canvas.bind('<MouseWheel>', self._on_scroll)        # macOS scroll
        self.canvas.bind('<Button-4>', self._on_scroll)          # Linux scroll up
        self.canvas.bind('<Button-5>', self._on_scroll)          # Linux scroll down
        self.canvas.bind('<ButtonPress-1>', self._on_mouse_press)
        self.canvas.bind('<B1-Motion>', self._on_mouse_drag)
        self.canvas.bind('<ButtonRelease-1>', self._on_mouse_release)
        self.canvas.bind('<ButtonPress-2>', self._on_pan_start)  # middle button
        self.canvas.bind('<B2-Motion>', self._on_pan_drag)
        self.canvas.bind('<ButtonPress-3>', self._on_pan_start)  # right button
        self.canvas.bind('<B3-Motion>', self._on_pan_drag)
        self.canvas.bind('<Motion>', self._on_mouse_move)
        self.canvas.bind('<Configure>', lambda e: self._schedule_update())

    # ── Folder / File management ──────────────────────────────────────────

    def _open_folder(self):
        folder = filedialog.askdirectory(title="Select folder with TIF files")
        if not folder:
            return
        self.status_var.set(f"Scanning {folder}...")
        self.update_idletasks()

        entries = scan_folder(folder)
        if not entries:
            messagebox.showinfo("No files", "No TIF files found in the selected folder.")
            self.status_var.set("Ready")
            return

        self.file_entries = entries
        self.file_listbox.delete(0, 'end')
        for name in entries:
            self.file_listbox.insert('end', name)

        self.status_var.set(f"Found {len(entries)} items in {os.path.basename(folder)}")

        # Auto-load the first entry so user immediately sees the composite
        if entries and not self.current_file:
            first_name = list(entries.keys())[0]
            self.file_listbox.selection_set(0)
            self._load_file(first_name)

    def _open_file(self):
        """Open individual TIF file(s) directly."""
        files = filedialog.askopenfilenames(
            title="Select TIF file(s)",
            filetypes=[("TIF files", "*.tif *.tiff"), ("All files", "*.*")]
        )
        if not files:
            return

        for fpath in files:
            basename = os.path.splitext(os.path.basename(fpath))[0]
            # Avoid duplicates
            if basename in self.file_entries:
                basename = f"{basename} ({len(self.file_entries)})"
            self.file_entries[basename] = ('multi', fpath)
            self.file_listbox.insert('end', basename)

        self.status_var.set(f"Added {len(files)} file(s)")

        # Auto-select and load the first file if nothing is loaded
        if len(files) == 1 and not self.current_file:
            self.file_listbox.selection_clear(0, 'end')
            idx = self.file_listbox.size() - 1
            self.file_listbox.selection_set(idx)
            self._load_file(list(self.file_entries.keys())[idx])

    def _remove_file(self):
        sel = self.file_listbox.curselection()
        if not sel:
            return
        idx = sel[0]
        name = self.file_listbox.get(idx)
        self.file_listbox.delete(idx)
        self.file_entries.pop(name, None)
        if name == self.current_file:
            self.channels = []
            self._clear_channel_controls()
            self.canvas.delete('all')
            self.current_file = None
            self.file_info_label.config(text="No file loaded")

    def _on_file_select(self, event):
        sel = self.file_listbox.curselection()
        if not sel:
            return
        name = self.file_listbox.get(sel[0])
        if name == self.current_file:
            return
        self._load_file(name)

    def _save_current_settings(self):
        """Save current channel settings for the active file."""
        if self.current_file and self.channel_controls:
            self.file_settings[self.current_file] = [
                ctrl.get_params() for ctrl in self.channel_controls
            ]

    def _load_file(self, name):
        # Save settings of the currently loaded file before switching
        self._save_current_settings()

        self.current_file = name
        entry = self.file_entries[name]
        self.status_var.set(f"Loading {name}...")
        self.update_idletasks()

        self.channels = []
        self._clear_channel_controls()
        self.rois = []  # clear ROIs when loading new file
        self._composite_cache = None

        try:
            if entry[0] == 'folder':
                # Load individual channel TIFs in parallel
                paths = entry[1]
                futures = {self.executor.submit(load_channel, p): i
                           for i, p in enumerate(paths)}
                results = [None] * len(paths)
                for future in futures:
                    idx = futures[future]
                    results[idx] = future.result()
                self.channels = results
            else:
                # Multi-channel TIF
                self.channels = load_multichannel_tif(entry[1])

            # Build channel controls
            for i, ch in enumerate(self.channels):
                ch_name = f"Channel {i+1}"
                if entry[0] == 'folder':
                    ch_name = os.path.splitext(os.path.basename(ch.path))[0]
                    # Shorten the name
                    parts = ch_name.split('_')
                    if len(parts) > 1:
                        ch_name = parts[-1]  # e.g. "ch1"

                ctrl = ChannelControl(
                    self.controls_frame, i, ch_name,
                    vmin=ch.vmin, vmax=ch.vmax, data_max=float(ch.preview.max()),
                    on_change=self._schedule_update,
                    preview_data=ch.preview
                )
                ctrl.pack(fill='x', padx=2)
                self.channel_controls.append(ctrl)

            # Update info
            if self.channels:
                ch0 = self.channels[0]
                info = (f"{ch0.full_h} × {ch0.full_w}\n"
                        f"{len(self.channels)} channels\n"
                        f"Preview: {ch0.preview.shape[0]}×{ch0.preview.shape[1]}\n"
                        f"DS factor: {ch0.ds_factor}×")
                self.file_info_label.config(text=info)

            # Restore saved settings if available
            saved = self.file_settings.get(name)
            if saved and len(saved) == len(self.channel_controls):
                for ctrl, params in zip(self.channel_controls, saved):
                    ctrl.set_params(params)

            self.zoom_level = 1.0
            self.pan_offset = [0, 0]
            self._zoom_fit()
            self.status_var.set(f"Loaded {name} — {len(self.channels)} channels (composite overlay)")

        except Exception as e:
            messagebox.showerror("Load Error", f"Failed to load {name}:\n{e}")
            self.status_var.set(f"Error loading {name}")
            import traceback; traceback.print_exc()

    def _clear_channel_controls(self):
        for ctrl in self.channel_controls:
            ctrl.destroy()
        self.channel_controls = []

    def _all_channels_on(self):
        for ctrl in self.channel_controls:
            ctrl.visible_var.set(True)
        self._schedule_update()

    def _all_channels_off(self):
        for ctrl in self.channel_controls:
            ctrl.visible_var.set(False)
        self._schedule_update()

    def _apply_settings_to_all(self):
        """Apply current file's channel settings (min/max/brightness/color/name) to all other files."""
        if not self.channel_controls:
            messagebox.showinfo("No data", "Load a file first.")
            return
        current_params = [ctrl.get_params() for ctrl in self.channel_controls]
        count = 0
        for name in self.file_entries:
            if name != self.current_file:
                self.file_settings[name] = [dict(p) for p in current_params]
                count += 1
        self.status_var.set(f"Applied settings to {count} other sample(s)")

    def _update_analysis_graph(self):
        """Draw a bar chart of Ratio to DAPI per channel."""
        c = self.analysis_canvas
        c.delete('all')
        if not self.channels or not self.channel_controls:
            return

        w = c.winfo_width()
        h = c.winfo_height()
        if w < 30 or h < 30:
            w, h = 260, 150

        # White background
        c.create_rectangle(0, 0, w, h, fill='#ffffff', outline='')

        # Update scope dropdown with ROI names
        scope_values = ['All Image'] + [roi.name for roi in self.rois]
        self.scope_combo.configure(values=scope_values)
        selected_scope = self.analysis_scope_var.get()
        if selected_scope not in scope_values:
            self.analysis_scope_var.set('All Image')
            selected_scope = 'All Image'

        # Find selected ROI (if any)
        selected_roi = None
        if selected_scope != 'All Image':
            for roi in self.rois:
                if roi.name == selected_scope:
                    selected_roi = roi
                    break

        params_list = [ctrl.get_params() for ctrl in self.channel_controls]

        def _get_region_data(ch, params):
            """Get adjusted pixel data for the current scope."""
            preview = ch.preview
            if selected_roi is not None:
                x1, y1, x2, y2 = selected_roi.bbox
                px1 = max(0, int(x1)); py1 = max(0, int(y1))
                px2 = min(preview.shape[1], int(x2))
                py2 = min(preview.shape[0], int(y2))
                region = preview[py1:py2, px1:px2].copy()
                if selected_roi.roi_type != 'rect' and region.size > 0:
                    mask = selected_roi.get_mask(py2 - py1, px2 - px1)
                    region = region[mask] if mask.any() else region.ravel()
                else:
                    region = region.ravel()
            else:
                region = preview.ravel()

            cmin, cmax = params['min'], params['max']
            if cmax <= cmin: cmax = cmin + 1
            data = np.clip((region - cmin) / (cmax - cmin), 0, 1) * params['brightness']
            np.clip(data, 0, 1, out=data)
            return data

        # Compute DAPI mean
        dapi_idx = 0
        dapi_mean = 0.0
        for i, (ch, params) in enumerate(zip(self.channels, params_list)):
            name = params.get('name', f'Ch{i+1}')
            if 'dapi' in name.lower() or i == 0:
                dapi_idx = i
                data = _get_region_data(ch, params)
                nz = data[data > 0.01]
                if len(nz) > 10:
                    dapi_mean = float(np.mean(nz))
                if 'dapi' in name.lower():
                    break

        if dapi_mean < 0.001:
            dapi_mean = 1.0

        # Compute ratio for each non-DAPI visible channel
        ratios = []
        ratio_stds = []
        colors = []
        names = []
        for i, (ch, params) in enumerate(zip(self.channels, params_list)):
            if i == dapi_idx or not params['visible']:
                continue
            data = _get_region_data(ch, params)
            nz = data[data > 0.01]
            if len(nz) > 10:
                ch_mean = float(np.mean(nz))
                ch_std = float(np.std(nz))
            else:
                ch_mean = ch_std = 0.0
            ratios.append(ch_mean / dapi_mean)
            ratio_stds.append(ch_std / dapi_mean)
            r, g, b = params['color']
            colors.append(f"#{r:02x}{g:02x}{b:02x}")
            names.append(params.get('name', f'Ch{i+1}'))

        if not ratios:
            return

        # Drawing parameters
        margin_l = 40
        margin_r = 10
        margin_t = 12
        margin_b = 28
        plot_w = w - margin_l - margin_r
        plot_h = h - margin_t - margin_b
        max_val = max(r + s for r, s in zip(ratios, ratio_stds)) if ratios else 1
        if max_val <= 0: max_val = 1

        n_bars = len(ratios)
        bar_w = max(10, plot_w // max(1, n_bars) - 8)
        gap = max(4, (plot_w - n_bars * bar_w) // max(1, n_bars + 1))

        # Axes
        c.create_line(margin_l, margin_t, margin_l, h - margin_b,
                      fill='#333333', width=1)
        c.create_line(margin_l, h - margin_b, w - margin_r, h - margin_b,
                      fill='#333333', width=1)

        # Y-axis title
        c.create_text(12, h // 2, text="Ratio", anchor='center', angle=90,
                     fill='#333333', font=('Helvetica Neue', 8, 'bold'))

        # Y-axis tick labels
        for frac in [0, 0.5, 1.0]:
            y = int(h - margin_b - frac * plot_h)
            val = frac * max_val
            c.create_text(margin_l - 3, y, text=f"{val:.1f}", anchor='e',
                         fill='#555555', font=('Helvetica Neue', 7))
            c.create_line(margin_l, y, w - margin_r, y,
                         fill='#e0e0e0', width=1)

        # Draw bars
        for i in range(n_bars):
            x = margin_l + gap + i * (bar_w + gap)
            bar_h = (ratios[i] / max_val) * plot_h
            y_top = h - margin_b - bar_h

            c.create_rectangle(x, y_top, x + bar_w, h - margin_b,
                             fill=colors[i], outline='#333333', width=1)

            # Error bar
            if ratio_stds[i] > 0:
                err_top = h - margin_b - ((ratios[i] + ratio_stds[i]) / max_val) * plot_h
                err_bot = h - margin_b - (max(0, ratios[i] - ratio_stds[i]) / max_val) * plot_h
                mid_x = x + bar_w // 2
                c.create_line(mid_x, err_top, mid_x, err_bot, fill='#333333', width=1)
                c.create_line(mid_x - 3, err_top, mid_x + 3, err_top, fill='#333333', width=1)
                c.create_line(mid_x - 3, err_bot, mid_x + 3, err_bot, fill='#333333', width=1)

            # Value label on bar
            c.create_text(x + bar_w // 2, y_top - 4, text=f"{ratios[i]:.2f}",
                         anchor='s', fill='#333333', font=('Helvetica Neue', 7))

            # Channel name
            c.create_text(x + bar_w // 2, h - margin_b + 3, text=names[i],
                         anchor='n', fill='#333333', font=('Helvetica Neue', 7))

        # X-axis title
        c.create_text(w // 2, h - 2, text="Ratio to DAPI", anchor='s',
                     fill='#333333', font=('Helvetica Neue', 8, 'bold'))

    # ── Composite Rendering ───────────────────────────────────────────────

    def _schedule_update(self):
        """Debounced update to avoid excessive re-renders during slider drags."""
        if not self._update_pending:
            self._update_pending = True
            self.after(30, self._do_update)

    def _do_update(self):
        self._update_pending = False
        self._render_composite()
        self._update_analysis_graph()

    def _compute_channel_image(self, ch_data, params):
        """Apply contrast/brightness and color to a single channel preview. Returns float32 RGB."""
        if not params['visible']:
            return None

        img = ch_data.preview.copy()
        cmin = params['min']
        cmax = params['max']
        brightness = params['brightness']

        # Contrast stretch
        if cmax <= cmin:
            cmax = cmin + 1
        img = (img - cmin) / (cmax - cmin)
        img = np.clip(img, 0, 1)

        # Brightness
        img *= brightness
        img = np.clip(img, 0, 1)

        # Apply color
        r, g, b = params['color']
        rgb = np.zeros((*img.shape, 3), dtype=np.float32)
        rgb[:, :, 0] = img * (r / 255.0)
        rgb[:, :, 1] = img * (g / 255.0)
        rgb[:, :, 2] = img * (b / 255.0)
        return rgb

    def _render_viewport_region(self, canvas_w, canvas_h):
        """
        Render only the visible viewport region, loading from full-res data
        when zoomed in beyond the preview resolution.
        Returns an RGB uint8 array sized to the canvas.
        """
        if not self.channels:
            return None

        ch0 = self.channels[0]
        ds = ch0.ds_factor
        prev_h, prev_w = ch0.preview.shape
        full_h, full_w = ch0.full_h, ch0.full_w

        # Effective zoom relative to full-res pixels
        # zoom_level=1 means 1 preview pixel = 1 screen pixel
        # To get full-res pixel mapping: full_zoom = zoom_level / ds
        # If zoom_level > ds, we should read from full-res data
        use_fullres = (self.zoom_level > ds * 0.5)

        if use_fullres:
            # Determine which region of full-res image is visible
            src_w, src_h = full_w, full_h
            full_zoom = self.zoom_level / ds  # zoom relative to full-res

            # Center of view in full-res coords
            cx_full = full_w / 2 - self.pan_offset[0] / (self.zoom_level / ds)
            cy_full = full_h / 2 - self.pan_offset[1] / (self.zoom_level / ds)

            # Visible region in full-res coords
            half_vw = canvas_w / 2 / full_zoom
            half_vh = canvas_h / 2 / full_zoom

            fx1 = int(max(0, cx_full - half_vw - 2))
            fy1 = int(max(0, cy_full - half_vh - 2))
            fx2 = int(min(full_w, cx_full + half_vw + 2))
            fy2 = int(min(full_h, cy_full + half_vh + 2))

            if fx2 <= fx1 or fy2 <= fy1:
                return None

            params_list = [ctrl.get_params() for ctrl in self.channel_controls]
            region_h, region_w = fy2 - fy1, fx2 - fx1
            composite = np.zeros((region_h, region_w, 3), dtype=np.float32)

            for ch_data, params in zip(self.channels, params_list):
                if not params['visible']:
                    continue
                data = ch_data.full_data[fy1:fy2, fx1:fx2].astype(np.float32)
                cmin, cmax = params['min'], params['max']
                if cmax <= cmin:
                    cmax = cmin + 1
                data = (data - cmin) / (cmax - cmin)
                np.clip(data, 0, 1, out=data)
                data *= params['brightness']
                np.clip(data, 0, 1, out=data)
                r, g, b = params['color']
                ch_rgb = np.zeros((region_h, region_w, 3), dtype=np.float32)
                ch_rgb[:, :, 0] = data * (r / 255.0)
                ch_rgb[:, :, 1] = data * (g / 255.0)
                ch_rgb[:, :, 2] = data * (b / 255.0)
                # Screen blend: 1 - (1-A)*(1-B)
                composite = 1 - (1 - composite) * (1 - ch_rgb)

            composite = np.clip(composite * 255, 0, 255).astype(np.uint8)

            # Resize to screen size
            out_w = int(region_w * full_zoom)
            out_h = int(region_h * full_zoom)
            if out_w < 1 or out_h < 1:
                return None

            pil_img = Image.fromarray(composite)
            pil_img = pil_img.resize((out_w, out_h),
                                     Image.NEAREST if full_zoom > 3 else Image.LANCZOS)

            # Place in canvas-sized image
            result = Image.new('RGB', (canvas_w, canvas_h), (17, 17, 27))
            # Where does this region go on screen?
            screen_x = int((fx1 - cx_full) * full_zoom + canvas_w / 2)
            screen_y = int((fy1 - cy_full) * full_zoom + canvas_h / 2)
            result.paste(pil_img, (screen_x, screen_y))
            return result

        else:
            # Use preview data (zoomed out or moderate zoom)
            return None  # fall through to old method

    def _render_composite(self):
        """Render the composite overlay of all visible channels."""
        if not self.channels:
            return

        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()

        # Try viewport-based rendering for deep zoom
        viewport_img = self._render_viewport_region(canvas_w, canvas_h)
        if viewport_img is not None:
            self._display_pil_on_canvas(viewport_img)
            return

        # Standard preview-based rendering
        params_list = [ctrl.get_params() for ctrl in self.channel_controls]

        # Parallel channel computation
        futures = []
        for ch, params in zip(self.channels, params_list):
            futures.append(self.executor.submit(self._compute_channel_image, ch, params))

        # Screen blending
        h, w = self.channels[0].preview.shape
        composite = np.zeros((h, w, 3), dtype=np.float32)

        for future in futures:
            result = future.result()
            if result is not None:
                # Screen blend: 1 - (1-A)*(1-B)
                composite = 1 - (1 - composite) * (1 - result)

        composite = np.clip(composite * 255, 0, 255).astype(np.uint8)
        self._composite_cache = composite

        self._display_on_canvas(composite)

    def _display_pil_on_canvas(self, pil_img):
        """Display a PIL image directly on the canvas (used by viewport rendering)."""
        self._tk_image = ImageTk.PhotoImage(pil_img)
        self.canvas.delete('all')
        self.canvas.create_image(0, 0, image=self._tk_image, anchor='nw')
        # ROIs are drawn on the canvas after, in _display_on_canvas path

    def _display_on_canvas(self, rgb_array):
        """Display an RGB array on the canvas with current zoom/pan."""
        if rgb_array is None:
            return

        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        if canvas_w < 10 or canvas_h < 10:
            return

        img_h, img_w = rgb_array.shape[:2]

        # Apply zoom
        disp_w = int(img_w * self.zoom_level)
        disp_h = int(img_h * self.zoom_level)

        if disp_w < 1 or disp_h < 1:
            return

        pil_img = Image.fromarray(rgb_array)
        pil_img = pil_img.resize((disp_w, disp_h), Image.NEAREST if self.zoom_level > 2 else Image.LANCZOS)

        # Draw all ROIs on the PIL image
        if self.rois and self.show_rois:
            draw = ImageDraw.Draw(pil_img)
            for roi in self.rois:
                rx1, ry1, rx2, ry2 = roi.bbox
                zx1 = int(rx1 * self.zoom_level)
                zy1 = int(ry1 * self.zoom_level)
                zx2 = int(rx2 * self.zoom_level)
                zy2 = int(ry2 * self.zoom_level)
                if roi.roi_type == 'circle':
                    draw.ellipse([zx1, zy1, zx2, zy2], outline='#00ff88', width=2)
                elif roi.roi_type == 'freehand' and roi.points:
                    pts = [(int(px * self.zoom_level), int(py * self.zoom_level))
                           for px, py in roi.points]
                    if len(pts) > 2:
                        draw.polygon(pts, outline='#00ff88', fill=None)
                else:
                    draw.rectangle([zx1, zy1, zx2, zy2], outline='#00ff88', width=2)
                # DOT corners for rect
                if roi.roi_type == 'rect':
                    for cx, cy in [(zx1, zy1), (zx2, zy1), (zx1, zy2), (zx2, zy2)]:
                        draw.rectangle([cx-3, cy-3, cx+3, cy+3], fill='#00ff88')
                # Label
                try:
                    draw.text((zx1 + 4, zy1 - 14), roi.name, fill='#00ff88')
                except Exception:
                    pass

        # Draw in-progress freehand polygon points
        if self.roi_freehand_pts and self.roi_mode == 'freehand':
            draw = ImageDraw.Draw(pil_img)
            pts = [(int(px * self.zoom_level), int(py * self.zoom_level))
                   for px, py in self.roi_freehand_pts]
            # Draw connecting lines
            for j in range(len(pts) - 1):
                draw.line([pts[j], pts[j+1]], fill='#ffff00', width=2)
            # Draw dots at each point
            for j, (px, py) in enumerate(pts):
                r = 4 if j == 0 else 3
                color = '#ff4444' if j == 0 else '#ffff00'  # Red start point
                draw.ellipse([px - r, py - r, px + r, py + r], fill=color, outline='white')
            # Show hint text
            if len(pts) > 2:
                draw.text((pts[0][0] + 8, pts[0][1] - 10), "click to close",
                         fill='#ff4444')

        self._tk_image = ImageTk.PhotoImage(pil_img)

        self.canvas.delete('all')
        # Center with pan offset
        x = canvas_w // 2 + self.pan_offset[0]
        y = canvas_h // 2 + self.pan_offset[1]
        self.canvas.create_image(x, y, image=self._tk_image, anchor='center')

    # ── Zoom / Pan ────────────────────────────────────────────────────────

    def _on_scroll(self, event):
        # Cursor-centric zoom: keep image point under cursor fixed
        if event.num == 4 or event.delta > 0:
            factor = 1.35
        elif event.num == 5 or event.delta < 0:
            factor = 1 / 1.35
        else:
            return

        # Mouse position relative to canvas center
        cx = self.canvas.winfo_width() / 2
        cy = self.canvas.winfo_height() / 2
        mx = event.x - cx - self.pan_offset[0]
        my = event.y - cy - self.pan_offset[1]

        old_zoom = self.zoom_level
        self.zoom_level = max(0.01, self.zoom_level * factor)
        ratio = self.zoom_level / old_zoom

        # Adjust pan so point under cursor stays fixed
        self.pan_offset[0] -= mx * (ratio - 1)
        self.pan_offset[1] -= my * (ratio - 1)

        self.zoom_label.config(text=f"Zoom: {self.zoom_level:.1%}")
        self._schedule_update()

    def _zoom_step(self, factor):
        """Zoom in/out by a fixed factor (for +/- buttons)."""
        self.zoom_level = max(0.01, self.zoom_level * factor)
        self.zoom_label.config(text=f"Zoom: {self.zoom_level:.1%}")
        self._schedule_update()

    def _zoom_fit(self):
        if not self.channels:
            return
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        if canvas_w < 10:
            canvas_w = 900
        if canvas_h < 10:
            canvas_h = 700
        img_h, img_w = self.channels[0].preview.shape
        self.zoom_level = min(canvas_w / img_w, canvas_h / img_h) * 0.95
        self.pan_offset = [0, 0]
        self.zoom_label.config(text=f"Zoom: {self.zoom_level:.1%}")
        self._schedule_update()

    def _zoom_100(self):
        self.zoom_level = 1.0
        self.pan_offset = [0, 0]
        self.zoom_label.config(text="Zoom: 100%")
        self._schedule_update()

    # ── Mouse events ──────────────────────────────────────────────────────

    def _on_pan_start(self, event):
        self._pan_start_x = event.x
        self._pan_start_y = event.y
        self._pan_start_offset = list(self.pan_offset)

    def _on_pan_drag(self, event):
        dx = event.x - self._pan_start_x
        dy = event.y - self._pan_start_y
        self.pan_offset[0] = self._pan_start_offset[0] + dx
        self.pan_offset[1] = self._pan_start_offset[1] + dy
        self._schedule_update()

    def _canvas_to_image(self, event_x, event_y):
        """Convert canvas coordinates to image (preview) coordinates."""
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        cx = canvas_w // 2 + self.pan_offset[0]
        cy = canvas_h // 2 + self.pan_offset[1]
        if not self.channels:
            return None, None
        img_h, img_w = self.channels[0].preview.shape
        img_left = cx - (img_w * self.zoom_level) / 2
        img_top = cy - (img_h * self.zoom_level) / 2
        px = (event_x - img_left) / self.zoom_level
        py = (event_y - img_top) / self.zoom_level
        return px, py

    def _on_mouse_press(self, event):
        if self.roi_drawing:
            if self.roi_mode == 'freehand':
                # Click to place points; close by clicking near start
                px, py = self._canvas_to_image(event.x, event.y)
                if px is None:
                    return
                if len(self.roi_freehand_pts) > 2:
                    # Check if close to first point (within 10px on screen)
                    sx, sy = self.roi_freehand_pts[0]
                    dist = ((px - sx)**2 + (py - sy)**2)**0.5
                    if dist * self.zoom_level < 12:
                        # Close polygon — create the ROI
                        pts = self.roi_freehand_pts
                        xs = [p[0] for p in pts]
                        ys = [p[1] for p in pts]
                        bbox = (min(xs), min(ys), max(xs), max(ys))
                        roi = ROIData('freehand', bbox, points=pts)
                        self.rois.append(roi)
                        self.roi_freehand_pts = []
                        self.status_var.set(f"Added {roi.name} (freehand, {len(pts)} points)")
                        self._schedule_update()
                        return
                self.roi_freehand_pts.append((px, py))
                self._schedule_update()
            else:
                self.roi_start = (event.x, event.y)
                self._temp_roi_bbox = None
        else:
            # Pan with left click
            self._pan_start_x = event.x
            self._pan_start_y = event.y
            self._pan_start_offset = list(self.pan_offset)

    def _on_mouse_drag(self, event):
        if self.roi_drawing and self.roi_start and self.roi_mode != 'freehand':
            # Drag for rect/circle
            canvas_w = self.canvas.winfo_width()
            canvas_h = self.canvas.winfo_height()
            cx = canvas_w // 2 + self.pan_offset[0]
            cy = canvas_h // 2 + self.pan_offset[1]

            if not self.channels:
                return
            img_h, img_w = self.channels[0].preview.shape
            disp_w = img_w * self.zoom_level
            disp_h = img_h * self.zoom_level

            img_left = cx - disp_w / 2
            img_top = cy - disp_h / 2

            sx = (self.roi_start[0] - img_left) / self.zoom_level
            sy = (self.roi_start[1] - img_top) / self.zoom_level
            ex = (event.x - img_left) / self.zoom_level
            ey = (event.y - img_top) / self.zoom_level

            sx = max(0, min(img_w, sx))
            sy = max(0, min(img_h, sy))
            ex = max(0, min(img_w, ex))
            ey = max(0, min(img_h, ey))

            x1, x2 = sorted([sx, ex])
            y1, y2 = sorted([sy, ey])
            self._temp_roi_bbox = (x1, y1, x2, y2)
            self._schedule_update()
        elif not self.roi_drawing:
            # Pan
            dx = event.x - self._pan_start_x
            dy = event.y - self._pan_start_y
            self.pan_offset[0] = self._pan_start_offset[0] + dx
            self.pan_offset[1] = self._pan_start_offset[1] + dy
            self._schedule_update()

    def _on_mouse_release(self, event):
        if self.roi_drawing and self.roi_mode != 'freehand':
            if self._temp_roi_bbox is not None:
                x1, y1, x2, y2 = self._temp_roi_bbox
                if abs(x2 - x1) > 3 and abs(y2 - y1) > 3:
                    roi_type = self.roi_mode or 'rect'
                    roi = ROIData(roi_type, (x1, y1, x2, y2))
                    self.rois.append(roi)
                    self.status_var.set(f"Added {roi.name} ({roi_type})")
                self._temp_roi_bbox = None
            self.roi_drawing = False
            self.canvas.config(cursor='crosshair')
            self._schedule_update()

    def _on_mouse_move(self, event):
        if not self.channels:
            return
        # Show coordinates
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        cx = canvas_w // 2 + self.pan_offset[0]
        cy = canvas_h // 2 + self.pan_offset[1]
        img_h, img_w = self.channels[0].preview.shape
        disp_w = img_w * self.zoom_level
        disp_h = img_h * self.zoom_level
        img_left = cx - disp_w / 2
        img_top = cy - disp_h / 2

        px = (event.x - img_left) / self.zoom_level
        py = (event.y - img_top) / self.zoom_level

        if 0 <= px < img_w and 0 <= py < img_h:
            # Full-res coords
            ds = self.channels[0].ds_factor
            fx, fy = int(px * ds), int(py * ds)
            self.coord_label.config(text=f"({fx}, {fy})")
        else:
            self.coord_label.config(text="")

    def _set_roi_mode(self, mode):
        """Set ROI drawing mode: 'rect', 'circle', or 'freehand'."""
        self.roi_mode = mode
        self.roi_drawing = True
        self.roi_freehand_pts = []
        self._temp_roi_bbox = None
        self.canvas.config(cursor='cross')
        self.status_var.set(f"ROI mode: {mode} — click and drag to draw")

    def _clear_all_rois(self):
        """Clear all ROIs."""
        self.rois = []
        self.roi_drawing = False
        self.roi_mode = None
        self.canvas.config(cursor='crosshair')
        ROIData._counter = 0
        self._schedule_update()
        self.status_var.set("All ROIs cleared")

    def _toggle_roi_visibility(self):
        """Show/hide all ROI overlays on the image."""
        self.show_rois = not self.show_rois
        self._schedule_update()
        self.status_var.set(f"ROIs {'visible' if self.show_rois else 'hidden'}")

    def _save_all_rois(self):
        """Save cropped images for all ROIs — merged + per-channel, in named folders."""
        if not self.channels:
            messagebox.showinfo("No data", "Load an image first.")
            return
        if not self.rois:
            messagebox.showinfo("No ROIs", "Draw at least one ROI first.")
            return

        base_folder = filedialog.askdirectory(title="Select folder to save ROI images")
        if not base_folder:
            return

        self.status_var.set("Saving ROI images...")
        self.update_idletasks()

        params_list = [ctrl.get_params() for ctrl in self.channel_controls]
        ds = self.channels[0].ds_factor

        def do_save():
            try:
                for roi in self.rois:
                    roi_folder = os.path.join(base_folder, roi.name)
                    os.makedirs(roi_folder, exist_ok=True)
                    x1, y1, x2, y2 = roi.bbox
                    # Full-res region
                    fx1, fy1 = int(x1 * ds), int(y1 * ds)
                    fx2, fy2 = int(x2 * ds), int(y2 * ds)
                    region = (fx1, fy1, fx2, fy2)
                    fh = fy2 - fy1
                    fw = fx2 - fx1

                    # Mask for non-rect ROIs
                    roi_mask = roi.get_mask(fh, fw, ds_factor=1)
                    # Shift mask origin since get_mask works on full image
                    roi_mask_local = roi.get_mask(
                        self.channels[0].full_h, self.channels[0].full_w,
                        ds_factor=ds
                    )[fy1:fy2, fx1:fx2]

                    # Save merged composite ROI
                    rgb = self._render_fullres_composite(region=region)
                    if rgb is not None:
                        if roi.roi_type != 'rect':
                            # Zero out pixels outside the ROI mask
                            for c in range(3):
                                rgb[:, :, c] = rgb[:, :, c] * roi_mask_local
                        pil = Image.fromarray(rgb)
                        pil.save(os.path.join(roi_folder, f"{roi.name}-merged.tif"))

                    # Save per-channel ROI
                    for i, (ch, params) in enumerate(zip(self.channels, params_list)):
                        if not params['visible']:
                            continue
                        ch_data = ch.full_data[fy1:fy2, fx1:fx2].astype(np.float64)
                        cmin, cmax = params['min'], params['max']
                        if cmax <= cmin:
                            cmax = cmin + 1
                        ch_norm = np.clip((ch_data - cmin) / (cmax - cmin), 0, 1)
                        ch_norm *= params['brightness']
                        np.clip(ch_norm, 0, 1, out=ch_norm)

                        r, g, b = params['color']
                        ch_rgb = np.zeros((fh, fw, 3), dtype=np.uint8)
                        ch_rgb[:, :, 0] = (ch_norm * r).astype(np.uint8)
                        ch_rgb[:, :, 1] = (ch_norm * g).astype(np.uint8)
                        ch_rgb[:, :, 2] = (ch_norm * b).astype(np.uint8)

                        if roi.roi_type != 'rect':
                            for c_idx in range(3):
                                ch_rgb[:, :, c_idx] = ch_rgb[:, :, c_idx] * roi_mask_local

                        ch_name = params.get('name', f'ch{i+1}')
                        pil = Image.fromarray(ch_rgb)
                        pil.save(os.path.join(roi_folder, f"{roi.name}-{ch_name}.tif"))

                self.after(0, lambda: self.status_var.set(
                    f"Saved {len(self.rois)} ROIs to {os.path.basename(base_folder)}"))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Save Error", str(e)))

        threading.Thread(target=do_save, daemon=True).start()

    def _export_csv(self):
        """Export per-ROI, per-channel statistics to CSV."""
        if not self.channels:
            messagebox.showinfo("No data", "Load an image first.")
            return

        path = filedialog.asksaveasfilename(
            title="Export Analysis CSV",
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv"), ("All", "*.*")],
            initialfile=f"{self.current_file or 'analysis'}_roi_stats.csv"
        )
        if not path:
            return

        import csv
        params_list = [ctrl.get_params() for ctrl in self.channel_controls]
        ch_names = [p.get('name', f'ch{i+1}') for i, p in enumerate(params_list)]

        # Find DAPI channel (first channel or one named DAPI)
        dapi_idx = 0
        for i, name in enumerate(ch_names):
            if 'dapi' in name.lower():
                dapi_idx = i
                break

        with open(path, 'w', newline='') as f:
            writer = csv.writer(f)
            # Header
            header = ['ROI_Name', 'ROI_Type', 'Center_X', 'Center_Y',
                      'Width_px', 'Height_px', 'Channel', 'Color',
                      'Mean_Intensity', 'Std_Intensity', 'Median_Intensity',
                      'Min_Intensity', 'Max_Intensity',
                      'Ratio_to_DAPI', 'Adjusted_Min', 'Adjusted_Max', 'Brightness']
            writer.writerow(header)

            # Compute for ROIs or entire image
            rois_to_analyze = self.rois if self.rois else [None]

            for roi in rois_to_analyze:
                if roi is None:
                    roi_name = 'Whole_Image'
                    roi_type = 'full'
                    cx_val, cy_val = 0, 0
                    w_val, h_val = 0, 0
                else:
                    roi_name = roi.name
                    roi_type = roi.roi_type
                    x1, y1, x2, y2 = roi.bbox
                    cx_val = (x1 + x2) / 2
                    cy_val = (y1 + y2) / 2
                    w_val = x2 - x1
                    h_val = y2 - y1

                # Compute adjusted intensities per channel
                ch_means = []
                for i, (ch, params) in enumerate(zip(self.channels, params_list)):
                    if not params['visible']:
                        ch_means.append(0)
                        continue

                    preview = ch.preview
                    if roi is not None:
                        px1, py1, px2, py2 = int(x1), int(y1), int(x2), int(y2)
                        px1 = max(0, px1); py1 = max(0, py1)
                        px2 = min(preview.shape[1], px2)
                        py2 = min(preview.shape[0], py2)
                        region_data = preview[py1:py2, px1:px2].copy()
                        if roi.roi_type != 'rect':
                            mask = roi.get_mask(py2 - py1, px2 - px1, ds_factor=1)
                            region_data = region_data[mask]
                    else:
                        region_data = preview.ravel()

                    # Apply current contrast/brightness
                    cmin, cmax = params['min'], params['max']
                    if cmax <= cmin:
                        cmax = cmin + 1
                    adjusted = np.clip((region_data - cmin) / (cmax - cmin), 0, 1)
                    adjusted *= params['brightness']
                    np.clip(adjusted, 0, 1, out=adjusted)
                    nz = adjusted[adjusted > 0.01]

                    if len(nz) > 0:
                        mean_val = float(np.mean(nz))
                        std_val = float(np.std(nz))
                        med_val = float(np.median(nz))
                        min_val = float(np.min(nz))
                        max_val = float(np.max(nz))
                    else:
                        mean_val = std_val = med_val = min_val = max_val = 0.0

                    ch_means.append(mean_val)

                    writer.writerow([
                        roi_name, roi_type,
                        f"{cx_val:.1f}", f"{cy_val:.1f}",
                        f"{w_val:.0f}", f"{h_val:.0f}",
                        ch_names[i], params['color_name'],
                        f"{mean_val:.4f}", f"{std_val:.4f}",
                        f"{med_val:.4f}", f"{min_val:.4f}", f"{max_val:.4f}",
                        f"{mean_val / max(0.001, ch_means[dapi_idx]) if i != dapi_idx else 1.0:.4f}",
                        f"{params['min']:.0f}", f"{params['max']:.0f}",
                        f"{params['brightness']:.2f}"
                    ])

        self.status_var.set(f"CSV exported → {os.path.basename(path)}")

    def _render_fullres_composite(self, region=None):
        """
        Render composite at full resolution.
        region: (x1, y1, x2, y2) in full-res pixels, or None for entire image.
        Returns uint8 RGB numpy array.
        """
        if not self.channels:
            return None

        params_list = [ctrl.get_params() for ctrl in self.channel_controls]

        ch0 = self.channels[0]
        if region:
            x1, y1, x2, y2 = [int(v) for v in region]
            x1 = max(0, x1); y1 = max(0, y1)
            x2 = min(ch0.full_w, x2); y2 = min(ch0.full_h, y2)
            h, w = y2 - y1, x2 - x1
        else:
            h, w = ch0.full_h, ch0.full_w
            x1, y1, x2, y2 = 0, 0, w, h

        composite = np.zeros((h, w, 3), dtype=np.float64)

        def process_channel(args):
            ch_data, params = args
            if not params['visible']:
                return None
            # Read the region from full-res data
            data = ch_data.full_data[y1:y2, x1:x2].astype(np.float64)
            cmin, cmax = params['min'], params['max']
            if cmax <= cmin:
                cmax = cmin + 1
            data = (data - cmin) / (cmax - cmin)
            np.clip(data, 0, 1, out=data)
            data *= params['brightness']
            np.clip(data, 0, 1, out=data)

            r, g, b = params['color']
            rgb = np.zeros((h, w, 3), dtype=np.float64)
            rgb[:, :, 0] = data * (r / 255.0)
            rgb[:, :, 1] = data * (g / 255.0)
            rgb[:, :, 2] = data * (b / 255.0)
            return rgb

        # Process channels in parallel
        with ThreadPoolExecutor(max_workers=NUM_WORKERS) as pool:
            futures = list(pool.map(process_channel,
                                    [(ch, p) for ch, p in zip(self.channels, params_list)]))

        for result in futures:
            if result is not None:
                composite = 1 - (1 - composite) * (1 - result)

        composite = np.clip(composite * 255, 0, 255).astype(np.uint8)
        return composite

    def _save_composite(self):
        if not self.channels:
            messagebox.showinfo("No data", "Load an image first.")
            return

        path = filedialog.asksaveasfilename(
            title="Save Composite Image",
            defaultextension=".tif",
            filetypes=[("TIFF files", "*.tif"), ("PNG files", "*.png"), ("All", "*.*")],
            initialfile=f"{self.current_file}_composite.tif"
        )
        if not path:
            return

        self.status_var.set("Rendering full-resolution composite...")
        self.update_idletasks()

        def do_save():
            try:
                rgb = self._render_fullres_composite()
                if rgb is None:
                    return
                dpi = int(self.dpi_var.get())
                if path.lower().endswith('.png'):
                    pil = Image.fromarray(rgb)
                    pil.save(path, dpi=(dpi, dpi))
                else:
                    tifffile.imwrite(path, rgb)
                self.after(0, lambda: self.status_var.set(f"Saved composite → {os.path.basename(path)}"))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Save Error", str(e)))
                self.after(0, lambda: self.status_var.set("Save failed"))

        threading.Thread(target=do_save, daemon=True).start()

    def _save_channels(self):
        if not self.channels:
            messagebox.showinfo("No data", "Load an image first.")
            return

        folder = filedialog.askdirectory(title="Select folder to save individual channels")
        if not folder:
            return

        self.status_var.set("Saving individual channels...")
        self.update_idletasks()

        params_list = [ctrl.get_params() for ctrl in self.channel_controls]

        def do_save():
            try:
                dpi = int(self.dpi_var.get())
                for i, (ch, params) in enumerate(zip(self.channels, params_list)):
                    if not params['visible']:
                        continue
                    data = ch.full_data[:, :].astype(np.float64)
                    cmin, cmax = params['min'], params['max']
                    if cmax <= cmin:
                        cmax = cmin + 1
                    data = (data - cmin) / (cmax - cmin)
                    np.clip(data, 0, 1, out=data)
                    data *= params['brightness']
                    np.clip(data, 0, 1, out=data)

                    r, g, b = params['color']
                    h, w = data.shape
                    rgb = np.zeros((h, w, 3), dtype=np.uint8)
                    rgb[:, :, 0] = np.clip(data * r, 0, 255).astype(np.uint8)
                    rgb[:, :, 1] = np.clip(data * g, 0, 255).astype(np.uint8)
                    rgb[:, :, 2] = np.clip(data * b, 0, 255).astype(np.uint8)

                    out_path = os.path.join(folder, f"{self.current_file}_ch{i+1}_{params['color_name']}.tif")
                    tifffile.imwrite(out_path, rgb)
                    self.after(0, lambda n=i+1: self.status_var.set(f"Saved channel {n}..."))

                self.after(0, lambda: self.status_var.set(f"Saved {len(self.channels)} channels to {os.path.basename(folder)}"))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Save Error", str(e)))
                self.after(0, lambda: self.status_var.set("Save failed"))

        threading.Thread(target=do_save, daemon=True).start()

    def _open_merge_popup(self):
        """Open the merge view popup. Auto-loads sibling channels if only 1 is loaded."""
        if not self.channels:
            messagebox.showinfo("No data", "Load an image first.")
            return

        channels = list(self.channels)
        params_list = [ctrl.get_params() for ctrl in self.channel_controls]
        ch_names = []

        # If only 1 channel loaded, try to find sibling channel files
        if len(channels) == 1:
            ch_path = channels[0].path
            ch_dir = os.path.dirname(ch_path)
            ch_base = os.path.basename(ch_path)

            # Find all TIF files in the same directory
            sibling_tifs = sorted([
                f for f in os.listdir(ch_dir)
                if f.lower().endswith(('.tif', '.tiff'))
                and os.path.join(ch_dir, f) != ch_path
            ])

            if sibling_tifs:
                self.status_var.set(f"Loading {len(sibling_tifs)} sibling channels for merge...")
                self.update_idletasks()
                for sib in sibling_tifs:
                    try:
                        sib_path = os.path.join(ch_dir, sib)
                        ch_data = load_channel(sib_path)
                        channels.append(ch_data)
                    except Exception:
                        pass

                # Build params for new channels with different default colors
                for i in range(len(params_list), len(channels)):
                    ch = channels[i]
                    p = {
                        'visible': True,
                        'color_name': DEFAULT_COLORS[i % len(DEFAULT_COLORS)],
                        'color': IF_COLORS[DEFAULT_COLORS[i % len(DEFAULT_COLORS)]],
                        'min': ch.vmin, 'max': ch.vmax,
                        'brightness': 1.0,
                    }
                    params_list.append(p)
                # Also set first channel color
                params_list[0]['color_name'] = DEFAULT_COLORS[0]
                params_list[0]['color'] = IF_COLORS[DEFAULT_COLORS[0]]

        # Build channel names
        for i, ch in enumerate(channels):
            name = os.path.splitext(os.path.basename(ch.path))[0]
            parts = name.split('_')
            ch_names.append(parts[-1] if len(parts) > 1 else name)

        self.status_var.set(f"Opening merge with {len(channels)} channels")
        MergePopup(self, channels, params_list, ch_names, self.current_file,
                   int(self.dpi_var.get()))

    def _open_mask_popup(self):
        """Open the brush mask adjustment popup."""
        if not self.channels:
            messagebox.showinfo("No data", "Load an image first.")
            return
        params_list = [ctrl.get_params() for ctrl in self.channel_controls]
        ch_names = []
        for i, ch in enumerate(self.channels):
            entry = self.file_entries.get(self.current_file)
            if entry and entry[0] == 'folder':
                name = os.path.splitext(os.path.basename(ch.path))[0]
                parts = name.split('_')
                ch_names.append(parts[-1] if len(parts) > 1 else name)
            else:
                ch_names.append(f"Channel {i+1}")
        MaskAdjustPopup(self, self.channels, params_list, ch_names,
                        self.current_file, int(self.dpi_var.get()))

# ─── Merge Popup ──────────────────────────────────────────────────────────────

class MergePopup(tk.Toplevel):
    """Popup window for selecting channels to merge and viewing the composite."""

    def __init__(self, parent, channels, params_list, ch_names, file_name, dpi):
        super().__init__(parent)
        self.title(f"Merge View — {file_name}")
        self.geometry("1200x800")
        self.channels = channels
        self.params_list = [dict(p) for p in params_list]  # copy
        self.ch_names = ch_names
        self.file_name = file_name
        self.dpi = dpi
        self.zoom_level = 1.0
        self.pan_offset = [0, 0]
        self._update_pending = False
        self._tk_image = None
        self.executor = ThreadPoolExecutor(max_workers=NUM_WORKERS)

        self._build_ui()
        self._bind_events()
        self.after(100, self._zoom_fit)

    def _build_ui(self):
        # Left: scrollable channel controls
        left = ttk.Frame(self, width=220)
        left.pack(side='left', fill='y', padx=4, pady=4)
        left.pack_propagate(False)

        ttk.Label(left, text="Select Channels to Merge",
                  font=('Helvetica', 13, 'bold')).pack(pady=(0, 8))

        self.ch_vars = []
        self.color_vars = []
        self.min_vars = []
        self.max_vars = []
        self.brt_vars = []

        # Scrollable channel controls
        ctrl_canvas = tk.Canvas(left, highlightthickness=0)
        ctrl_sb = ttk.Scrollbar(left, orient='vertical', command=ctrl_canvas.yview)
        ctrl_inner = ttk.Frame(ctrl_canvas)
        ctrl_inner.bind('<Configure>',
            lambda e: ctrl_canvas.configure(scrollregion=ctrl_canvas.bbox('all')))
        ctrl_canvas.create_window((0, 0), window=ctrl_inner, anchor='nw')
        ctrl_canvas.configure(yscrollcommand=ctrl_sb.set)
        ctrl_sb.pack(side='right', fill='y')
        ctrl_canvas.pack(side='left', fill='both', expand=True)

        for i, (name, params) in enumerate(zip(self.ch_names, self.params_list)):
            ch_fr = ttk.LabelFrame(ctrl_inner, text=name, padding=4)
            ch_fr.pack(fill='x', pady=3, padx=2)

            # Top row: checkbox + color
            top = ttk.Frame(ch_fr)
            top.pack(fill='x')
            var = tk.BooleanVar(value=True)
            var.trace_add('write', lambda *a: self._schedule_update())
            self.ch_vars.append(var)
            ttk.Checkbutton(top, variable=var, text="On").pack(side='left')

            color_var = tk.StringVar(value=params['color_name'])
            color_var.trace_add('write', lambda *a: self._schedule_update())
            self.color_vars.append(color_var)
            ttk.Combobox(top, textvariable=color_var,
                        values=list(IF_COLORS.keys()), width=13,
                        state='readonly').pack(side='right')

            data_max = float(self.channels[i].preview.max()) if i < len(self.channels) else 65535

            # Min slider
            min_f = ttk.Frame(ch_fr)
            min_f.pack(fill='x')
            ttk.Label(min_f, text="Min:", width=4).pack(side='left')
            mv = tk.DoubleVar(value=params['min'])
            mv.trace_add('write', lambda *a: self._schedule_update())
            ttk.Scale(min_f, from_=0, to=data_max, variable=mv,
                     orient='horizontal').pack(side='left', fill='x', expand=True)
            self.min_vars.append(mv)

            # Max slider
            max_f = ttk.Frame(ch_fr)
            max_f.pack(fill='x')
            ttk.Label(max_f, text="Max:", width=4).pack(side='left')
            xv = tk.DoubleVar(value=params['max'])
            xv.trace_add('write', lambda *a: self._schedule_update())
            ttk.Scale(max_f, from_=0, to=data_max, variable=xv,
                     orient='horizontal').pack(side='left', fill='x', expand=True)
            self.max_vars.append(xv)

            # Brightness slider
            brt_f = ttk.Frame(ch_fr)
            brt_f.pack(fill='x')
            ttk.Label(brt_f, text="Brt:", width=4).pack(side='left')
            bv = tk.DoubleVar(value=params.get('brightness', 1.0))
            bv.trace_add('write', lambda *a: self._schedule_update())
            ttk.Scale(brt_f, from_=0.0, to=3.0, variable=bv,
                     orient='horizontal').pack(side='left', fill='x', expand=True)
            self.brt_vars.append(bv)

        # ── Bottom buttons (inside left panel, below scroll) ──
        ttk.Separator(left, orient='horizontal').pack(fill='x', pady=4)
        btn_fr = ttk.Frame(left)
        btn_fr.pack(fill='x', padx=2)
        ttk.Button(btn_fr, text="All On", command=self._select_all).pack(side='left', fill='x', expand=True, padx=1)
        ttk.Button(btn_fr, text="All Off", command=self._deselect_all).pack(side='left', fill='x', expand=True, padx=1)

        zoom_fr = ttk.Frame(left)
        zoom_fr.pack(fill='x', padx=2, pady=2)
        ttk.Button(zoom_fr, text="➕", command=lambda: self._zoom_step(1.5), width=3).pack(side='left', padx=1)
        ttk.Button(zoom_fr, text="➖", command=lambda: self._zoom_step(1/1.5), width=3).pack(side='left', padx=1)
        ttk.Button(zoom_fr, text="Fit", command=self._zoom_fit).pack(side='left', fill='x', expand=True, padx=1)
        ttk.Button(zoom_fr, text="1:1", command=self._zoom_100).pack(side='left', fill='x', expand=True, padx=1)

        self.zoom_label = ttk.Label(left, text="Zoom: fit")
        self.zoom_label.pack(pady=2)

        self.hd_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(left, text="HD Full Resolution",
                       variable=self.hd_var,
                       command=self._schedule_update).pack(fill='x', padx=2)

        ttk.Button(left, text="💾 Save Merged", command=self._save_merged).pack(fill='x', padx=2, pady=4)

        # Right: canvas
        self.canvas = tk.Canvas(self, bg='#11111b', highlightthickness=0, cursor='crosshair')
        self.canvas.pack(side='right', fill='both', expand=True)

    def _bind_events(self):
        self.canvas.bind('<MouseWheel>', self._on_scroll)
        self.canvas.bind('<ButtonPress-1>', self._on_pan_start)
        self.canvas.bind('<B1-Motion>', self._on_pan_drag)
        self.canvas.bind('<Configure>', lambda e: self._schedule_update())

    def _select_all(self):
        for v in self.ch_vars:
            v.set(True)

    def _deselect_all(self):
        for v in self.ch_vars:
            v.set(False)

    def _schedule_update(self):
        if not self._update_pending:
            self._update_pending = True
            self.after(30, self._do_update)

    def _do_update(self):
        self._update_pending = False
        self._render()

    def _get_active_params(self):
        """Get current params with updated visibility, colors, and contrast from popup controls."""
        result = []
        for i, params in enumerate(self.params_list):
            p = dict(params)
            p['visible'] = self.ch_vars[i].get()
            color_name = self.color_vars[i].get()
            p['color_name'] = color_name
            p['color'] = IF_COLORS.get(color_name, (255, 255, 255))
            p['min'] = self.min_vars[i].get()
            p['max'] = self.max_vars[i].get()
            p['brightness'] = self.brt_vars[i].get()
            result.append(p)
        return result

    def _render(self):
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        if canvas_w < 10 or canvas_h < 10:
            return

        ch0 = self.channels[0]
        ds = ch0.ds_factor
        params_list = self._get_active_params()

        # HD mode: load full-res data for the visible viewport
        if self.hd_var.get() and self.zoom_level > ds * 0.3:
            try:
                self._render_hd(canvas_w, canvas_h, params_list)
                return
            except Exception:
                pass  # fall through to preview rendering

        # Decide whether to use full-res or preview
        use_fullres = (self.zoom_level > ds * 0.5) and not self.hd_var.get()

        if use_fullres:
            full_zoom = self.zoom_level / ds
            cx_full = ch0.full_w / 2 - self.pan_offset[0] / full_zoom
            cy_full = ch0.full_h / 2 - self.pan_offset[1] / full_zoom
            half_vw = canvas_w / 2 / full_zoom
            half_vh = canvas_h / 2 / full_zoom

            fx1 = int(max(0, cx_full - half_vw - 2))
            fy1 = int(max(0, cy_full - half_vh - 2))
            fx2 = int(min(ch0.full_w, cx_full + half_vw + 2))
            fy2 = int(min(ch0.full_h, cy_full + half_vh + 2))

            if fx2 <= fx1 or fy2 <= fy1:
                return

            region_h, region_w = fy2 - fy1, fx2 - fx1
            composite = np.zeros((region_h, region_w, 3), dtype=np.float32)

            for ch_data, params in zip(self.channels, params_list):
                if not params['visible']:
                    continue
                data = ch_data.full_data[fy1:fy2, fx1:fx2].astype(np.float32)
                cmin, cmax = params['min'], params['max']
                if cmax <= cmin:
                    cmax = cmin + 1
                data = (data - cmin) / (cmax - cmin)
                np.clip(data, 0, 1, out=data)
                data *= params['brightness']
                np.clip(data, 0, 1, out=data)
                r, g, b = params['color']
                ch_rgb = np.zeros((region_h, region_w, 3), dtype=np.float32)
                ch_rgb[:, :, 0] = data * (r / 255.0)
                ch_rgb[:, :, 1] = data * (g / 255.0)
                ch_rgb[:, :, 2] = data * (b / 255.0)
                composite = 1 - (1 - composite) * (1 - ch_rgb)

            composite = np.clip(composite * 255, 0, 255).astype(np.uint8)
            out_w = max(1, int(region_w * full_zoom))
            out_h = max(1, int(region_h * full_zoom))

            pil_img = Image.fromarray(composite)
            pil_img = pil_img.resize((out_w, out_h),
                                     Image.NEAREST if full_zoom > 3 else Image.LANCZOS)

            result = Image.new('RGB', (canvas_w, canvas_h), (17, 17, 27))
            screen_x = int((fx1 - cx_full) * full_zoom + canvas_w / 2)
            screen_y = int((fy1 - cy_full) * full_zoom + canvas_h / 2)
            result.paste(pil_img, (screen_x, screen_y))

        else:
            # Preview-based rendering
            prev_h, prev_w = ch0.preview.shape
            composite = np.zeros((prev_h, prev_w, 3), dtype=np.float32)

            for ch_data, params in zip(self.channels, params_list):
                if not params['visible']:
                    continue
                img = ch_data.preview.copy()
                cmin, cmax = params['min'], params['max']
                if cmax <= cmin:
                    cmax = cmin + 1
                img = (img - cmin) / (cmax - cmin)
                np.clip(img, 0, 1, out=img)
                img *= params['brightness']
                np.clip(img, 0, 1, out=img)
                r, g, b = params['color']
                ch_rgb = np.zeros((prev_h, prev_w, 3), dtype=np.float32)
                ch_rgb[:, :, 0] = img * (r / 255.0)
                ch_rgb[:, :, 1] = img * (g / 255.0)
                ch_rgb[:, :, 2] = img * (b / 255.0)
                composite = 1 - (1 - composite) * (1 - ch_rgb)

            composite = np.clip(composite * 255, 0, 255).astype(np.uint8)
            disp_w = max(1, int(prev_w * self.zoom_level))
            disp_h = max(1, int(prev_h * self.zoom_level))

            pil_img = Image.fromarray(composite)
            pil_img = pil_img.resize((disp_w, disp_h),
                                     Image.NEAREST if self.zoom_level > 2 else Image.LANCZOS)

            result = Image.new('RGB', (canvas_w, canvas_h), (17, 17, 27))
            x = canvas_w // 2 + self.pan_offset[0] - disp_w // 2
            y = canvas_h // 2 + self.pan_offset[1] - disp_h // 2
            result.paste(pil_img, (x, y))

        self._tk_image = ImageTk.PhotoImage(result)
        self.canvas.delete('all')
        self.canvas.create_image(0, 0, image=self._tk_image, anchor='nw')

    def _render_hd(self, canvas_w, canvas_h, params_list):
        """Render the visible viewport from full-resolution data."""
        ch0 = self.channels[0]
        ds = ch0.ds_factor
        full_zoom = self.zoom_level / ds

        cx_full = ch0.full_w / 2 - self.pan_offset[0] / full_zoom
        cy_full = ch0.full_h / 2 - self.pan_offset[1] / full_zoom
        half_vw = canvas_w / 2 / full_zoom
        half_vh = canvas_h / 2 / full_zoom

        fx1 = int(max(0, cx_full - half_vw - 2))
        fy1 = int(max(0, cy_full - half_vh - 2))
        fx2 = int(min(ch0.full_w, cx_full + half_vw + 2))
        fy2 = int(min(ch0.full_h, cy_full + half_vh + 2))

        if fx2 <= fx1 or fy2 <= fy1:
            return

        region_h, region_w = fy2 - fy1, fx2 - fx1
        composite = np.zeros((region_h, region_w, 3), dtype=np.float32)

        for ch_data, params in zip(self.channels, params_list):
            if not params['visible']:
                continue
            data = ch_data.full_data[fy1:fy2, fx1:fx2].astype(np.float32)
            cmin, cmax = params['min'], params['max']
            if cmax <= cmin:
                cmax = cmin + 1
            data = (data - cmin) / (cmax - cmin)
            np.clip(data, 0, 1, out=data)
            data *= params['brightness']
            np.clip(data, 0, 1, out=data)
            r, g, b = params['color']
            ch_rgb = np.zeros((region_h, region_w, 3), dtype=np.float32)
            ch_rgb[:, :, 0] = data * (r / 255.0)
            ch_rgb[:, :, 1] = data * (g / 255.0)
            ch_rgb[:, :, 2] = data * (b / 255.0)
            composite = 1 - (1 - composite) * (1 - ch_rgb)

        composite = np.clip(composite * 255, 0, 255).astype(np.uint8)
        out_w = max(1, int(region_w * full_zoom))
        out_h = max(1, int(region_h * full_zoom))

        pil_img = Image.fromarray(composite)
        pil_img = pil_img.resize((out_w, out_h),
                                 Image.NEAREST if full_zoom > 3 else Image.LANCZOS)

        result = Image.new('RGB', (canvas_w, canvas_h), (17, 17, 27))
        screen_x = int((fx1 - cx_full) * full_zoom + canvas_w / 2)
        screen_y = int((fy1 - cy_full) * full_zoom + canvas_h / 2)
        result.paste(pil_img, (screen_x, screen_y))

        self._tk_image = ImageTk.PhotoImage(result)
        self.canvas.delete('all')
        self.canvas.create_image(0, 0, image=self._tk_image, anchor='nw')

    # Zoom / Pan
    def _on_scroll(self, event):
        factor = 1.35 if event.delta > 0 else 1 / 1.35
        cx = self.canvas.winfo_width() / 2
        cy = self.canvas.winfo_height() / 2
        mx = event.x - cx - self.pan_offset[0]
        my = event.y - cy - self.pan_offset[1]
        old_zoom = self.zoom_level
        self.zoom_level = max(0.01, self.zoom_level * factor)
        ratio = self.zoom_level / old_zoom
        self.pan_offset[0] -= mx * (ratio - 1)
        self.pan_offset[1] -= my * (ratio - 1)
        self.zoom_label.config(text=f"Zoom: {self.zoom_level:.1%}")
        self._schedule_update()

    def _zoom_step(self, factor):
        self.zoom_level = max(0.01, self.zoom_level * factor)
        self.zoom_label.config(text=f"Zoom: {self.zoom_level:.1%}")
        self._schedule_update()

    def _zoom_fit(self):
        if not self.channels:
            return
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        if canvas_w < 10: canvas_w = 800
        if canvas_h < 10: canvas_h = 600
        prev_h, prev_w = self.channels[0].preview.shape
        self.zoom_level = min(canvas_w / prev_w, canvas_h / prev_h) * 0.95
        self.pan_offset = [0, 0]
        self.zoom_label.config(text=f"Zoom: {self.zoom_level:.1%}")
        self._schedule_update()

    def _zoom_100(self):
        self.zoom_level = 1.0
        self.pan_offset = [0, 0]
        self.zoom_label.config(text="Zoom: 100%")
        self._schedule_update()

    def _on_pan_start(self, event):
        self._pan_sx = event.x
        self._pan_sy = event.y
        self._pan_so = list(self.pan_offset)

    def _on_pan_drag(self, event):
        self.pan_offset[0] = self._pan_so[0] + (event.x - self._pan_sx)
        self.pan_offset[1] = self._pan_so[1] + (event.y - self._pan_sy)
        self._schedule_update()

    def _save_merged(self):
        path = filedialog.asksaveasfilename(
            parent=self,
            title="Save Merged Image",
            defaultextension=".tif",
            filetypes=[("TIFF files", "*.tif"), ("PNG files", "*.png")],
            initialfile=f"{self.file_name}_merged.tif"
        )
        if not path:
            return

        params_list = self._get_active_params()
        ch0 = self.channels[0]
        h, w = ch0.full_h, ch0.full_w

        def do_save():
            try:
                composite = np.zeros((h, w, 3), dtype=np.float64)
                for ch_data, params in zip(self.channels, params_list):
                    if not params['visible']:
                        continue
                    data = ch_data.full_data[:, :].astype(np.float64)
                    cmin, cmax = params['min'], params['max']
                    if cmax <= cmin:
                        cmax = cmin + 1
                    data = (data - cmin) / (cmax - cmin)
                    np.clip(data, 0, 1, out=data)
                    data *= params['brightness']
                    np.clip(data, 0, 1, out=data)
                    r, g, b = params['color']
                    ch_rgb = np.zeros((h, w, 3), dtype=np.float64)
                    ch_rgb[:, :, 0] = data * (r / 255.0)
                    ch_rgb[:, :, 1] = data * (g / 255.0)
                    ch_rgb[:, :, 2] = data * (b / 255.0)
                    composite = 1 - (1 - composite) * (1 - ch_rgb)

                composite = np.clip(composite * 255, 0, 255).astype(np.uint8)
                if path.lower().endswith('.png'):
                    pil = Image.fromarray(composite)
                    pil.save(path, dpi=(self.dpi, self.dpi))
                else:
                    tifffile.imwrite(path, composite)
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Save Error", str(e), parent=self))

        threading.Thread(target=do_save, daemon=True).start()


# ─── Brush Mask Adjustment Popup ──────────────────────────────────────────────

class MaskAdjustPopup(tk.Toplevel):
    """
    Popup with a brush tool to paint a mask. Contrast/brightness adjustments
    apply only inside the mask. Mask edges are feathered with a 15% Gaussian
    gradient for smooth transitions.
    """

    def __init__(self, parent, channels, params_list, ch_names, file_name, dpi):
        super().__init__(parent)
        self.parent_app = parent  # reference to FluoroView for applying changes
        self.title(f"Brush Mask Adjust — {file_name}")
        self.geometry("1400x900")
        self.channels = channels
        self.base_params = [dict(p) for p in params_list]
        self.mask_params = [dict(p) for p in params_list]
        self.ch_names = ch_names
        self.file_name = file_name
        self.dpi = dpi

        # Use channel preview data directly
        ch0 = channels[0]
        self.prev_h, self.prev_w = ch0.preview.shape
        self.ds = ch0.ds_factor

        # Mask state
        self.mask = np.zeros((self.prev_h, self.prev_w), dtype=np.float32)
        self.feathered_mask = np.zeros_like(self.mask)
        self.mask_history = []
        self.brush_size = 15
        self.painting = False
        self._last_paint = None

        # View state
        self.zoom_level = 1.0
        self.pan_offset = [0, 0]
        self._update_pending = False
        self._tk_image = None

        self._build_ui()
        self._bind_events()
        self.after(200, self._zoom_fit)

    def _build_ui(self):
        # ── Left panel: controls ──
        left = ttk.Frame(self, width=300)
        left.pack(side='left', fill='y', padx=8, pady=8)
        left.pack_propagate(False)

        ttk.Label(left, text="🖌 Brush Mask Tool",
                  font=('Helvetica', 13, 'bold')).pack(pady=(0, 8))

        # Brush controls
        brush_frame = ttk.LabelFrame(left, text="Brush", padding=6)
        brush_frame.pack(fill='x', pady=4)

        size_fr = ttk.Frame(brush_frame)
        size_fr.pack(fill='x')
        ttk.Label(size_fr, text="Size:").pack(side='left')
        self.size_var = tk.IntVar(value=20)
        self.size_slider = ttk.Scale(size_fr, from_=3, to=150,
                                     variable=self.size_var, orient='horizontal',
                                     command=lambda v: self._update_brush_size())
        self.size_slider.pack(side='left', fill='x', expand=True)
        self.size_label = ttk.Label(size_fr, text="20px", width=6)
        self.size_label.pack(side='left')

        mode_fr = ttk.Frame(brush_frame)
        mode_fr.pack(fill='x', pady=4)
        self.mode_var = tk.StringVar(value="paint")
        ttk.Radiobutton(mode_fr, text="Paint", variable=self.mode_var,
                       value="paint").pack(side='left', padx=4)
        ttk.Radiobutton(mode_fr, text="Erase", variable=self.mode_var,
                       value="erase").pack(side='left', padx=4)

        btn_fr = ttk.Frame(brush_frame)
        btn_fr.pack(fill='x', pady=2)
        ttk.Button(btn_fr, text="Undo", command=self._undo).pack(side='left', fill='x', expand=True, padx=1)
        ttk.Button(btn_fr, text="Clear Mask", command=self._clear_mask).pack(side='left', fill='x', expand=True, padx=1)

        self.mask_info = ttk.Label(brush_frame, text="Mask: 0% painted")
        self.mask_info.pack(pady=2)

        # Feather info
        ttk.Label(brush_frame, text="Auto 15% edge feathering",
                  font=('Helvetica', 9, 'italic'), foreground='gray').pack()

        ttk.Separator(left, orient='horizontal').pack(fill='x', pady=8)

        # Mask region adjustments
        adj_frame = ttk.LabelFrame(left, text="Mask Region Adjustments (per channel)", padding=6)
        adj_frame.pack(fill='both', expand=True, pady=4)

        # Scrollable area for channel controls
        adj_canvas = tk.Canvas(adj_frame, highlightthickness=0)
        adj_sb = ttk.Scrollbar(adj_frame, orient='vertical', command=adj_canvas.yview)
        adj_inner = ttk.Frame(adj_canvas)
        adj_inner.bind('<Configure>',
            lambda e: adj_canvas.configure(scrollregion=adj_canvas.bbox('all')))
        adj_canvas.create_window((0, 0), window=adj_inner, anchor='nw')
        adj_canvas.configure(yscrollcommand=adj_sb.set)
        adj_sb.pack(side='right', fill='y')
        adj_canvas.pack(side='left', fill='both', expand=True)

        self.mask_min_vars = []
        self.mask_max_vars = []
        self.mask_brt_vars = []

        for i, (name, params) in enumerate(zip(self.ch_names, self.mask_params)):
            ch_fr = ttk.Frame(adj_inner)
            ch_fr.pack(fill='x', pady=3)

            ttk.Label(ch_fr, text=name, font=('Helvetica', 10, 'bold')).pack(anchor='w')

            data_max = float(self.channels[i].preview.max())

            # Min slider
            min_fr = ttk.Frame(ch_fr)
            min_fr.pack(fill='x')
            ttk.Label(min_fr, text="Min:", width=4).pack(side='left')
            mv = tk.DoubleVar(value=params['min'])
            mv.trace_add('write', lambda *a: self._schedule_update())
            ttk.Scale(min_fr, from_=0, to=data_max, variable=mv,
                     orient='horizontal').pack(side='left', fill='x', expand=True)
            self.mask_min_vars.append(mv)

            # Max slider
            max_fr = ttk.Frame(ch_fr)
            max_fr.pack(fill='x')
            ttk.Label(max_fr, text="Max:", width=4).pack(side='left')
            xv = tk.DoubleVar(value=params['max'])
            xv.trace_add('write', lambda *a: self._schedule_update())
            ttk.Scale(max_fr, from_=0, to=data_max, variable=xv,
                     orient='horizontal').pack(side='left', fill='x', expand=True)
            self.mask_max_vars.append(xv)

            # Brightness slider
            brt_fr = ttk.Frame(ch_fr)
            brt_fr.pack(fill='x')
            ttk.Label(brt_fr, text="Brt:", width=4).pack(side='left')
            bv = tk.DoubleVar(value=params['brightness'])
            bv.trace_add('write', lambda *a: self._schedule_update())
            ttk.Scale(brt_fr, from_=0.0, to=3.0, variable=bv,
                     orient='horizontal').pack(side='left', fill='x', expand=True)
            self.mask_brt_vars.append(bv)

            ttk.Separator(ch_fr, orient='horizontal').pack(fill='x', pady=2)

        ttk.Separator(left, orient='horizontal').pack(fill='x', pady=8)

        # Zoom controls
        zoom_fr = ttk.Frame(left)
        zoom_fr.pack(fill='x', pady=2)
        ttk.Button(zoom_fr, text="Fit", command=self._zoom_fit).pack(side='left', fill='x', expand=True)
        ttk.Button(zoom_fr, text="➕", command=lambda: self._zoom_step(1.5)).pack(side='left', padx=1)
        ttk.Button(zoom_fr, text="➖", command=lambda: self._zoom_step(1/1.5)).pack(side='left', padx=1)

        # Apply buttons
        ttk.Button(left, text="✅ Apply to Channel", command=self._apply_to_channel).pack(fill='x', pady=2)
        ttk.Button(left, text="🔄 Apply to All", command=self._apply_to_all).pack(fill='x', pady=2)
        ttk.Button(left, text="💾 Save Result", command=self._save_result).pack(fill='x', pady=4)

        # ── Canvas ──
        self.canvas = tk.Canvas(self, bg='#11111b', highlightthickness=0, cursor='circle')
        self.canvas.pack(side='right', fill='both', expand=True)

    def _bind_events(self):
        self.canvas.bind('<ButtonPress-1>', self._on_press)
        self.canvas.bind('<B1-Motion>', self._on_drag)
        self.canvas.bind('<ButtonRelease-1>', self._on_release)
        self.canvas.bind('<MouseWheel>', self._on_scroll)
        self.canvas.bind('<ButtonPress-2>', self._on_pan_start)
        self.canvas.bind('<B2-Motion>', self._on_pan_drag)
        self.canvas.bind('<ButtonPress-3>', self._on_pan_start)
        self.canvas.bind('<B3-Motion>', self._on_pan_drag)
        self.canvas.bind('<Configure>', lambda e: self._schedule_update())

    def _update_brush_size(self):
        self.brush_size = int(self.size_var.get())
        self.size_label.config(text=f"{self.brush_size}px")

    def _canvas_to_img(self, cx, cy):
        """Convert canvas coords to preview image coords."""
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        disp_w = self.prev_w * self.zoom_level
        disp_h = self.prev_h * self.zoom_level
        img_left = canvas_w / 2 + self.pan_offset[0] - disp_w / 2
        img_top = canvas_h / 2 + self.pan_offset[1] - disp_h / 2
        ix = (cx - img_left) / self.zoom_level
        iy = (cy - img_top) / self.zoom_level
        return ix, iy

    def _paint_at(self, ix, iy):
        """Paint or erase a circle at image coords."""
        r = self.brush_size / 2
        y_min = int(max(0, iy - r))
        y_max = int(min(self.prev_h, iy + r + 1))
        x_min = int(max(0, ix - r))
        x_max = int(min(self.prev_w, ix + r + 1))

        if y_max <= y_min or x_max <= x_min:
            return

        yy, xx = np.ogrid[y_min:y_max, x_min:x_max]
        dist2 = (xx - ix) ** 2 + (yy - iy) ** 2
        circle = dist2 <= (r * r)

        if self.mode_var.get() == "erase":
            self.mask[y_min:y_max, x_min:x_max][circle] = 0
        else:
            self.mask[y_min:y_max, x_min:x_max][circle] = 1

    def _paint_line(self, x0, y0, x1, y1):
        """Paint circles along a line from (x0,y0) to (x1,y1) for smooth strokes."""
        dx = x1 - x0
        dy = y1 - y0
        dist = max(1, int(np.sqrt(dx*dx + dy*dy)))
        # Step size = half the brush radius for no gaps
        steps = max(1, int(dist / max(1, self.brush_size * 0.3)))
        for t in range(steps + 1):
            frac = t / max(1, steps)
            ix = x0 + dx * frac
            iy = y0 + dy * frac
            self._paint_at(ix, iy)

    def _feather_mask(self):
        """Apply 15% Gaussian feathering to mask edges."""
        from scipy.ndimage import gaussian_filter, distance_transform_edt
        # Compute feather radius as 15% of the average mask region extent
        mask_pixels = np.sum(self.mask > 0.5)
        if mask_pixels < 10:
            self.feathered_mask = self.mask.copy()
            return

        # Approximate region size for feather radius
        region_extent = np.sqrt(mask_pixels)
        feather_radius = max(2, region_extent * 0.15)

        # Use Gaussian blur on the binary mask for smooth edges
        self.feathered_mask = gaussian_filter(self.mask, sigma=feather_radius)
        # Normalize: keep interior at 1.0
        max_val = self.feathered_mask.max()
        if max_val > 0:
            # Rescale so that the interior stays at 1.0 and edges fade
            self.feathered_mask = np.clip(self.feathered_mask / max_val, 0, 1)
            # Only feather the edges, keep solid interior
            interior = self.mask > 0.5
            self.feathered_mask[interior] = np.maximum(
                self.feathered_mask[interior], self.mask[interior]
            )

    def _on_press(self, event):
        self.painting = True
        self.mask_history.append(self.mask.copy())
        if len(self.mask_history) > 20:
            self.mask_history.pop(0)
        ix, iy = self._canvas_to_img(event.x, event.y)
        self._paint_at(ix, iy)
        self._last_paint = (ix, iy)
        self._update_mask_info()
        self._schedule_update()

    def _on_drag(self, event):
        if self.painting:
            ix, iy = self._canvas_to_img(event.x, event.y)
            if hasattr(self, '_last_paint') and self._last_paint:
                self._paint_line(self._last_paint[0], self._last_paint[1], ix, iy)
            else:
                self._paint_at(ix, iy)
            self._last_paint = (ix, iy)
            self._schedule_update()

    def _on_release(self, event):
        self.painting = False
        self._last_paint = None
        self._feather_mask()
        self._update_mask_info()
        self._schedule_update()

    def _update_mask_info(self):
        pct = 100.0 * np.sum(self.mask > 0.5) / self.mask.size
        self.mask_info.config(text=f"Mask: {pct:.1f}% painted")

    def _undo(self):
        if self.mask_history:
            self.mask = self.mask_history.pop()
            self._feather_mask()
            self._update_mask_info()
            self._schedule_update()

    def _clear_mask(self):
        self.mask_history.append(self.mask.copy())
        self.mask = np.zeros_like(self.mask)
        self.feathered_mask = np.zeros_like(self.mask)
        self._update_mask_info()
        self._schedule_update()

    def _get_mask_params(self):
        """Get the mask-region adjustment parameters."""
        result = []
        for i, bp in enumerate(self.base_params):
            p = dict(bp)
            p['min'] = self.mask_min_vars[i].get()
            p['max'] = self.mask_max_vars[i].get()
            p['brightness'] = self.mask_brt_vars[i].get()
            result.append(p)
        return result

    def _schedule_update(self):
        if not self._update_pending:
            self._update_pending = True
            self.after(40, self._do_update)

    def _do_update(self):
        self._update_pending = False
        self._render()

    def _render(self):
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        if canvas_w < 10 or canvas_h < 10:
            return

        base_params = self.base_params
        mask_params = self._get_mask_params()
        fm = self.feathered_mask  # (H, W) float32 0-1

        # Render composites at low-res for speed
        composite_base = np.zeros((self.prev_h, self.prev_w, 3), dtype=np.float32)
        composite_mask = np.zeros((self.prev_h, self.prev_w, 3), dtype=np.float32)

        for i, ch_data in enumerate(self.channels):
            bp = base_params[i]
            mp = mask_params[i]
            if not bp['visible']:
                continue
            preview = ch_data.preview  # use original preview

            # Base region rendering
            cmin, cmax = bp['min'], bp['max']
            if cmax <= cmin:
                cmax = cmin + 1
            img_b = (preview - cmin) / (cmax - cmin)
            img_b = np.clip(img_b, 0, 1) * bp['brightness']
            np.clip(img_b, 0, 1, out=img_b)

            r, g, b = bp['color']
            ch_b = np.zeros((self.prev_h, self.prev_w, 3), dtype=np.float32)
            ch_b[:, :, 0] = img_b * (r / 255.0)
            ch_b[:, :, 1] = img_b * (g / 255.0)
            ch_b[:, :, 2] = img_b * (b / 255.0)
            composite_base = 1 - (1 - composite_base) * (1 - ch_b)

            # Mask region rendering
            cmin2, cmax2 = mp['min'], mp['max']
            if cmax2 <= cmin2:
                cmax2 = cmin2 + 1
            img_m = (preview - cmin2) / (cmax2 - cmin2)
            img_m = np.clip(img_m, 0, 1) * mp['brightness']
            np.clip(img_m, 0, 1, out=img_m)

            ch_m = np.zeros((self.prev_h, self.prev_w, 3), dtype=np.float32)
            ch_m[:, :, 0] = img_m * (r / 255.0)
            ch_m[:, :, 1] = img_m * (g / 255.0)
            ch_m[:, :, 2] = img_m * (b / 255.0)
            composite_mask = 1 - (1 - composite_mask) * (1 - ch_m)

        # Use raw mask during painting, feathered mask when not painting
        active_mask = self.mask if self.painting else self.feathered_mask
        fm3 = active_mask[:, :, np.newaxis]
        composite = composite_base * (1 - fm3) + composite_mask * fm3
        composite = np.clip(composite * 255, 0, 255).astype(np.uint8)

        # Draw mask outline for visibility
        pil_img = Image.fromarray(composite)

        # Resize for display
        disp_w = max(1, int(self.prev_w * self.zoom_level))
        disp_h = max(1, int(self.prev_h * self.zoom_level))
        pil_img = pil_img.resize((disp_w, disp_h),
                                 Image.NEAREST if self.zoom_level > 2 else Image.LANCZOS)

        # 40% transparent red overlay on mask area
        if np.any(self.mask > 0.5):
            mask_resized = Image.fromarray((self.mask * 255).astype(np.uint8))
            mask_resized = mask_resized.resize((disp_w, disp_h), Image.NEAREST)
            mask_arr = np.array(mask_resized)
            # Create RGBA red overlay: 40% opacity where mask is painted
            overlay_arr = np.zeros((disp_h, disp_w, 4), dtype=np.uint8)
            painted = mask_arr > 128
            overlay_arr[painted] = [255, 50, 50, 100]  # 40% red
            overlay = Image.fromarray(overlay_arr, 'RGBA')
            pil_img = pil_img.convert('RGBA')
            pil_img = Image.alpha_composite(pil_img, overlay)
            pil_img = pil_img.convert('RGB')

        # Place on canvas
        result = Image.new('RGB', (canvas_w, canvas_h), (17, 17, 27))
        x = canvas_w // 2 + self.pan_offset[0] - disp_w // 2
        y = canvas_h // 2 + self.pan_offset[1] - disp_h // 2
        result.paste(pil_img, (x, y))

        self._tk_image = ImageTk.PhotoImage(result)
        self.canvas.delete('all')
        self.canvas.create_image(0, 0, image=self._tk_image, anchor='nw')

    # ── Zoom / Pan ──
    def _on_scroll(self, event):
        factor = 1.35 if event.delta > 0 else 1 / 1.35
        cx = self.canvas.winfo_width() / 2
        cy = self.canvas.winfo_height() / 2
        mx = event.x - cx - self.pan_offset[0]
        my = event.y - cy - self.pan_offset[1]
        old_zoom = self.zoom_level
        self.zoom_level = max(0.01, self.zoom_level * factor)
        ratio = self.zoom_level / old_zoom
        self.pan_offset[0] -= mx * (ratio - 1)
        self.pan_offset[1] -= my * (ratio - 1)
        self._schedule_update()

    def _zoom_step(self, factor):
        self.zoom_level = max(0.01, self.zoom_level * factor)
        self._schedule_update()

    def _zoom_fit(self):
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        if canvas_w < 10: canvas_w = 900
        if canvas_h < 10: canvas_h = 700
        self.zoom_level = min(canvas_w / self.prev_w, canvas_h / self.prev_h) * 0.95
        self.pan_offset = [0, 0]
        self._schedule_update()

    def _on_pan_start(self, event):
        self._pan_sx = event.x
        self._pan_sy = event.y
        self._pan_so = list(self.pan_offset)

    def _on_pan_drag(self, event):
        self.pan_offset[0] = self._pan_so[0] + (event.x - self._pan_sx)
        self.pan_offset[1] = self._pan_so[1] + (event.y - self._pan_sy)
        self._schedule_update()

    def _get_temp_dir(self):
        """Get or create the temp directory for edited channel files."""
        ch0 = self.channels[0]
        base_dir = os.path.dirname(ch0.original_path)
        temp_dir = os.path.join(base_dir, '.fluoro_temp')
        os.makedirs(temp_dir, exist_ok=True)
        return temp_dir

    def _save_channel_temp(self, ch_idx):
        """Apply mask edits to a single channel and save to temp file."""
        ch_data = self.channels[ch_idx]
        bp = self.base_params[ch_idx]
        mp = self._get_mask_params()[ch_idx]
        fm = self.feathered_mask

        from scipy.ndimage import zoom as scipy_zoom
        # Upscale mask to full resolution
        full_h, full_w = ch_data.full_h, ch_data.full_w
        scale_y = full_h / self.prev_h
        scale_x = full_w / self.prev_w
        fm_full = scipy_zoom(fm, (scale_y, scale_x), order=1)
        fm_full = np.clip(fm_full, 0, 1)

        # Read full-res data
        data = ch_data.full_data[:, :].astype(np.float64)

        # Base processing
        cmin1, cmax1 = bp['min'], bp['max']
        if cmax1 <= cmin1: cmax1 = cmin1 + 1
        img_b = np.clip((data - cmin1) / (cmax1 - cmin1), 0, 1) * bp['brightness']
        np.clip(img_b, 0, 1, out=img_b)

        # Mask processing
        cmin2, cmax2 = mp['min'], mp['max']
        if cmax2 <= cmin2: cmax2 = cmin2 + 1
        img_m = np.clip((data - cmin2) / (cmax2 - cmin2), 0, 1) * mp['brightness']
        np.clip(img_m, 0, 1, out=img_m)

        # Blend and scale back to original data range
        blended = img_b * (1 - fm_full) + img_m * fm_full
        result = (blended * (cmax1 - cmin1) + cmin1).astype(data.dtype)

        # Save to temp
        temp_dir = self._get_temp_dir()
        orig_name = os.path.splitext(os.path.basename(ch_data.original_path))[0]
        temp_path = os.path.join(temp_dir, f"{orig_name}_edited.tif")
        tifffile.imwrite(temp_path, result)

        # Reload channel from temp
        ch_data.reload_from(temp_path)
        return temp_path

    def _apply_to_channel(self):
        """Apply mask edits to a user-selected channel, save temp file."""
        if np.sum(self.mask > 0.5) < 5:
            messagebox.showinfo("No mask", "Paint a mask region first.", parent=self)
            return

        # Let user pick which channel
        ch_names = [f"{i+1}: {n}" for i, n in enumerate(self.ch_names)]
        pick_win = tk.Toplevel(self)
        pick_win.title("Select Channel")
        pick_win.geometry("250x300")
        pick_win.transient(self)
        ttk.Label(pick_win, text="Apply mask edits to:").pack(pady=8)
        lb = tk.Listbox(pick_win, font=('Helvetica', 12))
        for n in ch_names:
            lb.insert('end', n)
        lb.pack(fill='both', expand=True, padx=8, pady=4)
        lb.selection_set(0)

        def do_apply():
            sel = lb.curselection()
            if not sel:
                return
            idx = sel[0]
            pick_win.destroy()
            self.config(cursor='wait')
            self.update_idletasks()

            def save_thread():
                try:
                    path = self._save_channel_temp(idx)
                    self.after(0, lambda: self._after_apply(
                        f"Channel {idx+1} saved to temp.\nPath: {os.path.basename(path)}"))
                except Exception as e:
                    self.after(0, lambda: messagebox.showerror("Error", str(e), parent=self))
                finally:
                    self.after(0, lambda: self.config(cursor=''))

            threading.Thread(target=save_thread, daemon=True).start()

        ttk.Button(pick_win, text="Apply", command=do_apply).pack(pady=8)

    def _apply_to_all(self):
        """Apply mask edits to ALL channels, save temp files for each."""
        if np.sum(self.mask > 0.5) < 5:
            messagebox.showinfo("No mask", "Paint a mask region first.", parent=self)
            return

        self.config(cursor='wait')
        self.update_idletasks()

        def save_all_thread():
            try:
                saved = []
                for i in range(len(self.channels)):
                    if self.base_params[i]['visible']:
                        path = self._save_channel_temp(i)
                        saved.append(os.path.basename(path))
                self.after(0, lambda: self._after_apply(
                    f"Applied to {len(saved)} channels.\nTemp files saved."))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Error", str(e), parent=self))
            finally:
                self.after(0, lambda: self.config(cursor=''))

        threading.Thread(target=save_all_thread, daemon=True).start()

    def _after_apply(self, msg):
        """Called after temp files are saved — refresh everything."""
        # Update the main view
        if hasattr(self.parent_app, '_schedule_update'):
            self.parent_app._schedule_update()

        messagebox.showinfo("Applied", msg, parent=self)

        # Clear the mask
        self.mask = np.zeros_like(self.mask)
        self.feathered_mask = np.zeros_like(self.mask)
        # Refresh base params from updated channel data
        for i, ch in enumerate(self.channels):
            self.base_params[i]['min'] = ch.vmin
            self.base_params[i]['max'] = ch.vmax
        self._update_mask_info()
        self._schedule_update()

    def _save_result(self):
        path = filedialog.asksaveasfilename(
            parent=self,
            title="Save Masked Adjusted Image",
            defaultextension=".tif",
            filetypes=[("TIFF files", "*.tif"), ("PNG files", "*.png")],
            initialfile=f"{self.file_name}_mask_adjusted.tif"
        )
        if not path:
            return

        mask_params = self._get_mask_params()
        ch0 = self.channels[0]
        full_h, full_w = ch0.full_h, ch0.full_w

        def do_save():
            try:
                from scipy.ndimage import zoom as scipy_zoom, gaussian_filter
                # Upscale feathered mask to full resolution
                scale_y = full_h / self.prev_h
                scale_x = full_w / self.prev_w
                fm_full = scipy_zoom(self.feathered_mask, (scale_y, scale_x), order=1)
                fm_full = np.clip(fm_full, 0, 1)

                composite = np.zeros((full_h, full_w, 3), dtype=np.float64)

                for i, ch_data in enumerate(self.channels):
                    bp = self.base_params[i]
                    mp = mask_params[i]
                    if not bp['visible']:
                        continue

                    data = ch_data.full_data[:, :].astype(np.float64)

                    # Base
                    cmin1, cmax1 = bp['min'], bp['max']
                    if cmax1 <= cmin1: cmax1 = cmin1 + 1
                    img_b = np.clip((data - cmin1) / (cmax1 - cmin1), 0, 1) * bp['brightness']
                    np.clip(img_b, 0, 1, out=img_b)

                    # Mask
                    cmin2, cmax2 = mp['min'], mp['max']
                    if cmax2 <= cmin2: cmax2 = cmin2 + 1
                    img_m = np.clip((data - cmin2) / (cmax2 - cmin2), 0, 1) * mp['brightness']
                    np.clip(img_m, 0, 1, out=img_m)

                    # Blend
                    blended = img_b * (1 - fm_full) + img_m * fm_full

                    r, g, b = bp['color']
                    ch_rgb = np.zeros((full_h, full_w, 3), dtype=np.float64)
                    ch_rgb[:, :, 0] = blended * (r / 255.0)
                    ch_rgb[:, :, 1] = blended * (g / 255.0)
                    ch_rgb[:, :, 2] = blended * (b / 255.0)
                    composite = 1 - (1 - composite) * (1 - ch_rgb)

                composite = np.clip(composite * 255, 0, 255).astype(np.uint8)
                if path.lower().endswith('.png'):
                    pil = Image.fromarray(composite)
                    pil.save(path, dpi=(self.dpi, self.dpi))
                else:
                    tifffile.imwrite(path, composite)
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Save Error", str(e), parent=self))

        threading.Thread(target=do_save, daemon=True).start()


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    app = FluoroView()
    app.mainloop()

if __name__ == '__main__':
    main()

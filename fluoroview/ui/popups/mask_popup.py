
from __future__ import annotations

import os
import threading

import tkinter as tk
from tkinter import filedialog, messagebox

import customtkinter as ctk
import numpy as np
from PIL import Image, ImageTk
import tifffile

from fluoroview.constants import IF_COLORS, NUM_WORKERS, THEME


class MaskAdjustPopup(ctk.CTkToplevel):

    def __init__(self, parent, channels, params_list, ch_names, file_name, dpi):
        super().__init__(parent)
        self.parent_app = parent
        self.title(f"Brush Mask Adjust — {file_name}")
        self.geometry("1400x900")
        self.channels = channels
        self.base_params = [dict(p) for p in params_list]
        self.mask_params = [dict(p) for p in params_list]
        self.ch_names = ch_names
        self.file_name = file_name
        self.dpi = dpi

        ch0 = channels[0]
        self.prev_h, self.prev_w = ch0.preview.shape
        self.ds = ch0.ds_factor
        self.mask = np.zeros((self.prev_h, self.prev_w), dtype=np.float32)
        self.feathered_mask = np.zeros_like(self.mask)
        self.mask_history: list[np.ndarray] = []
        self.brush_size = 15
        self.painting = False
        self._last_paint = None
        self.zoom_level = 1.0
        self.pan_offset = [0, 0]
        self._update_pending = False
        self._tk_image = None

        self._build_ui()
        self._bind_events()
        self.after(200, self._zoom_fit)

    def _build_ui(self):
        T = THEME
        left = ctk.CTkFrame(self, width=300, corner_radius=0)
        left.pack(side="left", fill="y")
        left.pack_propagate(False)

        ctk.CTkLabel(left, text="\U0001F58C  Brush Mask Tool",
                     font=ctk.CTkFont(size=16, weight="bold"),
                     text_color="#0a84ff").pack(padx=12, pady=(12, 6))

        bf = ctk.CTkFrame(left, corner_radius=8)
        bf.pack(fill="x", padx=8, pady=4)
        sf = ctk.CTkFrame(bf, fg_color="transparent")
        sf.pack(fill="x", padx=8, pady=4)
        ctk.CTkLabel(sf, text="Size:").pack(side="left")
        self.size_var = tk.IntVar(value=20)
        ctk.CTkSlider(sf, from_=3, to=150, variable=self.size_var,
                      command=lambda v: self._update_brush_size()).pack(
            side="left", fill="x", expand=True, padx=4)
        self.size_label = ctk.CTkLabel(sf, text="20px", width=50)
        self.size_label.pack(side="right")

        mf = ctk.CTkFrame(bf, fg_color="transparent")
        mf.pack(fill="x", padx=8, pady=4)
        self.mode_var = tk.StringVar(value="paint")
        self._paint_btn = ctk.CTkButton(
            mf, text="Paint", width=80, height=28,
            fg_color="#0a84ff", hover_color="#0070e0",
            command=lambda: self._set_mode("paint"))
        self._paint_btn.pack(side="left", padx=4)
        self._erase_btn = ctk.CTkButton(
            mf, text="Erase", width=80, height=28,
            fg_color="#2c2e36", hover_color="#ff453a",
            command=lambda: self._set_mode("erase"))
        self._erase_btn.pack(side="left", padx=4)

        ubf = ctk.CTkFrame(bf, fg_color="transparent")
        ubf.pack(fill="x", padx=8, pady=4)
        ctk.CTkButton(ubf, text="Undo", width=80, fg_color="#2c2e36",
                      hover_color="#3a3c44", command=self._undo).pack(
            side="left", padx=2)
        ctk.CTkButton(ubf, text="Clear", width=80, fg_color="#2c2e36",
                      hover_color="#ff453a", command=self._clear_mask).pack(
            side="left", padx=2)
        self.mask_info = ctk.CTkLabel(bf, text="Mask: 0% painted",
                                      text_color="#8e8e93")
        self.mask_info.pack(pady=4)

        adj = ctk.CTkScrollableFrame(left, label_text="Mask Region Adjustments",
                                     corner_radius=8)
        adj.pack(fill="both", expand=True, padx=8, pady=4)

        self.mask_min_vars, self.mask_max_vars, self.mask_brt_vars = [], [], []
        for i, (name, params) in enumerate(zip(self.ch_names, self.mask_params)):
            cf = ctk.CTkFrame(adj, corner_radius=8, fg_color="#16181f",
                              border_width=1, border_color="#2c2e36")
            cf.pack(fill="x", pady=3)
            ctk.CTkLabel(cf, text=name, font=ctk.CTkFont(size=11, weight="bold"),
                         text_color="#0a84ff").pack(anchor="w", padx=8, pady=(6, 2))
            dm = float(self.channels[i].preview.max())
            for lbl, val, store in [("Min:", params["min"], self.mask_min_vars),
                                    ("Max:", params["max"], self.mask_max_vars)]:
                fr = ctk.CTkFrame(cf, fg_color="transparent")
                fr.pack(fill="x", padx=8)
                ctk.CTkLabel(fr, text=lbl, width=32).pack(side="left")
                v = tk.DoubleVar(value=val)
                v.trace_add("write", lambda *a: self._schedule_update())
                ctk.CTkSlider(fr, from_=0, to=dm, variable=v).pack(
                    side="left", fill="x", expand=True, padx=4)
                store.append(v)
            bfr = ctk.CTkFrame(cf, fg_color="transparent")
            bfr.pack(fill="x", padx=8, pady=(0, 6))
            ctk.CTkLabel(bfr, text="Brt:", width=32).pack(side="left")
            bv = tk.DoubleVar(value=params["brightness"])
            bv.trace_add("write", lambda *a: self._schedule_update())
            ctk.CTkSlider(bfr, from_=0.0, to=3.0, variable=bv).pack(
                side="left", fill="x", expand=True, padx=4)
            self.mask_brt_vars.append(bv)

        zf = ctk.CTkFrame(left, fg_color="transparent")
        zf.pack(fill="x", padx=8, pady=2)
        ctk.CTkButton(zf, text="Fit", width=60, fg_color="#2c2e36",
                      hover_color="#3a3c44", command=self._zoom_fit).pack(
            side="left", padx=1)
        ctk.CTkButton(zf, text="+", width=36, fg_color="#2c2e36",
                      hover_color="#3a3c44", command=lambda: self._zoom_step(1.5)).pack(
            side="left", padx=1)
        ctk.CTkButton(zf, text="-", width=36, fg_color="#2c2e36",
                      hover_color="#3a3c44", command=lambda: self._zoom_step(1/1.5)).pack(
            side="left", padx=1)
        ctk.CTkButton(left, text="Apply to Channel", fg_color="#2c2e36",
                      hover_color="#3a3c44",
                      command=self._apply_to_channel).pack(fill="x", padx=8, pady=2)
        ctk.CTkButton(left, text="Apply to All",
                      command=self._apply_to_all).pack(fill="x", padx=8, pady=2)
        ctk.CTkButton(left, text="\U0001F4BE Save Result",
                      command=self._save_result).pack(fill="x", padx=8, pady=(2, 8))

        self.canvas = tk.Canvas(self, bg=T["CHART_BG"], highlightthickness=0,
                                cursor="circle")
        self.canvas.pack(side="right", fill="both", expand=True)

    def _bind_events(self):
        self.canvas.bind("<ButtonPress-1>", self._on_paint_start)
        self.canvas.bind("<B1-Motion>", self._on_paint_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_paint_end)
        self.canvas.bind("<MouseWheel>", self._on_scroll)
        self.canvas.bind("<ButtonPress-2>", self._on_pan_start)
        self.canvas.bind("<B2-Motion>", self._on_pan_drag)
        self.canvas.bind("<Configure>", lambda e: self._schedule_update())


    def _update_brush_size(self):
        self.brush_size = self.size_var.get()
        self.size_label.configure(text=f"{self.brush_size}px")

    def _schedule_update(self):
        if not self._update_pending:
            self._update_pending = True
            self.after(30, self._do_update)

    def _do_update(self):
        self._update_pending = False
        self._render()

    def _on_paint_start(self, event):
        self._save_undo()
        self.painting = True
        self._paint_at(event.x, event.y)

    def _on_paint_drag(self, event):
        if self.painting:
            self._paint_at(event.x, event.y)

    def _on_paint_end(self, _event):
        self.painting = False
        self._last_paint = None
        self._feather_mask()
        pct = 100 * self.mask.sum() / max(1, self.mask.size)
        self.mask_info.configure(text=f"Mask: {pct:.1f}% painted")
        self._schedule_update()

    def _paint_at(self, sx, sy):
        from scipy.ndimage import gaussian_filter
        cw = self.canvas.winfo_width()
        ch_ = self.canvas.winfo_height()
        ph, pw = self.prev_h, self.prev_w
        dw = max(1, int(pw * self.zoom_level))
        dh = max(1, int(ph * self.zoom_level))
        ox = cw // 2 + self.pan_offset[0] - dw // 2
        oy = ch_ // 2 + self.pan_offset[1] - dh // 2
        ix = int((sx - ox) / self.zoom_level)
        iy = int((sy - oy) / self.zoom_level)
        bs = max(1, int(self.brush_size / self.zoom_level))
        y1, y2 = max(0, iy - bs), min(ph, iy + bs)
        x1, x2 = max(0, ix - bs), min(pw, ix + bs)
        if self.mode_var.get() == "paint":
            yy, xx = np.ogrid[y1:y2, x1:x2]
            dist = np.sqrt((yy - iy) ** 2 + (xx - ix) ** 2)
            circle = dist <= bs
            self.mask[y1:y2, x1:x2][circle] = 1.0
        else:
            self.mask[y1:y2, x1:x2] = 0.0
        self._last_paint = (sx, sy)
        self._feather_mask()
        self._schedule_update()

    def _feather_mask(self):
        from scipy.ndimage import gaussian_filter
        self.feathered_mask = gaussian_filter(self.mask, sigma=3)
        np.clip(self.feathered_mask, 0, 1, out=self.feathered_mask)

    def _save_undo(self):
        self.mask_history.append(self.mask.copy())
        if len(self.mask_history) > 30:
            self.mask_history.pop(0)

    def _set_mode(self, mode: str):
        self.mode_var.set(mode)
        if mode == "paint":
            self._paint_btn.configure(fg_color="#0a84ff")
            self._erase_btn.configure(fg_color="#2c2e36")
        else:
            self._paint_btn.configure(fg_color="#2c2e36")
            self._erase_btn.configure(fg_color="#ff453a")

    def _undo(self):
        if self.mask_history:
            self.mask = self.mask_history.pop()
            self._feather_mask()
            self._schedule_update()

    def _clear_mask(self):
        self._save_undo()
        self.mask[:] = 0
        self.feathered_mask[:] = 0
        self.mask_info.configure(text="Mask: 0% painted")
        self._schedule_update()

    def _render(self):
        cw = self.canvas.winfo_width()
        ch_ = self.canvas.winfo_height()
        if cw < 10 or ch_ < 10:
            return
        ph, pw = self.prev_h, self.prev_w
        composite_base = np.zeros((ph, pw, 3), dtype=np.float32)
        composite_mask = np.zeros((ph, pw, 3), dtype=np.float32)
        for cd, bp, mp in zip(self.channels, self.base_params, self.mask_params):
            if not bp["visible"]:
                continue
            img = cd.preview.copy()
            r, g, b = bp["color"]

            cmin, cmax = bp["min"], bp["max"]
            if cmax <= cmin: cmax = cmin + 1
            base = np.clip((img - cmin) / (cmax - cmin), 0, 1) * bp["brightness"]
            np.clip(base, 0, 1, out=base)
            cr = np.zeros((ph, pw, 3), dtype=np.float32)
            cr[:, :, 0] = base * (r / 255.0)
            cr[:, :, 1] = base * (g / 255.0)
            cr[:, :, 2] = base * (b / 255.0)
            composite_base = 1 - (1 - composite_base) * (1 - cr)

        for i, (cd, bp) in enumerate(zip(self.channels, self.base_params)):
            if not bp["visible"]:
                continue
            img = cd.preview.copy()
            r, g, b = bp["color"]
            mn = self.mask_min_vars[i].get()
            mx_ = self.mask_max_vars[i].get()
            brt = self.mask_brt_vars[i].get()
            if mx_ <= mn: mx_ = mn + 1
            masked = np.clip((img - mn) / (mx_ - mn), 0, 1) * brt
            np.clip(masked, 0, 1, out=masked)
            cr = np.zeros((ph, pw, 3), dtype=np.float32)
            cr[:, :, 0] = masked * (r / 255.0)
            cr[:, :, 1] = masked * (g / 255.0)
            cr[:, :, 2] = masked * (b / 255.0)
            composite_mask = 1 - (1 - composite_mask) * (1 - cr)

        fm = self.feathered_mask[:, :, None]
        comp = composite_base * (1 - fm) + composite_mask * fm
        comp = np.clip(comp * 255, 0, 255).astype(np.uint8)

        overlay = np.zeros((ph, pw, 3), dtype=np.uint8)
        overlay[:, :, 0] = (self.mask * 80).astype(np.uint8)
        overlay[:, :, 2] = (self.mask * 40).astype(np.uint8)
        comp = np.clip(comp.astype(np.int16) + overlay.astype(np.int16), 0, 255).astype(np.uint8)

        dw = max(1, int(pw * self.zoom_level))
        dh = max(1, int(ph * self.zoom_level))
        pil = Image.fromarray(comp).resize(
            (dw, dh), Image.NEAREST if self.zoom_level > 2 else Image.LANCZOS)
        result = Image.new("RGB", (cw, ch_), (0, 0, 0))
        result.paste(pil, (int(cw // 2 + self.pan_offset[0] - dw // 2),
                           int(ch_ // 2 + self.pan_offset[1] - dh // 2)))
        self._tk_image = ImageTk.PhotoImage(result)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self._tk_image, anchor="nw")

    def _on_scroll(self, event):
        f = 1.35 if event.delta > 0 else 1 / 1.35
        self.zoom_level = max(0.01, self.zoom_level * f)
        self._schedule_update()

    def _zoom_step(self, f):
        self.zoom_level = max(0.01, self.zoom_level * f)
        self._schedule_update()

    def _zoom_fit(self):
        cw = max(self.canvas.winfo_width(), 600)
        ch_ = max(self.canvas.winfo_height(), 400)
        self.zoom_level = min(cw / self.prev_w, ch_ / self.prev_h) * 0.95
        self.pan_offset = [0, 0]
        self._schedule_update()

    def _on_pan_start(self, event):
        self._pan_sx, self._pan_sy = event.x, event.y
        self._pan_so = list(self.pan_offset)

    def _on_pan_drag(self, event):
        self.pan_offset[0] = self._pan_so[0] + (event.x - self._pan_sx)
        self.pan_offset[1] = self._pan_so[1] + (event.y - self._pan_sy)
        self._schedule_update()

    def _apply_to_channel(self):
        for i, ctrl in enumerate(self.parent_app.channel_controls):
            if i < len(self.mask_min_vars):
                ctrl.min_var.set(self.mask_min_vars[i].get())
                ctrl.max_var.set(self.mask_max_vars[i].get())
                ctrl.brightness_var.set(self.mask_brt_vars[i].get())
        self.parent_app._schedule_update()
        self.parent_app.status_var.set("Mask adjustments applied")

    def _apply_to_all(self):
        self._apply_to_channel()

    def _save_result(self):
        path = filedialog.asksaveasfilename(
            parent=self, title="Save Masked Result", defaultextension=".tif",
            filetypes=[("TIFF", "*.tif"), ("PNG", "*.png")],
            initialfile=f"{self.file_name}_masked.tif")
        if not path:
            return
        params = []
        for i, bp in enumerate(self.base_params):
            d = dict(bp)
            d["min"] = self.mask_min_vars[i].get()
            d["max"] = self.mask_max_vars[i].get()
            d["brightness"] = self.mask_brt_vars[i].get()
            params.append(d)

        def _do():
            try:
                ch0 = self.channels[0]
                h, w = ch0.full_h, ch0.full_w
                comp = np.zeros((h, w, 3), dtype=np.float64)
                for cd, p in zip(self.channels, params):
                    if not p["visible"]:
                        continue
                    d = cd.full_data[:, :].astype(np.float64)
                    cmin, cmax = p["min"], p["max"]
                    if cmax <= cmin: cmax = cmin + 1
                    d = np.clip((d - cmin) / (cmax - cmin), 0, 1) * p["brightness"]
                    np.clip(d, 0, 1, out=d)
                    r, g, b = p["color"]
                    cr = np.zeros((h, w, 3), dtype=np.float64)
                    cr[:, :, 0] = d * (r / 255.0)
                    cr[:, :, 1] = d * (g / 255.0)
                    cr[:, :, 2] = d * (b / 255.0)
                    comp = 1 - (1 - comp) * (1 - cr)
                comp = np.clip(comp * 255, 0, 255).astype(np.uint8)
                if path.lower().endswith(".png"):
                    Image.fromarray(comp).save(path, dpi=(self.dpi, self.dpi))
                else:
                    tifffile.imwrite(path, comp)
                self.after(0, lambda: self.parent_app.status_var.set(
                    f"Saved masked result: {os.path.basename(path)}"))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("Error", str(e), parent=self))
        threading.Thread(target=_do, daemon=True).start()

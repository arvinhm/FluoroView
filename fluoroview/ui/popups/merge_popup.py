
from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import tkinter as tk
from tkinter import filedialog, messagebox

import customtkinter as ctk
import numpy as np
from PIL import Image, ImageTk
import tifffile

from fluoroview.constants import IF_COLORS, NUM_WORKERS, THEME


class MergePopup(ctk.CTkToplevel):

    def __init__(self, parent, channels, params_list, ch_names, file_name, dpi):
        super().__init__(parent)
        self.title(f"Merge View — {file_name}")
        self.geometry("1400x900")
        self.channels = channels
        self.params_list = [dict(p) for p in params_list]
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
        T = THEME
        left = ctk.CTkFrame(self, width=230, corner_radius=0)
        left.pack(side="left", fill="y")
        left.pack_propagate(False)

        ctk.CTkLabel(left, text="\U0001F3A8  Merge Channels",
                     font=ctk.CTkFont(size=16, weight="bold"),
                     text_color="#0a84ff").pack(padx=12, pady=(12, 6))

        self.ch_vars, self.color_vars = [], []
        self.min_vars, self.max_vars, self.brt_vars = [], [], []

        ctrl_scroll = ctk.CTkScrollableFrame(left, fg_color="transparent")
        ctrl_scroll.pack(fill="both", expand=True, padx=4, pady=4)

        for i, (name, params) in enumerate(zip(self.ch_names, self.params_list)):
            ch_fr = ctk.CTkFrame(ctrl_scroll, corner_radius=8,
                                 fg_color="#16181f", border_width=1,
                                 border_color="#2c2e36")
            ch_fr.pack(fill="x", pady=3)
            top = ctk.CTkFrame(ch_fr, fg_color="transparent")
            top.pack(fill="x", padx=8, pady=(6, 2))
            var = tk.BooleanVar(value=True)
            var.trace_add("write", lambda *a: self._schedule_update())
            self.ch_vars.append(var)
            ctk.CTkCheckBox(top, text="", variable=var, width=24).pack(side="left")
            ctk.CTkLabel(top, text=name, font=ctk.CTkFont(size=11, weight="bold"),
                         text_color="#0a84ff").pack(side="left", padx=4)
            cv = tk.StringVar(value=params["color_name"])
            cv.trace_add("write", lambda *a: self._schedule_update())
            self.color_vars.append(cv)
            ctk.CTkComboBox(top, variable=cv, values=list(IF_COLORS.keys()),
                            width=100).pack(side="right")
            data_max = float(self.channels[i].preview.max()) if i < len(self.channels) else 65535
            for lbl, default, store in [("Min:", params["min"], self.min_vars),
                                        ("Max:", params["max"], self.max_vars)]:
                fr = ctk.CTkFrame(ch_fr, fg_color="transparent")
                fr.pack(fill="x", padx=8)
                ctk.CTkLabel(fr, text=lbl, width=32).pack(side="left")
                dv = tk.DoubleVar(value=default)
                dv.trace_add("write", lambda *a: self._schedule_update())
                ctk.CTkSlider(fr, from_=0, to=data_max, variable=dv).pack(
                    side="left", fill="x", expand=True, padx=4)
                store.append(dv)
            bfr = ctk.CTkFrame(ch_fr, fg_color="transparent")
            bfr.pack(fill="x", padx=8, pady=(0, 6))
            ctk.CTkLabel(bfr, text="Brt:", width=32).pack(side="left")
            bv = tk.DoubleVar(value=params.get("brightness", 1.0))
            bv.trace_add("write", lambda *a: self._schedule_update())
            ctk.CTkSlider(bfr, from_=0.0, to=3.0, variable=bv).pack(
                side="left", fill="x", expand=True, padx=4)
            self.brt_vars.append(bv)

        bf = ctk.CTkFrame(left, fg_color="transparent")
        bf.pack(fill="x", padx=8, pady=2)
        ctk.CTkButton(bf, text="All On", width=80, fg_color="#2c2e36",
                      hover_color="#30d158",
                      command=lambda: [v.set(True) for v in self.ch_vars]).pack(
            side="left", padx=1)
        ctk.CTkButton(bf, text="All Off", width=80, fg_color="#2c2e36",
                      hover_color="#ff453a",
                      command=lambda: [v.set(False) for v in self.ch_vars]).pack(
            side="left", padx=1)

        zf = ctk.CTkFrame(left, fg_color="transparent")
        zf.pack(fill="x", padx=8, pady=2)
        ctk.CTkButton(zf, text="+", width=36, fg_color="#2c2e36",
                      hover_color="#3a3c44",
                      command=lambda: self._zoom_step(1.5)).pack(side="left", padx=1)
        ctk.CTkButton(zf, text="-", width=36, fg_color="#2c2e36",
                      hover_color="#3a3c44",
                      command=lambda: self._zoom_step(1/1.5)).pack(side="left", padx=1)
        ctk.CTkButton(zf, text="Fit", width=60, fg_color="#2c2e36",
                      hover_color="#3a3c44",
                      command=self._zoom_fit).pack(side="left", padx=1)
        ctk.CTkButton(zf, text="1:1", width=40, fg_color="#2c2e36",
                      hover_color="#3a3c44",
                      command=self._zoom_100).pack(side="left", padx=1)

        self.zoom_label = ctk.CTkLabel(left, text="Zoom: fit", text_color="#8e8e93")
        self.zoom_label.pack(pady=2)
        self.hd_var = tk.BooleanVar(value=False)
        ctk.CTkCheckBox(left, text="HD Full Resolution", variable=self.hd_var,
                        command=self._schedule_update).pack(fill="x", padx=8)
        ctk.CTkButton(left, text="\U0001F4BE Save Merged",
                      command=self._save_merged).pack(fill="x", padx=8, pady=(2, 8))

        self.canvas = tk.Canvas(self, bg=T["CHART_BG"], highlightthickness=0,
                                cursor="crosshair")
        self.canvas.pack(side="right", fill="both", expand=True)

    def _bind_events(self):
        self.canvas.bind("<MouseWheel>", self._on_scroll)
        self.canvas.bind("<ButtonPress-1>", self._on_pan_start)
        self.canvas.bind("<B1-Motion>", self._on_pan_drag)
        self.canvas.bind("<Configure>", lambda e: self._schedule_update())

    def _schedule_update(self):
        if not self._update_pending:
            self._update_pending = True
            self.after(30, self._do_update)

    def _do_update(self):
        self._update_pending = False
        self._render()

    def _get_active_params(self):
        result = []
        for i, p in enumerate(self.params_list):
            d = dict(p)
            d["visible"] = self.ch_vars[i].get()
            cn = self.color_vars[i].get()
            d["color_name"] = cn
            d["color"] = IF_COLORS.get(cn, (255, 255, 255))
            d["min"] = self.min_vars[i].get()
            d["max"] = self.max_vars[i].get()
            d["brightness"] = self.brt_vars[i].get()
            result.append(d)
        return result

    def _render(self):
        cw = self.canvas.winfo_width()
        ch = self.canvas.winfo_height()
        if cw < 10 or ch < 10:
            return
        params = self._get_active_params()
        ch0 = self.channels[0]
        ds = ch0.ds_factor
        use_fullres = self.hd_var.get() and self.zoom_level > ds * 0.3

        if use_fullres:
            try:
                self._render_hd(cw, ch, params)
                return
            except Exception:
                pass

        prev_h, prev_w = ch0.preview.shape
        composite = np.zeros((prev_h, prev_w, 3), dtype=np.float32)
        for cd, p in zip(self.channels, params):
            if not p["visible"]:
                continue
            img = cd.preview.copy()
            cmin, cmax = p["min"], p["max"]
            if cmax <= cmin:
                cmax = cmin + 1
            img = np.clip((img - cmin) / (cmax - cmin), 0, 1) * p["brightness"]
            np.clip(img, 0, 1, out=img)
            r, g, b = p["color"]
            ch_rgb = np.zeros((prev_h, prev_w, 3), dtype=np.float32)
            ch_rgb[:, :, 0] = img * (r / 255.0)
            ch_rgb[:, :, 1] = img * (g / 255.0)
            ch_rgb[:, :, 2] = img * (b / 255.0)
            composite = 1 - (1 - composite) * (1 - ch_rgb)

        composite = np.clip(composite * 255, 0, 255).astype(np.uint8)
        dw = max(1, int(prev_w * self.zoom_level))
        dh = max(1, int(prev_h * self.zoom_level))
        pil = Image.fromarray(composite).resize(
            (dw, dh), Image.NEAREST if self.zoom_level > 2 else Image.LANCZOS)
        result = Image.new("RGB", (cw, ch), (0, 0, 0))
        result.paste(pil, (int(cw // 2 + self.pan_offset[0] - dw // 2),
                           int(ch // 2 + self.pan_offset[1] - dh // 2)))
        self._tk_image = ImageTk.PhotoImage(result)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self._tk_image, anchor="nw")

    def _render_hd(self, cw, ch, params):
        ch0 = self.channels[0]
        ds = ch0.ds_factor
        fz = self.zoom_level / ds
        cx_f = ch0.full_w / 2 - self.pan_offset[0] / fz
        cy_f = ch0.full_h / 2 - self.pan_offset[1] / fz
        hvw, hvh = cw / 2 / fz, ch / 2 / fz
        fx1 = int(max(0, cx_f - hvw - 2))
        fy1 = int(max(0, cy_f - hvh - 2))
        fx2 = int(min(ch0.full_w, cx_f + hvw + 2))
        fy2 = int(min(ch0.full_h, cy_f + hvh + 2))
        if fx2 <= fx1 or fy2 <= fy1:
            return
        rh, rw = fy2 - fy1, fx2 - fx1
        comp = np.zeros((rh, rw, 3), dtype=np.float32)
        for cd, p in zip(self.channels, params):
            if not p["visible"]:
                continue
            d = cd.full_data[fy1:fy2, fx1:fx2].astype(np.float32)
            cmin, cmax = p["min"], p["max"]
            if cmax <= cmin:
                cmax = cmin + 1
            d = np.clip((d - cmin) / (cmax - cmin), 0, 1) * p["brightness"]
            np.clip(d, 0, 1, out=d)
            r, g, b = p["color"]
            cr = np.zeros((rh, rw, 3), dtype=np.float32)
            cr[:, :, 0] = d * (r / 255.0)
            cr[:, :, 1] = d * (g / 255.0)
            cr[:, :, 2] = d * (b / 255.0)
            comp = 1 - (1 - comp) * (1 - cr)
        comp = np.clip(comp * 255, 0, 255).astype(np.uint8)
        ow, oh = max(1, int(rw * fz)), max(1, int(rh * fz))
        pil = Image.fromarray(comp).resize(
            (ow, oh), Image.NEAREST if fz > 3 else Image.LANCZOS)
        result = Image.new("RGB", (cw, ch), (17, 17, 27))
        result.paste(pil, (int((fx1 - cx_f) * fz + cw / 2),
                           int((fy1 - cy_f) * fz + ch / 2)))
        self._tk_image = ImageTk.PhotoImage(result)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self._tk_image, anchor="nw")

    def _on_scroll(self, event):
        f = 1.35 if event.delta > 0 else 1 / 1.35
        cx, cy = self.canvas.winfo_width() / 2, self.canvas.winfo_height() / 2
        mx = event.x - cx - self.pan_offset[0]
        my = event.y - cy - self.pan_offset[1]
        old = self.zoom_level
        self.zoom_level = max(0.01, self.zoom_level * f)
        r = self.zoom_level / old
        self.pan_offset[0] -= mx * (r - 1)
        self.pan_offset[1] -= my * (r - 1)
        self.zoom_label.configure(text=f"Zoom: {self.zoom_level:.1%}")
        self._schedule_update()

    def _zoom_step(self, f):
        self.zoom_level = max(0.01, self.zoom_level * f)
        self.zoom_label.configure(text=f"Zoom: {self.zoom_level:.1%}")
        self._schedule_update()

    def _zoom_fit(self):
        if not self.channels:
            return
        cw = max(self.canvas.winfo_width(), 800)
        ch_ = max(self.canvas.winfo_height(), 600)
        ph, pw = self.channels[0].preview.shape
        self.zoom_level = min(cw / pw, ch_ / ph) * 0.95
        self.pan_offset = [0, 0]
        self.zoom_label.configure(text=f"Zoom: {self.zoom_level:.1%}")
        self._schedule_update()

    def _zoom_100(self):
        self.zoom_level = 1.0
        self.pan_offset = [0, 0]
        self.zoom_label.configure(text="Zoom: 100%")
        self._schedule_update()

    def _on_pan_start(self, event):
        self._pan_sx, self._pan_sy = event.x, event.y
        self._pan_so = list(self.pan_offset)

    def _on_pan_drag(self, event):
        self.pan_offset[0] = self._pan_so[0] + (event.x - self._pan_sx)
        self.pan_offset[1] = self._pan_so[1] + (event.y - self._pan_sy)
        self._schedule_update()

    def _save_merged(self):
        path = filedialog.asksaveasfilename(
            parent=self, title="Save Merged Image", defaultextension=".tif",
            filetypes=[("TIFF", "*.tif"), ("PNG", "*.png")],
            initialfile=f"{self.file_name}_merged.tif")
        if not path:
            return
        params = self._get_active_params()
        ch0 = self.channels[0]
        h, w = ch0.full_h, ch0.full_w

        def _do():
            try:
                comp = np.zeros((h, w, 3), dtype=np.float64)
                for cd, p in zip(self.channels, params):
                    if not p["visible"]:
                        continue
                    d = cd.full_data[:, :].astype(np.float64)
                    cmin, cmax = p["min"], p["max"]
                    if cmax <= cmin:
                        cmax = cmin + 1
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
            except Exception as e:
                err_msg = str(e)
                self.after(0, lambda: messagebox.showerror("Error", err_msg, parent=self))
        threading.Thread(target=_do, daemon=True).start()

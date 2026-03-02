"""Premium channel control card using CustomTkinter.

Each channel is a rounded CTkFrame with checkbutton, color dot, name,
sliders, and gradient histogram.
"""

from __future__ import annotations

import tkinter as tk
import customtkinter as ctk
import numpy as np

from fluoroview.constants import IF_COLORS, DEFAULT_COLORS, THEME


class ChannelControl(ctk.CTkFrame):
    """Premium channel control — checkbox, glow dot, name, sliders."""

    def __init__(self, parent, index: int, name: str, vmin: float, vmax: float,
                 data_max: float, on_change, preview_data=None):
        super().__init__(parent, corner_radius=10, fg_color="#16181f",
                         border_width=1, border_color="#2c2e36")
        self.index = index
        self.on_change = on_change
        self.data_max = data_max
        self._preview_data = preview_data

        default_color = DEFAULT_COLORS[index % len(DEFAULT_COLORS)]
        self.color_var = tk.StringVar(value=default_color)
        self.visible_var = tk.BooleanVar(value=True)
        self.name_var = tk.StringVar(value=name)

        # ── header: [check] [dot] [name] [A] [colour combo] ──────────
        hdr = ctk.CTkFrame(self, fg_color="transparent")
        hdr.pack(fill="x", padx=6, pady=(6, 2))

        ctk.CTkCheckBox(hdr, text="", variable=self.visible_var,
                        width=24, command=self._changed).pack(side="left")

        # Glow ring colour dot
        self.dot = tk.Canvas(hdr, width=16, height=16, bg="#16181f",
                             highlightthickness=0)
        self.dot.pack(side="left", padx=(4, 6))
        self._draw_dot()
        self.color_var.trace_add("write", lambda *_: self._draw_dot())

        ctk.CTkEntry(hdr, textvariable=self.name_var, width=80, height=26,
                     font=ctk.CTkFont(size=12, weight="bold")).pack(
            side="left", padx=2)

        ctk.CTkButton(hdr, text="A", width=28, height=26,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._auto_contrast).pack(side="left", padx=2)

        ctk.CTkComboBox(hdr, variable=self.color_var,
                        values=list(IF_COLORS.keys()), width=110,
                        command=lambda v: self._changed()).pack(side="right")

        # ── histogram ─────────────────────────────────────────────────
        self.hist_canvas = tk.Canvas(self, height=28, bg="#0e1017",
                                     highlightthickness=0)
        self.hist_canvas.pack(fill="x", padx=8, pady=(2, 0))
        if preview_data is not None:
            self.after(200, self._draw_histogram)

        # ── sliders ───────────────────────────────────────────────────
        def _slider_row(parent_frame, label_text, from_, to_, var, init):
            r = ctk.CTkFrame(parent_frame, fg_color="transparent")
            r.pack(fill="x", padx=6, pady=1)
            ctk.CTkLabel(r, text=label_text, width=32,
                         font=ctk.CTkFont(size=10, weight="bold"),
                         text_color="#0a84ff").pack(side="left")
            ctk.CTkSlider(r, from_=from_, to=to_, variable=var,
                          height=14, command=lambda v: self._changed()).pack(
                side="left", fill="x", expand=True, padx=4)
            lbl = ctk.CTkLabel(r, text=init, width=45,
                               font=ctk.CTkFont(family="SF Mono", size=10),
                               text_color="#8e8e93")
            lbl.pack(side="right")
            return lbl

        self.min_var = tk.DoubleVar(value=vmin)
        self.min_label = _slider_row(self, "Min", 0, data_max,
                                     self.min_var, f"{vmin:.0f}")

        self.max_var = tk.DoubleVar(value=vmax)
        self.max_label = _slider_row(self, "Max", 0, data_max,
                                     self.max_var, f"{vmax:.0f}")

        self.brightness_var = tk.DoubleVar(value=1.0)
        self.bright_label = _slider_row(self, "Brt", 0.0, 3.0,
                                        self.brightness_var, "1.0")

        self.gamma_var = tk.DoubleVar(value=1.0)
        self.gamma_label = _slider_row(self, "Gam", 0.1, 3.0,
                                       self.gamma_var, "1.0")

        # Bottom padding
        ctk.CTkFrame(self, height=4, fg_color="transparent").pack()

    # ── helpers ────────────────────────────────────────────────────────

    def _draw_dot(self):
        r, g, b = IF_COLORS.get(self.color_var.get(), (255, 255, 255))
        c = self.dot
        c.delete("all")
        glow = f"#{r // 4:02x}{g // 4:02x}{b // 4:02x}"
        c.create_oval(0, 0, 15, 15, fill="", outline=glow, width=2)
        c.create_oval(3, 3, 12, 12,
                      fill=f"#{r:02x}{g:02x}{b:02x}", outline="")

    def _changed(self):
        self.min_label.configure(text=f"{self.min_var.get():.0f}")
        self.max_label.configure(text=f"{self.max_var.get():.0f}")
        self.bright_label.configure(text=f"{self.brightness_var.get():.1f}")
        self.gamma_label.configure(text=f"{self.gamma_var.get():.1f}")
        self.on_change()

    def _auto_contrast(self):
        if self._preview_data is None:
            return
        flat = self._preview_data.ravel()
        nz = flat[flat > 0]
        if len(nz) < 50:
            return
        self.min_var.set(float(np.percentile(nz, 0.5)))
        self.max_var.set(float(np.percentile(nz, 99.5)))
        self._changed()

    def _draw_histogram(self):
        data = self._preview_data
        if data is None:
            return
        c = self.hist_canvas
        c.delete("all")
        w = c.winfo_width()
        h = c.winfo_height()
        if w < 20 or h < 6:
            w, h = 240, 28
        flat = data.ravel()
        flat = flat[flat > 0]
        if len(flat) < 50:
            return
        hv, _ = np.histogram(flat, bins=80)
        hv = np.log1p(hv.astype(np.float32))
        mx = hv.max() if hv.max() > 0 else 1
        r, g, b = IF_COLORS.get(self.color_var.get(), (100, 150, 255))

        bw = w / 80
        pts = [(0, h)]
        for i, v in enumerate(hv):
            pts.append((int(i * bw), int(h - v / mx * (h - 2))))
        pts.append((w, h))

        fill = f"#{r // 3:02x}{g // 3:02x}{b // 3:02x}"
        line = f"#{min(255, r + 60):02x}{min(255, g + 60):02x}{min(255, b + 60):02x}"
        if len(pts) > 2:
            c.create_polygon(pts, fill=fill, outline=line, width=1, smooth=True)

    # ── get / set params ───────────────────────────────────────────────

    def get_params(self) -> dict:
        cn = self.color_var.get()
        return {
            "visible": self.visible_var.get(),
            "color": IF_COLORS.get(cn, (255, 255, 255)),
            "color_name": cn,
            "min": self.min_var.get(),
            "max": self.max_var.get(),
            "brightness": self.brightness_var.get(),
            "gamma": self.gamma_var.get(),
            "name": self.name_var.get(),
        }

    def set_params(self, p: dict):
        self.visible_var.set(p.get("visible", True))
        self.color_var.set(p.get("color_name",
                                 DEFAULT_COLORS[self.index % len(DEFAULT_COLORS)]))
        self.min_var.set(p.get("min", 0))
        self.max_var.set(p.get("max", self.data_max))
        self.brightness_var.set(p.get("brightness", 1.0))
        self.gamma_var.set(p.get("gamma", 1.0))
        if "name" in p:
            self.name_var.set(p["name"])
        self.min_label.configure(text=f"{self.min_var.get():.0f}")
        self.max_label.configure(text=f"{self.max_var.get():.0f}")
        self.bright_label.configure(text=f"{self.brightness_var.get():.1f}")
        self.gamma_label.configure(text=f"{self.gamma_var.get():.1f}")
        self._draw_dot()

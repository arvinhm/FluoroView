
from __future__ import annotations

import numpy as np
import customtkinter as ctk
import tkinter as tk
from tkinter import filedialog

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg

from fluoroview.constants import THEME


class CellGroupAnalysis(ctk.CTkToplevel):

    def __init__(self, parent, channels, channel_controls, seg_mask, cell_groups):
        super().__init__(parent)
        self.title("\U0001F4CA  Cell Group Analysis")
        self.geometry("1000x650")
        self.transient(parent)
        self.app = parent

        self.channels = channels
        self.channel_controls = channel_controls
        self.seg_mask = seg_mask
        self.cell_groups = cell_groups

        self._log_var = tk.BooleanVar(value=False)
        self._stats_data = {}

        self._compute_stats()
        self._build_ui()

    def _compute_stats(self):
        if not self.cell_groups or self.seg_mask is None:
            return

        ds = self.channels[0].ds_factor if self.channels else 1
        stats = {}
        for gi, (gname, cell_ids) in enumerate(self.cell_groups.items()):
            stats[gname] = {}
            group_mask = np.zeros_like(self.seg_mask, dtype=bool)
            for cid in cell_ids:
                group_mask |= (self.seg_mask == cid)
            if not group_mask.any():
                continue

            for ci, (ch, ctrl) in enumerate(zip(self.channels, self.channel_controls)):
                p = ctrl.get_params()
                if not p["visible"]:
                    continue
                ch_name = p.get("name", f"Ch{ci+1}")
                region = ch.full_data[group_mask]
                if len(region) == 0:
                    continue
                vals = region.astype(np.float64)
                stats[gname][ch_name] = {
                    "values": vals,
                    "mean": float(np.mean(vals)),
                    "median": float(np.median(vals)),
                    "std": float(np.std(vals)),
                    "min": float(np.min(vals)),
                    "max": float(np.max(vals)),
                    "n_cells": len(cell_ids),
                    "n_pixels": int(group_mask.sum()),
                    "color": p["color"],
                }
        self._stats_data = stats

    def _build_ui(self):
        T = THEME
        self.configure(fg_color="#0a0b10")

        top = ctk.CTkFrame(self, fg_color="transparent")
        top.pack(fill="x", padx=10, pady=6)
        ctk.CTkLabel(top, text="\U0001F4CA Cell Group Analysis",
                     font=ctk.CTkFont(size=16, weight="bold"),
                     text_color="#0a84ff").pack(side="left")
        ctk.CTkCheckBox(top, text="Log\u2082(x+1)",
                        variable=self._log_var,
                        command=self._redraw,
                        font=ctk.CTkFont(size=11)).pack(side="left", padx=20)
        ctk.CTkButton(top, text="\U0001F4BE Save Plot", width=90, height=28,
                      command=self._save_plot).pack(side="right", padx=4)
        ctk.CTkButton(top, text="\U0001F4CB Export CSV", width=90, height=28,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._export_csv).pack(side="right", padx=4)

        self._fig, self._ax = plt.subplots(figsize=(10, 5))
        self._fig.patch.set_facecolor("#0a0b10")
        self._canvas_widget = FigureCanvasTkAgg(self._fig, self)
        self._canvas_widget.get_tk_widget().pack(fill="both", expand=True, padx=8, pady=4)

        stats_frame = ctk.CTkScrollableFrame(self, height=120, fg_color="#111318")
        stats_frame.pack(fill="x", padx=8, pady=(0, 8))
        self._stats_frame = stats_frame

        self._redraw()
        self._populate_stats_table()

    def _redraw(self):
        ax = self._ax
        ax.clear()
        ax.set_facecolor("#0e1017")

        if not self._stats_data:
            ax.text(0.5, 0.5, "No data — assign cells to groups first",
                    ha="center", va="center", color="#8e8e93", fontsize=14,
                    transform=ax.transAxes)
            self._canvas_widget.draw()
            return

        use_log = self._log_var.get()
        group_names = list(self._stats_data.keys())
        if not group_names:
            return

        all_channels = []
        for gname in group_names:
            for ch_name in self._stats_data[gname]:
                if ch_name not in all_channels:
                    all_channels.append(ch_name)

        n_groups = len(group_names)
        n_channels = len(all_channels)
        if n_channels == 0:
            return

        width = 0.7 / n_channels
        positions = []
        labels = []
        box_data = []
        box_colors = []

        for gi, gname in enumerate(group_names):
            center = gi
            for ci, ch_name in enumerate(all_channels):
                pos = center + (ci - n_channels / 2 + 0.5) * width
                positions.append(pos)
                chdata = self._stats_data[gname].get(ch_name)
                if chdata:
                    vals = chdata["values"]
                    if use_log:
                        vals = np.log2(vals + 1)
                    box_data.append(vals)
                    r, g, b = chdata["color"]
                    box_colors.append(f"#{r:02x}{g:02x}{b:02x}")
                else:
                    box_data.append([0])
                    box_colors.append("#555555")
                labels.append(f"{gname}\n{ch_name}")

        bp = ax.boxplot(box_data, positions=positions, widths=width * 0.85,
                        patch_artist=True, showfliers=False,
                        medianprops=dict(color="white", linewidth=1.5))

        for patch, color in zip(bp["boxes"], box_colors):
            patch.set_facecolor(color)
            patch.set_alpha(0.7)
            patch.set_edgecolor("white")
            patch.set_linewidth(0.5)

        for element in ["whiskers", "caps"]:
            for line in bp[element]:
                line.set_color("#8e8e93")
                line.set_linewidth(0.8)

        ax.set_xticks([i for i in range(n_groups)])
        ax.set_xticklabels(group_names, color="#e5e5ea", fontsize=11)
        ax.tick_params(axis="y", colors="#8e8e93")
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.spines["bottom"].set_color("#2c2e36")
        ax.spines["left"].set_color("#2c2e36")
        ylabel = "log\u2082(intensity + 1)" if use_log else "Intensity"
        ax.set_ylabel(ylabel, color="#8e8e93", fontsize=11)
        ax.set_xlabel("Cell Groups", color="#8e8e93", fontsize=11)
        ax.set_title("Intensity by Cell Group & Channel",
                     color="#e5e5ea", fontsize=13, pad=10)

        from matplotlib.patches import Patch
        legend_patches = []
        for ch_name in all_channels:
            for gname in group_names:
                chdata = self._stats_data[gname].get(ch_name)
                if chdata:
                    r, g, b = chdata["color"]
                    legend_patches.append(
                        Patch(facecolor=f"#{r:02x}{g:02x}{b:02x}",
                              edgecolor="white", label=ch_name, alpha=0.7))
                    break
        if legend_patches:
            ax.legend(handles=legend_patches, loc="upper right",
                      facecolor="#1c1e26", edgecolor="#2c2e36",
                      labelcolor="#e5e5ea", fontsize=9)

        self._fig.tight_layout()
        self._canvas_widget.draw()

    def _populate_stats_table(self):
        for w in self._stats_frame.winfo_children():
            w.destroy()

        if not self._stats_data:
            ctk.CTkLabel(self._stats_frame, text="No data",
                         text_color="#48494e").pack()
            return

        hdr = ctk.CTkFrame(self._stats_frame, fg_color="transparent")
        hdr.pack(fill="x", padx=4, pady=2)
        for col, w in [("Group", 80), ("Channel", 80), ("Cells", 50),
                        ("Mean", 70), ("Median", 70), ("SD", 70),
                        ("Min", 60), ("Max", 60)]:
            ctk.CTkLabel(hdr, text=col, width=w,
                         font=ctk.CTkFont(size=9, weight="bold"),
                         text_color="#0a84ff").pack(side="left", padx=1)

        for gname, channels in self._stats_data.items():
            for ch_name, s in channels.items():
                row = ctk.CTkFrame(self._stats_frame, fg_color="transparent")
                row.pack(fill="x", padx=4, pady=0)
                r, g, b = s["color"]
                for val, w in [(gname, 80), (ch_name, 80), (str(s["n_cells"]), 50),
                                (f"{s['mean']:.1f}", 70), (f"{s['median']:.1f}", 70),
                                (f"{s['std']:.1f}", 70), (f"{s['min']:.0f}", 60),
                                (f"{s['max']:.0f}", 60)]:
                    ctk.CTkLabel(row, text=val, width=w,
                                 font=ctk.CTkFont(size=9),
                                 text_color=f"#{r:02x}{g:02x}{b:02x}").pack(
                        side="left", padx=1)

    def _save_plot(self):
        path = filedialog.asksaveasfilename(
            title="Save Plot", defaultextension=".png",
            filetypes=[("PNG", "*.png"), ("SVG", "*.svg"), ("PDF", "*.pdf")],
            parent=self)
        if path:
            self._fig.savefig(path, dpi=300, facecolor="#0a0b10",
                              bbox_inches="tight")
            self.app.status_var.set(f"Plot saved → {path}")

    def _export_csv(self):
        path = filedialog.asksaveasfilename(
            title="Export Stats CSV", defaultextension=".csv",
            filetypes=[("CSV", "*.csv")], parent=self)
        if not path:
            return
        import csv
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["Group", "Channel", "N_Cells", "N_Pixels",
                        "Mean", "Median", "SD", "Min", "Max"])
            for gname, channels in self._stats_data.items():
                for ch_name, s in channels.items():
                    w.writerow([gname, ch_name, s["n_cells"], s["n_pixels"],
                                f"{s['mean']:.4f}", f"{s['median']:.4f}",
                                f"{s['std']:.4f}", f"{s['min']:.4f}",
                                f"{s['max']:.4f}"])
        self.app.status_var.set(f"CSV exported → {path}")

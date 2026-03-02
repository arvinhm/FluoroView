"""Single-cell analysis popup — premium CTk dark-themed."""

from __future__ import annotations

import csv
import threading

import tkinter as tk
from tkinter import filedialog, messagebox

import customtkinter as ctk
import numpy as np

from fluoroview.constants import THEME


def _ensure_matplotlib():
    import matplotlib
    matplotlib.use("TkAgg")
    from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
    from matplotlib.figure import Figure
    return FigureCanvasTkAgg, Figure


class CellAnalysisPopup(ctk.CTkToplevel):
    """Visualise per-cell marker expression — premium iOS-dark theme."""

    def __init__(self, parent, cell_data: dict, label_mask: np.ndarray,
                 channel_names: list[str]):
        super().__init__(parent)
        T = THEME
        self.title("Single-Cell Analysis")
        self.geometry("1400x900")
        self.cell_data = cell_data
        self.label_mask = label_mask
        self.channel_names = channel_names
        self.n_cells = len(cell_data["cell_id"])

        FigureCanvasTkAgg, Figure = _ensure_matplotlib()
        self._FigureCanvas = FigureCanvasTkAgg
        self._Figure = Figure

        self._build_ui()
        self.after(100, self._plot_scatter)

    def _build_ui(self):
        T = THEME
        left = ctk.CTkFrame(self, width=250, corner_radius=0)
        left.pack(side="left", fill="y")
        left.pack_propagate(False)

        ctk.CTkLabel(left, text=f"\U0001F9EC  {self.n_cells} cells",
                     font=ctk.CTkFont(size=16, weight="bold"),
                     text_color="#0a84ff").pack(pady=(12, 6), padx=12, anchor="w")

        ctk.CTkLabel(left, text="Plot type:",
                     text_color="#8e8e93").pack(anchor="w", padx=12)
        self.plot_var = tk.StringVar(value="scatter")
        for val, txt in [("scatter", "Scatter (X vs Y)"),
                         ("heatmap", "Heatmap (cells × markers)"),
                         ("histogram", "Histogram"),
                         ("spatial", "Spatial map")]:
            ctk.CTkRadioButton(left, text=txt, variable=self.plot_var,
                               value=val, command=self._on_plot_change).pack(
                anchor="w", padx=16, pady=1)

        markers = [n for n in self.channel_names]

        ctk.CTkLabel(left, text="X-axis marker:",
                     text_color="#8e8e93").pack(anchor="w", padx=12, pady=(8, 0))
        self.x_var = tk.StringVar(value=markers[0] if markers else "")
        ctk.CTkComboBox(left, variable=self.x_var, values=markers,
                        width=180).pack(fill="x", padx=12, pady=2)

        ctk.CTkLabel(left, text="Y-axis marker:",
                     text_color="#8e8e93").pack(anchor="w", padx=12, pady=(6, 0))
        self.y_var = tk.StringVar(value=markers[1] if len(markers) > 1 else markers[0])
        ctk.CTkComboBox(left, variable=self.y_var, values=markers,
                        width=180).pack(fill="x", padx=12, pady=2)

        ctk.CTkLabel(left, text="Colour by marker:",
                     text_color="#8e8e93").pack(anchor="w", padx=12, pady=(6, 0))
        self.color_var = tk.StringVar(value=markers[0] if markers else "")
        ctk.CTkComboBox(left, variable=self.color_var, values=markers,
                        width=180).pack(fill="x", padx=12, pady=2)

        ctk.CTkButton(left, text="\u21BB Refresh",
                      command=self._on_plot_change).pack(fill="x", padx=12, pady=(8, 2))
        ctk.CTkButton(left, text="\U0001F4BE Export CSV",
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._export_csv).pack(fill="x", padx=12, pady=2)

        # Matplotlib figure — deep dark theme
        self.fig = self._Figure(figsize=(7, 5), dpi=100,
                                facecolor=T["BG"], edgecolor=T["BG"])
        self.ax = self.fig.add_subplot(111)
        self._style_axes(self.ax)

        self.canvas_mpl = self._FigureCanvas(self.fig, master=self)
        self.canvas_mpl.get_tk_widget().pack(side="right", fill="both", expand=True)

    def _style_axes(self, ax):
        T = THEME
        ax.set_facecolor(T["CHART_BG"])
        ax.tick_params(colors=T["FG2"], labelsize=8)
        ax.xaxis.label.set_color(T["FG2"])
        ax.yaxis.label.set_color(T["FG2"])
        ax.title.set_color(T["FG"])
        for spine in ax.spines.values():
            spine.set_color(T["BORDER"])
        ax.grid(True, alpha=0.15, color="#2c2e36")

    def _on_plot_change(self):
        pt = self.plot_var.get()
        {"scatter": self._plot_scatter,
         "heatmap": self._plot_heatmap,
         "histogram": self._plot_histogram,
         "spatial": self._plot_spatial}.get(pt, self._plot_scatter)()

    def _vals(self, marker: str) -> np.ndarray:
        key = f"mean_{marker}"
        return self.cell_data.get(key, np.zeros(self.n_cells))

    def _plot_scatter(self):
        self.ax.clear(); self._style_axes(self.ax)
        xm, ym = self.x_var.get(), self.y_var.get()
        cm = self.color_var.get()
        x = self._vals(xm)
        y = self._vals(ym)
        c = self._vals(cm)
        sc = self.ax.scatter(x, y, c=c, s=6, alpha=0.7, cmap="coolwarm", edgecolors="none")
        self.ax.set_xlabel(f"mean_{xm}")
        self.ax.set_ylabel(f"mean_{ym}")
        self.ax.set_title(f"Scatter: {xm} vs {ym} (colour={cm})")
        self.fig.colorbar(sc, ax=self.ax, label=f"mean_{cm}", fraction=0.03)
        self.canvas_mpl.draw()

    def _plot_heatmap(self):
        self.ax.clear(); self._style_axes(self.ax)
        mat = np.column_stack([self._vals(m) for m in self.channel_names])
        if mat.shape[0] > 500:
            idx = np.random.choice(mat.shape[0], 500, replace=False)
            mat = mat[idx]
        from scipy.cluster.hierarchy import linkage, leaves_list
        if mat.shape[0] > 2:
            order = leaves_list(linkage(mat, method="ward"))
            mat = mat[order]
        self.ax.imshow(mat, aspect="auto", cmap="viridis", interpolation="nearest")
        self.ax.set_xticks(range(len(self.channel_names)))
        self.ax.set_xticklabels(self.channel_names, rotation=45, ha="right",
                                fontsize=8, color=THEME["FG2"])
        self.ax.set_ylabel("Cells")
        self.ax.set_title("Cell × Marker Heatmap")
        self.canvas_mpl.draw()

    def _plot_histogram(self):
        self.ax.clear(); self._style_axes(self.ax)
        m = self.x_var.get()
        vals = self._vals(m)
        self.ax.hist(vals, bins=80, color="#0a84ff", edgecolor="#0070e0", alpha=0.85)
        self.ax.set_xlabel(f"mean_{m}")
        self.ax.set_ylabel("Count")
        self.ax.set_title(f"Distribution of {m} expression")
        self.canvas_mpl.draw()

    def _plot_spatial(self):
        self.ax.clear(); self._style_axes(self.ax)
        cx = self.cell_data["centroid_x"]
        cy = self.cell_data["centroid_y"]
        m = self.color_var.get()
        c = self._vals(m)
        sc = self.ax.scatter(cx, cy, c=c, s=4, alpha=0.8, cmap="coolwarm", edgecolors="none")
        self.ax.set_xlabel("X (px)")
        self.ax.set_ylabel("Y (px)")
        self.ax.invert_yaxis()
        self.ax.set_title(f"Spatial map coloured by {m}")
        self.ax.set_aspect("equal")
        self.fig.colorbar(sc, ax=self.ax, label=f"mean_{m}", fraction=0.03)
        self.canvas_mpl.draw()

    def _export_csv(self):
        path = filedialog.asksaveasfilename(
            parent=self, title="Export Cell Data", defaultextension=".csv",
            filetypes=[("CSV", "*.csv")])
        if not path:
            return
        from fluoroview.analysis.quantification import cell_data_to_csv
        cell_data_to_csv(self.cell_data, path)
        messagebox.showinfo("Exported", f"Saved {self.n_cells} cells to {path}",
                            parent=self)

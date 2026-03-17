from __future__ import annotations

import tkinter as tk
from tkinter import filedialog, messagebox

import customtkinter as ctk
import numpy as np

from fluoroview.constants import THEME


def _ensure_matplotlib():
    import matplotlib
    matplotlib.use("TkAgg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Arial", "Helvetica Neue", "Helvetica",
                            "DejaVu Sans", "Liberation Sans", "sans-serif"],
        "font.size": 11,
        "font.weight": "medium",
        "axes.labelweight": "bold",
        "axes.titleweight": "bold",
        "axes.labelsize": 12,
        "axes.titlesize": 14,
        "xtick.labelsize": 10,
        "ytick.labelsize": 10,
    })
    from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
    from matplotlib.figure import Figure
    return FigureCanvasTkAgg, Figure


class CellAnalysisPopup(ctk.CTkToplevel):

    def __init__(self, parent, cell_data: dict, label_mask: np.ndarray,
                 channel_names: list[str]):
        super().__init__(parent)
        T = THEME
        self.title("Single-Cell Analysis")
        self.geometry("1500x950")
        self.configure(fg_color=T["BG"])
        self.cell_data = cell_data
        self.label_mask = label_mask
        self.channel_names = channel_names
        self.n_cells = len(cell_data["cell_id"])

        FigureCanvasTkAgg, Figure = _ensure_matplotlib()
        self._FigureCanvas = FigureCanvasTkAgg
        self._Figure = Figure

        self._build_ui()
        self.after(200, self._draw_all)

    def _build_ui(self):
        T = THEME

        left = ctk.CTkFrame(self, width=240, corner_radius=0, fg_color=T["BG2"])
        left.pack(side="left", fill="y")
        left.pack_propagate(False)

        ctk.CTkLabel(left, text=f"\U0001F9EC  {self.n_cells:,} cells",
                     font=ctk.CTkFont(size=16, weight="bold"),
                     text_color="#0a84ff").pack(pady=(12, 8), padx=12, anchor="w")

        markers = list(self.channel_names)

        ctk.CTkLabel(left, text="X-axis (scatter):",
                     text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", padx=12, pady=(6, 0))
        self.x_var = tk.StringVar(value=markers[0] if markers else "")
        ctk.CTkComboBox(left, variable=self.x_var, values=markers,
                        width=200, height=28).pack(fill="x", padx=12, pady=2)

        ctk.CTkLabel(left, text="Y-axis (scatter):",
                     text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", padx=12, pady=(6, 0))
        self.y_var = tk.StringVar(value=markers[1] if len(markers) > 1 else markers[0])
        ctk.CTkComboBox(left, variable=self.y_var, values=markers,
                        width=200, height=28).pack(fill="x", padx=12, pady=2)

        ctk.CTkLabel(left, text="Colour by:",
                     text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", padx=12, pady=(6, 0))
        self.color_var = tk.StringVar(value=markers[0] if markers else "")
        ctk.CTkComboBox(left, variable=self.color_var, values=markers,
                        width=200, height=28).pack(fill="x", padx=12, pady=2)

        ctk.CTkLabel(left, text="Histogram marker:",
                     text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", padx=12, pady=(6, 0))
        self.hist_var = tk.StringVar(value=markers[0] if markers else "")
        ctk.CTkComboBox(left, variable=self.hist_var, values=markers,
                        width=200, height=28).pack(fill="x", padx=12, pady=2)

        ctk.CTkButton(left, text="\u21BB Refresh All Panels", height=34,
                      font=ctk.CTkFont(size=12, weight="bold"),
                      fg_color="#0a84ff", hover_color="#0070e0",
                      command=self._draw_all).pack(fill="x", padx=12, pady=(16, 4))

        ctk.CTkButton(left, text="\U0001F4BE Export CSV", height=28,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._export_csv).pack(fill="x", padx=12, pady=2)

        ctk.CTkButton(left, text="\U0001F4BE Save Figure", height=28,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._save_figure).pack(fill="x", padx=12, pady=2)

        self.fig = self._Figure(figsize=(12, 9), dpi=120,
                                facecolor=T["BG"], edgecolor=T["BG"])
        self.axes = self.fig.subplots(2, 2)
        for ax in self.axes.flat:
            self._style_axes(ax)

        self.canvas_mpl = self._FigureCanvas(self.fig, master=self)
        self.canvas_mpl.get_tk_widget().pack(side="right", fill="both", expand=True)

    def _style_axes(self, ax):
        T = THEME
        ax.set_facecolor(T["CHART_BG"])
        ax.tick_params(colors=T["FG2"], labelsize=9, width=1.2)
        ax.xaxis.label.set_color(T["FG"])
        ax.yaxis.label.set_color(T["FG"])
        ax.title.set_color(T["FG"])
        for spine in ax.spines.values():
            spine.set_color(T["BORDER"])
            spine.set_linewidth(1.2)
        ax.grid(True, alpha=0.12, color="#2c2e36")

    def _vals(self, marker: str) -> np.ndarray:
        key = f"mean_{marker}"
        return self.cell_data.get(key, np.zeros(self.n_cells))

    def _draw_all(self):
        for ax in self.axes.flat:
            ax.clear()
            self._style_axes(ax)

        while len(self.fig.axes) > 4:
            self.fig.axes[-1].remove()

        self._plot_scatter(self.axes[0, 0])
        self._plot_heatmap(self.axes[0, 1])
        self._plot_histogram(self.axes[1, 0])
        self._plot_spatial(self.axes[1, 1])

        self.fig.tight_layout(pad=1.5)
        self.canvas_mpl.draw()

    def _plot_scatter(self, ax):
        xm, ym = self.x_var.get(), self.y_var.get()
        cm = self.color_var.get()
        x, y, c = self._vals(xm), self._vals(ym), self._vals(cm)

        if len(c) > 0 and np.ptp(c) > 0:
            c_norm = (c - c.min()) / max(1e-9, c.max() - c.min())
        else:
            c_norm = np.zeros_like(c)

        sc = ax.scatter(x, y, c=c_norm, s=8, alpha=0.75, cmap="coolwarm",
                        edgecolors="none", rasterized=True)
        ax.set_xlabel(f"mean_{xm}", fontsize=11, fontweight="bold")
        ax.set_ylabel(f"mean_{ym}", fontsize=11, fontweight="bold")
        ax.set_title(f"A: Scatter: {xm} vs {ym} (colored by {cm})",
                     fontsize=12, fontweight="bold")

        cbar = self.fig.colorbar(sc, ax=ax, fraction=0.04, pad=0.02)
        cbar.ax.tick_params(colors=THEME["FG2"], labelsize=8)

    def _plot_heatmap(self, ax):
        mat = np.column_stack([self._vals(m) for m in self.channel_names])
        n_show = min(500, mat.shape[0])
        if mat.shape[0] > n_show:
            idx = np.random.choice(mat.shape[0], n_show, replace=False)
            mat = mat[idx]

        if mat.shape[0] > 2 and mat.shape[1] > 1:
            try:
                from scipy.cluster.hierarchy import linkage, leaves_list
                order = leaves_list(linkage(mat, method="ward"))
                mat = mat[order]
            except Exception:
                pass

        for j in range(mat.shape[1]):
            col = mat[:, j]
            mn, mx = col.min(), col.max()
            if mx > mn:
                mat[:, j] = (col - mn) / (mx - mn)

        im = ax.imshow(mat, aspect="auto", cmap="viridis",
                       interpolation="nearest")
        ax.set_xticks(range(len(self.channel_names)))
        ax.set_xticklabels(self.channel_names, rotation=45, ha="right",
                           fontsize=10, color=THEME["FG2"])
        ax.set_ylabel("Cells", fontsize=11, fontweight="bold")
        ax.set_title(f"B: Heatmap: {n_show} cells \u00d7 {len(self.channel_names)} markers",
                     fontsize=12, fontweight="bold")

        cbar = self.fig.colorbar(im, ax=ax, fraction=0.04, pad=0.02)
        cbar.ax.tick_params(colors=THEME["FG2"], labelsize=8)

    def _plot_histogram(self, ax):
        m = self.hist_var.get()
        vals = self._vals(m)
        ax.hist(vals, bins=80, color="#0a84ff", edgecolor="#0070e0",
                alpha=0.85, rasterized=True)
        ax.set_xlabel(f"mean_{m}", fontsize=11, fontweight="bold")
        ax.set_ylabel("Count", fontsize=11, fontweight="bold")
        ax.set_title(f"C: Histogram: {m} expression distribution",
                     fontsize=12, fontweight="bold")

    def _plot_spatial(self, ax):
        m = self.color_var.get()
        c = self._vals(m)
        cell_ids = self.cell_data["cell_id"]
        mask = self.label_mask

        if len(c) > 0 and np.ptp(c) > 0:
            c_norm = (c - c.min()) / max(1e-9, c.max() - c.min())
        else:
            c_norm = np.zeros_like(c)

        import matplotlib.cm as cm
        cmap = cm.get_cmap("coolwarm")

        max_label = int(mask.max()) + 1
        cell_rgb = np.zeros((max_label, 3), dtype=np.uint8)
        for ci, cid in enumerate(cell_ids):
            cid_int = int(cid)
            if cid_int < max_label:
                r, g, b, _ = cmap(float(c_norm[ci]))
                cell_rgb[cid_int] = [int(r * 255), int(g * 255), int(b * 255)]

        rgb_img = cell_rgb[mask]

        from skimage.segmentation import find_boundaries
        boundaries = find_boundaries(mask, mode="inner")
        rgb_img[boundaries & (mask > 0)] = [255, 255, 255]
        rgb_img[mask == 0] = [10, 11, 16]

        ax.imshow(rgb_img, interpolation="nearest", aspect="equal")
        ax.set_xlabel("X (px)", fontsize=11, fontweight="bold")
        ax.set_ylabel("Y (px)", fontsize=11, fontweight="bold")
        ax.set_title(f"D: Spatial: cell masks colored by {m}",
                     fontsize=12, fontweight="bold")

        sm = cm.ScalarMappable(cmap="coolwarm",
                               norm=cm.colors.Normalize(
                                   vmin=float(c.min()) if len(c) > 0 else 0,
                                   vmax=float(c.max()) if len(c) > 0 else 1))
        sm.set_array([])
        cbar = self.fig.colorbar(sm, ax=ax, fraction=0.04, pad=0.02)
        cbar.ax.tick_params(colors=THEME["FG2"], labelsize=8)
        cbar.set_label(f"Mean {m}", color=THEME["FG2"], fontsize=9)

    def _export_csv(self):
        path = filedialog.asksaveasfilename(
            parent=self, title="Export Cell Data", defaultextension=".csv",
            filetypes=[("CSV", "*.csv")])
        if not path:
            return
        from fluoroview.analysis.quantification import cell_data_to_csv
        cell_data_to_csv(self.cell_data, path)
        messagebox.showinfo("Exported", f"Saved {self.n_cells:,} cells to {path}",
                            parent=self)

    def _save_figure(self):
        path = filedialog.asksaveasfilename(
            parent=self, title="Save Figure",
            defaultextension=".png",
            filetypes=[("PNG", "*.png"), ("PDF", "*.pdf"),
                       ("SVG", "*.svg"), ("TIFF", "*.tiff")])
        if not path:
            return
        self.fig.savefig(path, dpi=300, facecolor=THEME["BG"],
                         bbox_inches="tight")
        messagebox.showinfo("Saved", f"Figure saved to {path}", parent=self)

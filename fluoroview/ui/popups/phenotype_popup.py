
from __future__ import annotations


import tkinter as tk

from tkinter import filedialog, messagebox


import customtkinter as ctk

import numpy as np


from fluoroview.constants import THEME

from fluoroview.analysis.phenotype import (
    assign_phenotypes, phenotype_counts, auto_threshold, phenotype_data_to_csv,
)


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


_PHENO_PALETTE = [
    "#0a84ff", "#30d158", "#ff453a", "#ff9f0a", "#bf5af2",
    "#64d2ff", "#ffd60a", "#ff375f", "#ac8e68", "#00c7be",
    "#5e5ce6", "#ff6482", "#98c379", "#e5c07b", "#c678dd",
    "#56b6c2", "#e06c75", "#d19a66", "#61afef", "#be5046",
]


def _phenotype_colors(n: int) -> list[str]:

    return [_PHENO_PALETTE[i % len(_PHENO_PALETTE)] for i in range(n)]


class PhenotypePopup(ctk.CTkToplevel):


    def __init__(self, parent, cell_data: dict, label_mask: np.ndarray,
                 channel_names: list[str]):

        super().__init__(parent)

        T = THEME

        self.title("Cell Phenotyping")

        self.geometry("1500x950")

        self.configure(fg_color=T["BG"])


        self.cell_data = cell_data

        self.label_mask = label_mask

        self.channel_names = list(channel_names)

        self.n_cells = len(cell_data["cell_id"])


        self._thresholds: dict[str, float] = {}

        self._slider_vars: dict[str, tk.DoubleVar] = {}

        self._name_vars: dict[str, tk.StringVar] = {}

        self._include_vars: dict[str, tk.BooleanVar] = {}

        self._count_labels: dict[str, ctk.CTkLabel] = {}

        self._phenotypes: np.ndarray | None = None

        self._counts: dict[str, int] = {}

        self._current_cbar = None


        FigureCanvasTkAgg, Figure = _ensure_matplotlib()

        self._FigureCanvas = FigureCanvasTkAgg

        self._Figure = Figure


        for m in self.channel_names:

            self._thresholds[m] = auto_threshold(cell_data, m, method="otsu")


        self._build_ui()

        self._update_phenotypes()


    @property

    def _display_names(self) -> dict[str, str]:

        return {m: self._name_vars[m].get().strip() or m
                for m in self.channel_names}


    @property

    def _active_markers(self) -> list[str]:

        return [m for m in self.channel_names
                if self._include_vars.get(m, tk.BooleanVar(value=True)).get()]


    def _build_ui(self):

        T = THEME


        left = ctk.CTkFrame(self, width=340, corner_radius=0, fg_color=T["BG2"])

        left.pack(side="left", fill="y")

        left.pack_propagate(False)


        ctk.CTkLabel(left,
                     text=f"\U0001F9EC  Phenotyping ({self.n_cells:,} cells)",
                     font=ctk.CTkFont(size=15, weight="bold"),
                     text_color="#0a84ff").pack(pady=(12, 2), padx=12, anchor="w")


        ctk.CTkLabel(left,
                     text="Set threshold per marker.  Edit short names for labels.",
                     text_color="#8e8e93", wraplength=310,
                     font=ctk.CTkFont(size=10)).pack(padx=12, anchor="w", pady=(0, 4))


        auto_fr = ctk.CTkFrame(left, fg_color="transparent")

        auto_fr.pack(fill="x", padx=12, pady=(2, 4))

        ctk.CTkLabel(auto_fr, text="Auto threshold:", text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(side="left")

        for method, label in [("otsu", "Otsu"), ("median", "Median"),
                              ("percentile", "P75")]:

            ctk.CTkButton(
                auto_fr, text=label, width=52, height=22,
                font=ctk.CTkFont(size=9),
                fg_color="#2c2e36", hover_color="#3a3c44",
                command=lambda m=method: self._auto_all(m)
            ).pack(side="left", padx=2)


        slider_frame = ctk.CTkScrollableFrame(left, fg_color="transparent")

        slider_frame.pack(fill="both", expand=True, padx=6, pady=2)


        for marker in self.channel_names:

            vals = self.cell_data.get(f"mean_{marker}", np.zeros(1))

            vmin = float(np.min(vals)) if len(vals) > 0 else 0.0

            vmax = float(np.max(vals)) if len(vals) > 0 else 1.0

            if vmax <= vmin:

                vmax = vmin + 1.0


            is_dapi = any(k in marker.lower()
                          for k in ("dapi", "hoechst", "nuclear"))

            include_var = tk.BooleanVar(value=not is_dapi)

            self._include_vars[marker] = include_var


            mf = ctk.CTkFrame(slider_frame, fg_color="#111318", corner_radius=6)

            mf.pack(fill="x", pady=3, padx=2)


            hdr = ctk.CTkFrame(mf, fg_color="transparent")

            hdr.pack(fill="x", padx=8, pady=(4, 0))


            ctk.CTkCheckBox(
                hdr, text="", variable=include_var,
                width=20, height=20, checkbox_width=18, checkbox_height=18,
                corner_radius=4,
                fg_color="#30d158", hover_color="#28b84c",
                border_color="#48494e",
            ).pack(side="left", padx=(0, 4))


            name_var = tk.StringVar(value=marker)

            self._name_vars[marker] = name_var

            name_entry = ctk.CTkEntry(
                hdr, textvariable=name_var, width=110, height=22,
                font=ctk.CTkFont(size=10, weight="bold"),
                fg_color="#1c1e26", border_width=0,
                text_color="#e5e5ea")

            name_entry.pack(side="left")


            thresh_val = self._thresholds[marker]

            val_label = ctk.CTkLabel(hdr, text=f"thr: {thresh_val:.1f}",
                                     font=ctk.CTkFont(size=10),
                                     text_color="#0a84ff")

            val_label.pack(side="right")


            var = tk.DoubleVar(value=thresh_val)

            self._slider_vars[marker] = var


            def _on_slide(v, m=marker, lbl=val_label):

                fv = float(v)

                self._thresholds[m] = fv

                lbl.configure(text=f"thr: {fv:.1f}")


            slider = ctk.CTkSlider(
                mf, from_=vmin, to=vmax,
                number_of_steps=max(50, int((vmax - vmin) * 2)),
                variable=var, command=_on_slide, height=14)

            slider.pack(fill="x", padx=8, pady=(2, 1))


            pos_count = int(np.sum(vals >= thresh_val))

            pct = pos_count / max(1, self.n_cells) * 100

            count_label = ctk.CTkLabel(
                mf, text=f"{pos_count:,} / {self.n_cells:,} positive ({pct:.1f}%)",
                font=ctk.CTkFont(size=9), text_color="#8e8e93")

            count_label.pack(padx=8, anchor="w", pady=(0, 4))

            self._count_labels[marker] = count_label


            def _on_release(event, m=marker):

                v = self._slider_vars[m].get()

                self._thresholds[m] = v

                vals_m = self.cell_data.get(f"mean_{m}", np.zeros(1))

                pos = int(np.sum(vals_m >= v))

                pct = pos / max(1, self.n_cells) * 100

                self._count_labels[m].configure(
                    text=f"{pos:,} / {self.n_cells:,} positive ({pct:.1f}%)")


            slider.bind("<ButtonRelease-1>", _on_release)


        btn_fr = ctk.CTkFrame(left, fg_color="transparent")

        btn_fr.pack(fill="x", padx=12, pady=(6, 12))


        ctk.CTkButton(btn_fr, text="\u2705 Apply & Update", height=36,
                      font=ctk.CTkFont(size=12, weight="bold"),
                      fg_color="#0a84ff", hover_color="#0070e0",
                      command=self._update_phenotypes).pack(fill="x", pady=2)


        ctk.CTkButton(btn_fr, text="\U0001F4BE Export CSV with phenotypes", height=28,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._export_csv).pack(fill="x", pady=2)


        right = ctk.CTkFrame(self, corner_radius=0, fg_color="transparent")

        right.pack(side="right", fill="both", expand=True)


        top_bar = ctk.CTkFrame(right, fg_color="transparent", height=40)

        top_bar.pack(fill="x", padx=8, pady=(8, 2))


        self._view_var = tk.StringVar(value="bar")

        self._view_buttons: dict[str, ctk.CTkButton] = {}

        for val, txt in [("bar", "Bar Chart"), ("pie", "Pie Chart"),
                         ("spatial", "Spatial Map"), ("table", "Table")]:

            b = ctk.CTkButton(
                top_bar, text=txt, width=100, height=30,
                font=ctk.CTkFont(size=11),
                fg_color="#1c1e26", hover_color="#0a84ff",
                command=lambda v=val: self._switch_view(v))

            b.pack(side="left", padx=3)

            self._view_buttons[val] = b


        self.fig = self._Figure(figsize=(9, 6), dpi=130,
                                facecolor=T["BG"], edgecolor=T["BG"])

        self.ax = self.fig.add_subplot(111)

        self._style_axes(self.ax)


        self.canvas_mpl = self._FigureCanvas(self.fig, master=right)

        self.canvas_mpl.get_tk_widget().pack(fill="both", expand=True, padx=4, pady=4)


        self._table_frame = ctk.CTkScrollableFrame(right, fg_color="#0e1017",
                                                    corner_radius=6)


    def _style_axes(self, ax):

        T = THEME

        ax.set_facecolor(T["CHART_BG"])

        ax.tick_params(colors=T["FG2"], labelsize=11, width=1.2)

        ax.xaxis.label.set_color(T["FG"])

        ax.yaxis.label.set_color(T["FG"])

        ax.title.set_color(T["FG"])

        for spine in ax.spines.values():

            spine.set_color(T["BORDER"])

            spine.set_linewidth(1.2)

        ax.grid(True, alpha=0.12, color="#2c2e36")


    def _clear_figure(self):

        if self._current_cbar is not None:

            try:

                self._current_cbar.remove()

            except Exception:

                pass

            self._current_cbar = None

        self.ax.clear()

        self._style_axes(self.ax)


    def _highlight_view(self, active: str):

        for k, b in self._view_buttons.items():

            if k == active:

                b.configure(fg_color="#0a84ff", text_color="#ffffff")

            else:

                b.configure(fg_color="#1c1e26", text_color="#e5e5ea")


    def _auto_all(self, method: str):

        for m in self.channel_names:

            t = auto_threshold(self.cell_data, m, method=method)

            self._thresholds[m] = t

            if m in self._slider_vars:

                self._slider_vars[m].set(t)

        self._update_phenotypes()


    def _update_phenotypes(self):

        active = self._active_markers

        if not active:

            self._phenotypes = np.array(["no markers"] * self.n_cells,
                                        dtype=object)

            self._counts = phenotype_counts(self._phenotypes)

            self._switch_view(self._view_var.get())

            return


        names = self._display_names

        display_labels = [names[m] for m in active]

        active_thresholds = {m: self._thresholds[m] for m in active}


        self._phenotypes = assign_phenotypes(
            self.cell_data,
            active_thresholds,
            markers=display_labels,
            data_keys=active)

        self._counts = phenotype_counts(self._phenotypes)


        for m in self.channel_names:

            vals = self.cell_data.get(f"mean_{m}", np.zeros(1))

            pos = int(np.sum(vals >= self._thresholds[m]))

            pct = pos / max(1, self.n_cells) * 100

            included = self._include_vars.get(m, tk.BooleanVar(value=True)).get()

            tag = "" if included else "  [excluded]"

            if m in self._count_labels:

                self._count_labels[m].configure(
                    text=f"{pos:,} / {self.n_cells:,} positive ({pct:.1f}%){tag}")


        self._switch_view(self._view_var.get())


    def _switch_view(self, view: str):

        self._view_var.set(view)

        self._highlight_view(view)

        self._table_frame.pack_forget()

        self.canvas_mpl.get_tk_widget().pack_forget()


        if view == "table":

            self._table_frame.pack(fill="both", expand=True, padx=4, pady=4)

            self._show_table()

        else:

            self.canvas_mpl.get_tk_widget().pack(fill="both", expand=True,
                                                  padx=4, pady=4)

            if view == "bar":

                self._plot_bar()

            elif view == "pie":

                self._plot_pie()

            elif view == "spatial":

                self._plot_spatial()


    def _plot_bar(self):

        self._clear_figure()

        if not self._counts:

            self.canvas_mpl.draw(); return


        top_n = 25

        labels = list(self._counts.keys())[:top_n]

        values = [self._counts[l] for l in labels]

        colors = _phenotype_colors(len(labels))


        y_pos = np.arange(len(labels))

        self.ax.barh(y_pos, values, color=colors, edgecolor="none",
                     height=0.72)

        self.ax.set_yticks(y_pos)

        self.ax.set_yticklabels(labels, fontsize=11, color="#e5e5ea",
                                fontweight="medium")

        self.ax.set_xlabel("Cell count", fontsize=13, fontweight="bold")

        self.ax.set_title(
            f"Phenotype Distribution  ({len(self._counts)} types, "
            f"{self.n_cells:,} cells)", fontsize=15, fontweight="bold")

        self.ax.invert_yaxis()


        max_v = max(values) if values else 1

        for i, v in enumerate(values):

            pct = v / max(1, self.n_cells) * 100

            self.ax.text(v + max_v * 0.015, i, f" {v:,}  ({pct:.1f}%)",
                         va="center", fontsize=10, fontweight="medium",
                         color="#d0d0d4")


        self.ax.set_xlim(0, max_v * 1.28)

        self.fig.tight_layout()

        self.canvas_mpl.draw()


    def _plot_pie(self):

        self._clear_figure()

        self.ax.set_facecolor(THEME["BG"])

        if not self._counts:

            self.canvas_mpl.draw(); return


        top_n = 12

        labels = list(self._counts.keys())[:top_n]

        values = [self._counts[l] for l in labels]

        other = sum(list(self._counts.values())[top_n:])

        if other > 0:

            labels.append(f"Other ({len(self._counts) - top_n} types)")

            values.append(other)

        colors = _phenotype_colors(len(labels))


        wedges, texts, autotexts = self.ax.pie(
            values, labels=None, autopct="%1.1f%%",
            colors=colors, pctdistance=0.8, startangle=90,
            textprops={"fontsize": 10, "color": "#e5e5ea", "fontweight": "medium"})

        for at in autotexts:

            at.set_fontsize(9)

            at.set_fontweight("medium")

        self.ax.legend(
            wedges, [f"{l}  ({v:,})" for l, v in zip(labels, values)],
            loc="center left", bbox_to_anchor=(1.0, 0.5), fontsize=10,
            frameon=True, facecolor="#1c1e26", edgecolor="#2c2e36",
            labelcolor="#e5e5ea")

        self.ax.set_title(
            f"Phenotype Distribution ({self.n_cells:,} cells)",
            fontsize=15, fontweight="bold")

        self.fig.tight_layout()

        self.canvas_mpl.draw()


    def _plot_spatial(self):

        self._clear_figure()

        if self._phenotypes is None or not self._counts:

            self.canvas_mpl.draw(); return


        self.ax.set_title(
            f"Spatial Phenotype Map ({self.n_cells:,} cells)", fontsize=13)

        self.ax.text(0.5, 0.5, "Rendering cell masks...",
                     transform=self.ax.transAxes, ha="center", va="center",
                     fontsize=12, color="#8e8e93")

        self.canvas_mpl.draw()

        self.update_idletasks()


        mask = self.label_mask

        cell_ids = self.cell_data["cell_id"]


        pheno_list = list(self._counts.keys())

        hex_colors = _phenotype_colors(len(pheno_list))

        pheno_to_idx = {p: i for i, p in enumerate(pheno_list)}


        rgb_palette = np.zeros((len(hex_colors) + 1, 3), dtype=np.uint8)

        for i, hx in enumerate(hex_colors):

            hx = hx.lstrip("#")

            rgb_palette[i + 1] = [int(hx[0:2], 16), int(hx[2:4], 16),
                                  int(hx[4:6], 16)]


        max_label = int(mask.max()) + 1

        id_to_palette = np.zeros(max_label, dtype=np.int32)

        for ci, cid in enumerate(cell_ids):

            pheno = str(self._phenotypes[ci])

            pidx = pheno_to_idx.get(pheno, -1)

            if pidx >= 0 and int(cid) < max_label:

                id_to_palette[int(cid)] = pidx + 1


        palette_idx = id_to_palette[mask]

        rgb_img = rgb_palette[palette_idx]


        from skimage.segmentation import find_boundaries

        boundaries = find_boundaries(mask, mode="inner")

        rgb_img[boundaries & (mask > 0)] = [255, 255, 255]


        rgb_img[mask == 0] = [10, 11, 16]


        self.ax.clear()

        self._style_axes(self.ax)

        self.ax.imshow(rgb_img, interpolation="nearest", aspect="equal")

        self.ax.set_xlabel("X (px)", fontsize=13, fontweight="bold")

        self.ax.set_ylabel("Y (px)", fontsize=13, fontweight="bold")

        self.ax.set_title(
            f"Spatial Phenotype Map \u2014 actual cell masks "
            f"({self.n_cells:,} cells)", fontsize=15, fontweight="bold")


        from matplotlib.patches import Patch

        top_legend = pheno_list[:15]

        handles = [Patch(facecolor=hex_colors[i],
                         label=f"{p}  ({self._counts[p]:,})")
                   for i, p in enumerate(top_legend)]

        leg = self.ax.legend(handles=handles, loc="upper right", fontsize=9,
                             frameon=True, facecolor="#0a0b10",
                             edgecolor="#2c2e36", labelcolor="#e5e5ea",
                             handlelength=1.2, handleheight=1.0,
                             prop={"weight": "medium"})

        leg.set_zorder(10)


        self.fig.tight_layout()

        self.canvas_mpl.draw()


    def _show_table(self):

        for w in self._table_frame.winfo_children():

            w.destroy()


        hdr = ctk.CTkFrame(self._table_frame, fg_color="#1c1e26", corner_radius=4)

        hdr.pack(fill="x", pady=(0, 4), padx=2)

        for col, w in [("#", 40), ("Phenotype", 280), ("Count", 90),
                       ("Percent", 70)]:

            ctk.CTkLabel(hdr, text=col, width=w,
                         font=ctk.CTkFont(size=10, weight="bold"),
                         text_color="#0a84ff").pack(side="left", padx=6, pady=4)


        colors = _phenotype_colors(len(self._counts))

        for i, (pheno, count) in enumerate(self._counts.items()):

            row = ctk.CTkFrame(self._table_frame, fg_color="transparent",
                               corner_radius=0)

            row.pack(fill="x", pady=1, padx=2)

            pct = count / max(1, self.n_cells) * 100


            ctk.CTkLabel(row, text=f"{i + 1}", width=40,
                         font=ctk.CTkFont(size=10),
                         text_color="#48494e").pack(side="left", padx=6)

            ctk.CTkLabel(row, text="\u2588", width=14,
                         font=ctk.CTkFont(size=12),
                         text_color=colors[i % len(colors)]).pack(side="left")

            ctk.CTkLabel(row, text=pheno, width=260,
                         font=ctk.CTkFont(size=10, family="Courier"),
                         text_color="#e5e5ea", anchor="w").pack(side="left", padx=4)

            ctk.CTkLabel(row, text=f"{count:,}", width=90,
                         font=ctk.CTkFont(size=10),
                         text_color="#e5e5ea").pack(side="left", padx=4)

            ctk.CTkLabel(row, text=f"{pct:.1f}%", width=70,
                         font=ctk.CTkFont(size=10),
                         text_color="#8e8e93").pack(side="left", padx=4)


    def _export_csv(self):

        if self._phenotypes is None:

            messagebox.showinfo("No data", "Apply thresholds first.", parent=self)

            return

        path = filedialog.asksaveasfilename(
            parent=self, title="Export Phenotyped Cells",
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")])

        if not path:

            return

        phenotype_data_to_csv(self.cell_data, self._phenotypes, path)

        messagebox.showinfo(
            "Exported",
            f"Saved {self.n_cells:,} cells with phenotypes to:\n{path}",
            parent=self)

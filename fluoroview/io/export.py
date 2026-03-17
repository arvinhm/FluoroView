
from __future__ import annotations

import csv
import os
from typing import Sequence

import numpy as np
import tifffile
from PIL import Image


def export_roi_csv(
    path: str,
    channels,
    params_list: list[dict],
    rois,
    annotations=None,
):
    ch_names = [p.get("name", f"ch{i + 1}") for i, p in enumerate(params_list)]

    dapi_idx = 0
    for i, n in enumerate(ch_names):
        if "dapi" in n.lower():
            dapi_idx = i
            break

    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        header = [
            "ROI_Name", "ROI_Type", "Center_X", "Center_Y",
            "Width_px", "Height_px", "Channel", "Color",
            "Mean_Intensity", "Std_Intensity", "Median_Intensity",
            "Min_Intensity", "Max_Intensity",
            "Ratio_to_DAPI", "Adjusted_Min", "Adjusted_Max", "Brightness",
        ]
        if annotations is not None:
            header.append("Notes")
        w.writerow(header)

        rois_to_analyze = rois if rois else [None]
        for roi in rois_to_analyze:
            if roi is None:
                roi_name, roi_type = "Whole_Image", "full"
                cx_val = cy_val = w_val = h_val = 0
            else:
                roi_name, roi_type = roi.name, roi.roi_type
                x1, y1, x2, y2 = roi.bbox
                cx_val, cy_val = (x1 + x2) / 2, (y1 + y2) / 2
                w_val, h_val = x2 - x1, y2 - y1

            ch_means: list[float] = []
            for i, (ch, params) in enumerate(zip(channels, params_list)):
                if not params["visible"]:
                    ch_means.append(0)
                    continue
                preview = ch.preview
                if roi is not None:
                    px1 = max(0, int(x1)); py1 = max(0, int(y1))
                    px2 = min(preview.shape[1], int(x2))
                    py2 = min(preview.shape[0], int(y2))
                    region = preview[py1:py2, px1:px2].copy()
                    if roi.roi_type != "rect":
                        mask = roi.get_mask(py2 - py1, px2 - px1, ds_factor=1)
                        region = region[mask] if mask.any() else region.ravel()
                    else:
                        region = region.ravel()
                else:
                    region = preview.ravel()

                cmin, cmax = params["min"], params["max"]
                if cmax <= cmin:
                    cmax = cmin + 1
                adj = np.clip((region - cmin) / (cmax - cmin), 0, 1) * params["brightness"]
                np.clip(adj, 0, 1, out=adj)
                nz = adj[adj > 0.01]

                if len(nz) > 0:
                    mean_v = float(np.mean(nz))
                    std_v = float(np.std(nz))
                    med_v = float(np.median(nz))
                    min_v = float(np.min(nz))
                    max_v = float(np.max(nz))
                else:
                    mean_v = std_v = med_v = min_v = max_v = 0.0
                ch_means.append(mean_v)

                notes_text = ""
                if annotations and roi is not None:
                    linked = [a.text for a in annotations if a.linked_roi == roi.name]
                    notes_text = " | ".join(linked)

                row = [
                    roi_name, roi_type,
                    f"{cx_val:.1f}", f"{cy_val:.1f}",
                    f"{w_val:.0f}", f"{h_val:.0f}",
                    ch_names[i], params["color_name"],
                    f"{mean_v:.4f}", f"{std_v:.4f}",
                    f"{med_v:.4f}", f"{min_v:.4f}", f"{max_v:.4f}",
                    f"{mean_v / max(0.001, ch_means[dapi_idx]) if i != dapi_idx else 1.0:.4f}",
                    f"{params['min']:.0f}", f"{params['max']:.0f}",
                    f"{params['brightness']:.2f}",
                ]
                if annotations is not None:
                    row.append(notes_text)
                w.writerow(row)


def save_composite_tif(path: str, rgb: np.ndarray, dpi: int = 300):
    if path.lower().endswith(".png"):
        Image.fromarray(rgb).save(path, dpi=(dpi, dpi))
    else:
        tifffile.imwrite(path, rgb)

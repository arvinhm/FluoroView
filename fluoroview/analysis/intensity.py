
from __future__ import annotations

import numpy as np


def region_adjusted(preview: np.ndarray, params: dict, roi=None) -> np.ndarray:
    if roi is not None:
        x1, y1, x2, y2 = roi.bbox
        px1, py1 = max(0, int(x1)), max(0, int(y1))
        px2 = min(preview.shape[1], int(x2))
        py2 = min(preview.shape[0], int(y2))
        region = preview[py1:py2, px1:px2].copy()
        if roi.roi_type != "rect" and region.size > 0:
            mask = roi.get_mask(py2 - py1, px2 - px1)
            region = region[mask] if mask.any() else region.ravel()
        else:
            region = region.ravel()
    else:
        region = preview.ravel()

    cmin, cmax = params["min"], params["max"]
    if cmax <= cmin:
        cmax = cmin + 1
    data = np.clip((region - cmin) / (cmax - cmin), 0, 1) * params["brightness"]
    np.clip(data, 0, 1, out=data)
    return data


def compute_ratios(channels, params_list, dapi_idx: int, roi=None):
    dapi_data = region_adjusted(channels[dapi_idx].preview, params_list[dapi_idx], roi)
    dapi_nz = dapi_data[dapi_data > 0.01]
    dapi_mean = float(np.mean(dapi_nz)) if len(dapi_nz) > 10 else 1.0
    if dapi_mean < 0.001:
        dapi_mean = 1.0

    names, ratios, sems, colors = [], [], [], []
    for i, (ch, p) in enumerate(zip(channels, params_list)):
        if i == dapi_idx or not p["visible"]:
            continue
        data = region_adjusted(ch.preview, p, roi)
        nz = data[data > 0.01]
        if len(nz) > 10:
            ch_mean = float(np.mean(nz))
            ch_sem = float(np.std(nz) / np.sqrt(len(nz)))
        else:
            ch_mean = ch_sem = 0.0
        ratios.append(ch_mean / dapi_mean)
        sems.append(ch_sem / dapi_mean)
        r, g, b = p["color"]
        colors.append(f"#{r:02x}{g:02x}{b:02x}")
        names.append(p.get("name", f"Ch{i + 1}"))
    return names, ratios, sems, colors

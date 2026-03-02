"""Per-cell marker quantification (MCQuant pattern from mcmicro)."""

from __future__ import annotations

import numpy as np


def quantify_cells(label_mask: np.ndarray, channel_arrays: list[np.ndarray],
                   channel_names: list[str]) -> dict:
    """Extract per-cell mean / median / total intensity for every marker.

    Returns a dict of arrays ready for ``np.savez`` or conversion to CSV::

        {"cell_id": [...], "centroid_y": [...], "centroid_x": [...],
         "area": [...], "mean_<name>": [...], "median_<name>": [...], ...}
    """
    from skimage.measure import regionprops

    regions = regionprops(label_mask)
    n = len(regions)
    result: dict[str, np.ndarray] = {
        "cell_id": np.zeros(n, dtype=np.int32),
        "centroid_y": np.zeros(n, dtype=np.float64),
        "centroid_x": np.zeros(n, dtype=np.float64),
        "area": np.zeros(n, dtype=np.int32),
    }
    for idx, reg in enumerate(regions):
        result["cell_id"][idx] = reg.label
        result["centroid_y"][idx] = reg.centroid[0]
        result["centroid_x"][idx] = reg.centroid[1]
        result["area"][idx] = reg.area

    for ch_arr, name in zip(channel_arrays, channel_names):
        means = np.zeros(n, dtype=np.float64)
        medians = np.zeros(n, dtype=np.float64)
        totals = np.zeros(n, dtype=np.float64)
        for idx, reg in enumerate(regionprops(label_mask, intensity_image=ch_arr)):
            pixels = ch_arr[label_mask == reg.label]
            means[idx] = float(np.mean(pixels)) if len(pixels) else 0
            medians[idx] = float(np.median(pixels)) if len(pixels) else 0
            totals[idx] = float(np.sum(pixels))
        result[f"mean_{name}"] = means
        result[f"median_{name}"] = medians
        result[f"total_{name}"] = totals
    return result


def cell_data_to_csv(cell_data: dict, path: str):
    """Write cell quantification dict to CSV."""
    import csv
    keys = list(cell_data.keys())
    n = len(cell_data[keys[0]])
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(keys)
        for i in range(n):
            w.writerow([cell_data[k][i] for k in keys])

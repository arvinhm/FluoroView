from __future__ import annotations

import numpy as np


def quantify_cells(label_mask: np.ndarray, channel_arrays: list[np.ndarray],
                   channel_names: list[str]) -> dict:
    from scipy import ndimage

    unique_labels = np.unique(label_mask)
    unique_labels = unique_labels[unique_labels > 0]
    n = len(unique_labels)

    if n == 0:
        empty = np.zeros(0, dtype=np.float64)
        result: dict[str, np.ndarray] = {
            "cell_id": np.zeros(0, dtype=np.int32),
            "centroid_y": empty.copy(),
            "centroid_x": empty.copy(),
            "area": np.zeros(0, dtype=np.int32),
        }
        for name in channel_names:
            result[f"mean_{name}"] = empty.copy()
            result[f"median_{name}"] = empty.copy()
            result[f"total_{name}"] = empty.copy()
        return result

    areas = ndimage.sum(np.ones_like(label_mask, dtype=np.int32),
                        label_mask, unique_labels).astype(np.int32)

    yy, xx = np.mgrid[:label_mask.shape[0], :label_mask.shape[1]]
    cy = np.array(ndimage.mean(yy, label_mask, unique_labels), dtype=np.float64)
    cx = np.array(ndimage.mean(xx, label_mask, unique_labels), dtype=np.float64)

    result = {
        "cell_id": unique_labels.astype(np.int32),
        "centroid_y": cy,
        "centroid_x": cx,
        "area": areas,
    }

    for ch_arr, name in zip(channel_arrays, channel_names):
        ch_float = ch_arr.astype(np.float64) if ch_arr.dtype != np.float64 else ch_arr
        means = np.array(ndimage.mean(ch_float, label_mask, unique_labels),
                         dtype=np.float64)
        totals = np.array(ndimage.sum(ch_float, label_mask, unique_labels),
                          dtype=np.float64)
        medians = np.array(
            ndimage.labeled_comprehension(
                ch_float, label_mask, unique_labels,
                np.median, np.float64, 0.0),
            dtype=np.float64)

        result[f"mean_{name}"] = means
        result[f"median_{name}"] = medians
        result[f"total_{name}"] = totals

    return result


def quantify_cells_region(label_mask: np.ndarray,
                          channel_arrays: list[np.ndarray],
                          channel_names: list[str],
                          y1: int, y2: int, x1: int, x2: int) -> dict:
    mask_crop = label_mask[y1:y2, x1:x2]
    ch_crops = [ch[y1:y2, x1:x2] for ch in channel_arrays]

    result = quantify_cells(mask_crop, ch_crops, channel_names)

    if len(result["cell_id"]) > 0:
        result["centroid_y"] = result["centroid_y"] + y1
        result["centroid_x"] = result["centroid_x"] + x1

    return result


def cell_data_to_csv(cell_data: dict, path: str):
    import csv
    keys = list(cell_data.keys())
    n = len(cell_data[keys[0]])
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(keys)
        for i in range(n):
            w.writerow([cell_data[k][i] for k in keys])

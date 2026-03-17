
from __future__ import annotations


from collections import Counter


import numpy as np


def compute_positivity(cell_data: dict, data_key: str,
                       threshold: float) -> np.ndarray:

    key = f"mean_{data_key}"

    vals = cell_data.get(key)

    if vals is None:

        return np.zeros(len(cell_data["cell_id"]), dtype=bool)

    return vals >= threshold


def assign_phenotypes(cell_data: dict,
                      thresholds: dict[str, float],
                      markers: list[str] | None = None,
                      data_keys: list[str] | None = None) -> np.ndarray:

    if data_keys is None:

        data_keys = sorted(thresholds.keys())

    if markers is None:

        markers = list(data_keys)


    n = len(cell_data["cell_id"])

    if n == 0:

        return np.empty(0, dtype=object)


    positivity = {}

    for dk in data_keys:

        positivity[dk] = compute_positivity(cell_data, dk, thresholds[dk])


    phenotypes = np.empty(n, dtype=object)

    for i in range(n):

        parts = []

        for label, dk in zip(markers, data_keys):

            sign = "+" if positivity[dk][i] else "\u2212"

            parts.append(f"{label}{sign}")

        phenotypes[i] = " ".join(parts)


    return phenotypes


def phenotype_counts(phenotypes: np.ndarray) -> dict[str, int]:

    if len(phenotypes) == 0:

        return {}

    counter = Counter(phenotypes)

    return dict(counter.most_common())


def auto_threshold(cell_data: dict, marker: str,
                   method: str = "otsu") -> float:

    key = f"mean_{marker}"

    vals = cell_data.get(key)

    if vals is None or len(vals) == 0:

        return 0.0


    vals = vals[np.isfinite(vals)]

    if len(vals) == 0:

        return 0.0


    if method == "otsu":

        try:

            from skimage.filters import threshold_otsu

            return float(threshold_otsu(vals))

        except (ImportError, ValueError):

            return float(np.median(vals))

    elif method == "median":

        nz = vals[vals > 0]

        return float(np.median(nz)) if len(nz) > 0 else 0.0

    elif method == "percentile":

        return float(np.percentile(vals, 75))

    return float(np.median(vals))


def phenotype_data_to_csv(cell_data: dict, phenotypes: np.ndarray,
                          path: str):

    import csv

    base_keys = list(cell_data.keys())

    with open(path, "w", newline="") as f:

        w = csv.writer(f)

        w.writerow(base_keys + ["phenotype"])

        for i in range(len(cell_data["cell_id"])):

            row = [cell_data[k][i] for k in base_keys]

            row.append(phenotypes[i])

            w.writerow(row)

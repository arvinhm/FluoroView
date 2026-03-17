
from __future__ import annotations

import os
import platform
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from functools import partial

import numpy as np

from fluoroview.segmentation.base import BaseSegmenter

if platform.system() == "Darwin":
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    os.environ.setdefault("CELLPOSE_USE_GPU", "0")

_N_WORKERS = max(1, (os.cpu_count() or 4) - 1)


def _segment_tile(tile_data: dict) -> dict:
    from cellpose import models

    nuc = tile_data["nuclear"]
    mem = tile_data.get("membrane")
    model_type = tile_data["model_type"]
    diameter = tile_data["diameter"]
    flow_threshold = tile_data["flow_threshold"]
    cellprob_threshold = tile_data["cellprob_threshold"]
    y1 = tile_data["y1"]
    x1 = tile_data["x1"]
    cell_offset = tile_data["cell_offset"]

    if hasattr(models, "CellposeModel") and not hasattr(models, "Cellpose"):
        model = models.CellposeModel(model_type=model_type, gpu=False)
    elif hasattr(models, "Cellpose"):
        model = models.Cellpose(model_type=model_type, gpu=False)
    else:
        model = models.CellposeModel(model_type=model_type, gpu=False)

    if mem is not None:
        img = np.stack([mem, nuc], axis=-1)
    else:
        img = nuc

    result = model.eval(
        img,
        diameter=diameter,
        flow_threshold=flow_threshold,
        cellprob_threshold=cellprob_threshold,
    )
    masks = result[0].astype(np.int32)
    masks[masks > 0] += cell_offset
    return {"masks": masks, "y1": y1, "x1": x1,
            "h": masks.shape[0], "w": masks.shape[1],
            "max_id": int(masks.max())}


class CellposeSegmenter(BaseSegmenter):

    TILE_THRESHOLD = 2048
    TILE_SIZE = 1024
    TILE_OVERLAP = 128

    def __init__(self, model_type: str = "cyto3", gpu: bool = False):
        self.model_type = model_type
        self._model = None

    def _get_model(self):
        if self._model is None:
            from cellpose import models
            if hasattr(models, "CellposeModel") and not hasattr(models, "Cellpose"):
                self._model = models.CellposeModel(
                    model_type=self.model_type, gpu=False)
            elif hasattr(models, "Cellpose"):
                self._model = models.Cellpose(
                    model_type=self.model_type, gpu=False)
            else:
                self._model = models.CellposeModel(
                    model_type=self.model_type, gpu=False)
        return self._model

    def segment(self, nuclear: np.ndarray, membrane: np.ndarray | None = None,
                mpp: float = 0.5, diameter: float | None = None,
                flow_threshold: float = 0.4,
                cellprob_threshold: float = 0.0) -> np.ndarray:
        if diameter is None and mpp > 0:
            diameter = max(15, 30 / mpp)

        h, w = nuclear.shape[:2]

        if h <= self.TILE_THRESHOLD and w <= self.TILE_THRESHOLD:
            return self._segment_single(nuclear, membrane, diameter,
                                         flow_threshold, cellprob_threshold)

        return self._segment_tiled(nuclear, membrane, diameter,
                                    flow_threshold, cellprob_threshold)

    def _segment_single(self, nuclear, membrane, diameter,
                         flow_threshold, cellprob_threshold):
        model = self._get_model()
        if membrane is not None:
            img = np.stack([membrane, nuclear], axis=-1)
        else:
            img = nuclear
        result = model.eval(
            img, diameter=diameter,
            flow_threshold=flow_threshold,
            cellprob_threshold=cellprob_threshold,
        )
        return result[0].astype(np.int32)

    def _segment_tiled(self, nuclear, membrane, diameter,
                        flow_threshold, cellprob_threshold):
        h, w = nuclear.shape[:2]
        ts = self.TILE_SIZE
        ov = self.TILE_OVERLAP

        tiles = []
        cell_offset = 0
        for y0 in range(0, h, ts - ov):
            for x0 in range(0, w, ts - ov):
                y1, y2 = y0, min(y0 + ts, h)
                x1, x2 = x0, min(x0 + ts, w)
                if y2 - y1 < 64 or x2 - x1 < 64:
                    continue
                tile = {
                    "nuclear": nuclear[y1:y2, x1:x2].copy(),
                    "membrane": membrane[y1:y2, x1:x2].copy() if membrane is not None else None,
                    "model_type": self.model_type,
                    "diameter": diameter,
                    "flow_threshold": flow_threshold,
                    "cellprob_threshold": cellprob_threshold,
                    "y1": y1, "x1": x1,
                    "cell_offset": cell_offset,
                }
                tiles.append(tile)
                cell_offset += 10000

        if not tiles:
            return self._segment_single(nuclear, membrane, diameter,
                                         flow_threshold, cellprob_threshold)

        n_workers = min(_N_WORKERS, len(tiles))

        with ThreadPoolExecutor(max_workers=n_workers) as pool:
            results = list(pool.map(_segment_tile, tiles))

        combined = np.zeros((h, w), dtype=np.int32)
        for r in results:
            y1, x1 = r["y1"], r["x1"]
            rh, rw = r["h"], r["w"]
            mask_tile = r["masks"]

            region = combined[y1:y1 + rh, x1:x1 + rw]
            new_cells = (mask_tile > 0) & (region == 0)
            region[new_cells] = mask_tile[new_cells]

        unique_ids = np.unique(combined)
        unique_ids = unique_ids[unique_ids > 0]
        remap = np.zeros(int(combined.max()) + 1, dtype=np.int32)
        for new_id, old_id in enumerate(unique_ids, start=1):
            remap[old_id] = new_id
        combined = remap[combined]

        return combined


CELLPOSE_MODELS = [
    "cyto3",
    "nuclei",
    "cyto2",
    "cyto",
    "tissuenet_cp3",
]

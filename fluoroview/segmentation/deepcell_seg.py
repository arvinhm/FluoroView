"""Optional DeepCell Mesmer wrapper for whole-cell + nuclear segmentation."""

from __future__ import annotations

import numpy as np

from fluoroview.segmentation.base import BaseSegmenter


class DeepCellSegmenter(BaseSegmenter):
    """Wraps ``deepcell.applications.Mesmer`` (requires tensorflow + deepcell)."""

    def __init__(self):
        from deepcell.applications import Mesmer  # type: ignore
        self.model = Mesmer()

    def segment(self, nuclear: np.ndarray, membrane: np.ndarray | None = None,
                mpp: float = 0.5) -> np.ndarray:
        if membrane is None:
            membrane = np.zeros_like(nuclear)
        img = np.stack([nuclear, membrane], axis=-1)
        img = np.expand_dims(img, 0)
        masks = self.model.predict(img, image_mpp=mpp)
        # masks shape: (1, H, W, 2)  — channel 0 = whole-cell, 1 = nuclear
        return masks[0, ..., 0].astype(np.int32)

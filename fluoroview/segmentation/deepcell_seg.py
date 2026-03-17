
from __future__ import annotations

import numpy as np

from fluoroview.segmentation.base import BaseSegmenter


class DeepCellSegmenter(BaseSegmenter):

    def __init__(self):
        from deepcell.applications import Mesmer
        self.model = Mesmer()

    def segment(self, nuclear: np.ndarray, membrane: np.ndarray | None = None,
                mpp: float = 0.5) -> np.ndarray:
        if membrane is None:
            membrane = np.zeros_like(nuclear)
        img = np.stack([nuclear, membrane], axis=-1)
        img = np.expand_dims(img, 0)
        masks = self.model.predict(img, image_mpp=mpp)
        return masks[0, ..., 0].astype(np.int32)

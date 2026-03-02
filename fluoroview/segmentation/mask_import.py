"""Import pre-computed segmentation masks from TIFF label images."""

from __future__ import annotations

import numpy as np
import tifffile

from fluoroview.segmentation.base import BaseSegmenter


def load_mask(path: str) -> np.ndarray:
    """Load a label-image mask where each cell has a unique integer."""
    mask = tifffile.imread(path)
    while mask.ndim > 2:
        mask = mask[0]
    return mask.astype(np.int32)


class ImportedMaskSegmenter(BaseSegmenter):
    """Pseudo-segmenter that wraps an already-computed mask."""

    def __init__(self, mask: np.ndarray):
        self._mask = mask

    def segment(self, nuclear=None, membrane=None, mpp=0.5):
        return self._mask

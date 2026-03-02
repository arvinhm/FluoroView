"""Abstract base for segmentation backends."""

from __future__ import annotations
from abc import ABC, abstractmethod

import numpy as np


class BaseSegmenter(ABC):
    """Common interface that all segmentation backends implement."""

    @abstractmethod
    def segment(self, nuclear: np.ndarray, membrane: np.ndarray | None = None,
                mpp: float = 0.5) -> np.ndarray:
        """Return an integer label mask (H, W) where 0 = background."""
        ...

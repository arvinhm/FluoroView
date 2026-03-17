
from __future__ import annotations
from abc import ABC, abstractmethod

import numpy as np


class BaseSegmenter(ABC):

    @abstractmethod
    def segment(self, nuclear: np.ndarray, membrane: np.ndarray | None = None,
                mpp: float = 0.5) -> np.ndarray:
        ...

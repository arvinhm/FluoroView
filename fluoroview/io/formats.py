"""Multi-format image loading helpers (OME-TIFF, CZI, ND2 via tifffile)."""

from __future__ import annotations

import tifffile
import numpy as np


def read_image(path: str) -> np.ndarray:
    """Read an image file; returns the raw array (may be multi-dim)."""
    try:
        return tifffile.memmap(path, mode="r")
    except Exception:
        return tifffile.imread(path)


def squeeze_to_2d(arr: np.ndarray) -> np.ndarray:
    while arr.ndim > 2:
        arr = arr[0]
    return arr


def get_ome_channel_names(path: str) -> list[str]:
    """Extract channel names from OME-TIFF metadata if available."""
    try:
        with tifffile.TiffFile(path) as tf:
            if tf.ome_metadata:
                import xml.etree.ElementTree as ET
                root = ET.fromstring(tf.ome_metadata)
                ns = {"ome": "http://www.openmicroscopy.org/Schemas/OME/2016-06"}
                channels = root.findall(".//ome:Channel", ns)
                if channels:
                    return [ch.get("Name", f"Ch{i}") for i, ch in enumerate(channels)]
    except Exception:
        pass
    return []

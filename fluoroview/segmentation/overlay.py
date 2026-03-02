"""Segmentation outline overlay rendering.

Adapted from deepcell-tf ``plot_utils.make_outline_overlay``.
"""

from __future__ import annotations

import numpy as np


def find_boundaries_fast(label_mask: np.ndarray) -> np.ndarray:
    """Return a boolean boundary map without importing skimage at module level."""
    from skimage.segmentation import find_boundaries
    return find_boundaries(label_mask, mode="inner")


def make_outline_overlay(
    rgb: np.ndarray,
    label_mask: np.ndarray,
    color: tuple[int, int, int] = (255, 255, 0),
    thickness: int = 1,
) -> np.ndarray:
    """Draw cell outlines from *label_mask* onto *rgb* (uint8 H×W×3)."""
    overlay = rgb.copy()
    boundaries = find_boundaries_fast(label_mask)
    if thickness > 1:
        from scipy.ndimage import binary_dilation
        boundaries = binary_dilation(boundaries, iterations=thickness - 1)
    overlay[boundaries] = color
    return overlay


def _cell_id_to_color(cell_id: int) -> tuple[int, int, int]:
    """Map a cell ID to a unique RGB color using golden ratio HSV spread."""
    import colorsys
    golden = 0.618033988749895
    hue = (cell_id * golden) % 1.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.85, 0.95)
    return int(r * 255), int(g * 255), int(b * 255)


def make_unique_outline_overlay(
    rgb: np.ndarray,
    label_mask: np.ndarray,
    thickness: int = 1,
) -> np.ndarray:
    """Draw cell outlines with a unique color per cell ID."""
    overlay = rgb.copy()
    boundaries = find_boundaries_fast(label_mask)
    if thickness > 1:
        from scipy.ndimage import binary_dilation
        boundaries = binary_dilation(boundaries, iterations=thickness - 1)
    # Get cell IDs on boundaries
    boundary_labels = label_mask[boundaries]
    unique_ids = np.unique(boundary_labels)
    unique_ids = unique_ids[unique_ids > 0]
    for cid in unique_ids:
        cell_boundary = boundaries & (label_mask == cid)
        color = _cell_id_to_color(int(cid))
        overlay[cell_boundary] = color
    return overlay


def make_cell_color_overlay(
    rgb: np.ndarray,
    label_mask: np.ndarray,
    cell_values: dict[int, float],
    cmap_name: str = "coolwarm",
    alpha: float = 0.4,
) -> np.ndarray:
    """Colour each cell by a scalar value (e.g. expression level)."""
    import matplotlib.cm as cm

    cmap = cm.get_cmap(cmap_name)
    vals = np.array(list(cell_values.values()))
    if len(vals) == 0:
        return rgb
    vmin, vmax = float(vals.min()), float(vals.max())
    if vmax <= vmin:
        vmax = vmin + 1

    overlay = rgb.astype(np.float32) / 255.0
    for cell_id, val in cell_values.items():
        mask_region = label_mask == cell_id
        normed = (val - vmin) / (vmax - vmin)
        r, g, b, _ = cmap(normed)
        overlay[mask_region] = (
            overlay[mask_region] * (1 - alpha) + np.array([r, g, b]) * alpha
        )
    return (np.clip(overlay, 0, 1) * 255).astype(np.uint8)

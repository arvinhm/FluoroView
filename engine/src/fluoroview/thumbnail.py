"""Small composite previews of cached scans, rendered like the studio renders them."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

from .datasets import histogram_summary
from .io.model import ImageInfo
from .pyramid.store import PyramidStore

AUTO_LOW, AUTO_HIGH = "0.5", "99.8"


def _hex(color: str) -> np.ndarray:
    v = int(color.lstrip("#"), 16)
    return np.array([(v >> 16) & 255, (v >> 8) & 255, v & 255], np.float32) / 255.0


def render_thumbnail(store: PyramidStore, histograms: np.ndarray, info: ImageInfo, size: int) -> bytes:
    """PNG no larger than ``size`` on its long side: auto-contrasted fluorescence channels, summed."""
    level = next((lv for lv in reversed(store.levels) if max(lv.width, lv.height) >= size), store.levels[0])
    tile = store.tile
    fluorescent = [ch for ch in info.channels if ch.kind == "fluorescence"] or list(info.channels)
    rgb = np.zeros((level.height, level.width, 3), np.float32)
    for ch in fluorescent:
        plane = np.zeros((level.height, level.width), np.float32)
        for ty in range(level.tiles_y(tile)):
            for tx in range(level.tiles_x(tile)):
                chunk = store.read_chunk(level.index, ch.index, ty, tx)
                if chunk is not None:
                    plane[ty * tile: ty * tile + chunk.shape[0], tx * tile: tx * tile + chunk.shape[1]] = chunk
        stats = histogram_summary(histograms[ch.index], info.saturation, 16, True)
        lo = stats["percentiles"].get(AUTO_LOW, stats["min"])
        hi = max(stats["percentiles"].get(AUTO_HIGH, stats["max"]), lo + 1)
        rgb += np.clip((plane - lo) / (hi - lo), 0, 1)[..., None] * _hex(ch.color)
    image = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8))
    scale = size / max(image.size)
    if scale < 1:
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.BOX)
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()

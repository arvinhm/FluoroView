"""ROI data model — rectangle, circle, and freehand polygon regions."""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw


class ROIData:
    """Represents a single ROI: rectangle, circle, or freehand polygon."""

    _counter = 0

    def __init__(self, roi_type: str, bbox: tuple, points=None, name: str | None = None):
        ROIData._counter += 1
        self.roi_type = roi_type        # 'rect', 'circle', 'freehand'
        self.bbox = bbox                # (x1, y1, x2, y2) in preview coords
        self.points = points or []      # freehand polygon vertices
        self.name = name or f"ROI-{ROIData._counter}"

    # ── mask generation ────────────────────────────────────────────────

    def get_mask(self, h: int, w: int, ds_factor: float = 1) -> np.ndarray:
        """Boolean mask of shape *(h, w)*; *ds_factor* scales preview→target."""
        mask = np.zeros((h, w), dtype=bool)
        x1, y1, x2, y2 = self.bbox
        sx1 = max(0, int(x1 * ds_factor))
        sy1 = max(0, int(y1 * ds_factor))
        sx2 = min(w, int(x2 * ds_factor))
        sy2 = min(h, int(y2 * ds_factor))

        if self.roi_type == "rect":
            mask[sy1:sy2, sx1:sx2] = True
        elif self.roi_type == "circle":
            cy = (sy1 + sy2) / 2
            cx = (sx1 + sx2) / 2
            ry = (sy2 - sy1) / 2
            rx = (sx2 - sx1) / 2
            yy, xx = np.ogrid[:h, :w]
            ellipse = ((xx - cx) / max(1, rx)) ** 2 + ((yy - cy) / max(1, ry)) ** 2
            mask[ellipse <= 1.0] = True
        elif self.roi_type == "freehand" and self.points:
            img = Image.new("L", (w, h), 0)
            scaled = [(int(px * ds_factor), int(py * ds_factor)) for px, py in self.points]
            if len(scaled) > 2:
                ImageDraw.Draw(img).polygon(scaled, fill=255)
            mask = np.array(img) > 127
        return mask

    # ── serialisation ──────────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "roi_type": self.roi_type,
            "bbox": list(self.bbox),
            "points": [list(p) for p in self.points],
            "name": self.name,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ROIData":
        roi = cls(
            roi_type=d["roi_type"],
            bbox=tuple(d["bbox"]),
            points=[tuple(p) for p in d.get("points", [])],
            name=d.get("name"),
        )
        return roi

    @classmethod
    def reset_counter(cls):
        cls._counter = 0

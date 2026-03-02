"""Session state — serialisable snapshot of the entire viewer."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from fluoroview.core.roi import ROIData
from fluoroview.core.annotations import Annotation


@dataclass
class SessionState:
    """Everything needed to fully restore a viewer session."""

    version: str = "2.0"
    file_entries: dict = field(default_factory=dict)
    current_file: str | None = None
    channel_settings: dict = field(default_factory=dict)  # name -> [param dicts]
    rois: list[ROIData] = field(default_factory=list)
    annotations: list[Annotation] = field(default_factory=list)
    zoom_level: float = 1.0
    pan_offset: list = field(default_factory=lambda: [0, 0])
    seg_mask: np.ndarray | None = None
    cell_data: np.ndarray | None = None
    channel_groups: dict = field(default_factory=dict)
    channels_full: list[np.ndarray] = field(default_factory=list)
    channels_preview: list[np.ndarray] = field(default_factory=list)

    def to_arrays(self) -> dict[str, Any]:
        """Pack into a dict suitable for ``np.savez_compressed``."""
        import json
        
        class NpEncoder(json.JSONEncoder):
            def default(self, obj):
                if isinstance(obj, np.integer): return int(obj)
                if isinstance(obj, np.floating): return float(obj)
                if isinstance(obj, np.ndarray): return obj.tolist()
                return super().default(obj)

        metadata = {
            "version": self.version,
            "files": {k: list(v) for k, v in self.file_entries.items()},
            "current_file": self.current_file,
            "zoom": self.zoom_level,
            "pan": list(self.pan_offset),
            "channel_groups": self.channel_groups,
        }
        arrays: dict[str, Any] = {
            "metadata": np.array([json.dumps(metadata, cls=NpEncoder)]),
            "channel_settings": np.array([json.dumps(self.channel_settings, cls=NpEncoder)]),
            "rois": np.array([json.dumps([r.to_dict() for r in self.rois], cls=NpEncoder)]),
            "annotations": np.array([json.dumps([a.to_dict() for a in self.annotations], cls=NpEncoder)]),
        }
        if self.seg_mask is not None:
            arrays["seg_mask"] = self.seg_mask
        if self.cell_data is not None:
            if isinstance(self.cell_data, dict):
                arrays["cell_data"] = np.array([json.dumps(
                    {k: v.tolist() if hasattr(v, 'tolist') else v
                     for k, v in self.cell_data.items()}, cls=NpEncoder)])
            else:
                arrays["cell_data"] = self.cell_data
            
        for i, (full, prev) in enumerate(zip(self.channels_full, self.channels_preview)):
            arrays[f"ch_{i}_full"] = full
            arrays[f"ch_{i}_prev"] = prev
            
        return arrays

    @classmethod
    def from_arrays(cls, data) -> "SessionState":
        import json

        meta = json.loads(str(data["metadata"][0]))
        ch_settings = json.loads(str(data["channel_settings"][0]))
        rois = [ROIData.from_dict(d) for d in json.loads(str(data["rois"][0]))]
        annots = [Annotation.from_dict(d) for d in json.loads(str(data["annotations"][0]))]

        files = {}
        for k, v in meta.get("files", {}).items():
            files[k] = tuple(v)

        seg_mask = data["seg_mask"] if "seg_mask" in data else None
        cell_data = None
        if "cell_data" in data:
            raw = data["cell_data"]
            if raw.ndim == 0 or (raw.ndim == 1 and raw.dtype.kind in ('U', 'O')):
                try:
                    cd = json.loads(str(raw[0]) if raw.ndim == 1 else str(raw))
                    cell_data = {k: np.array(v) for k, v in cd.items()}
                except Exception:
                    cell_data = raw
            else:
                cell_data = raw
        
        channels_full = []
        channels_preview = []
        i = 0
        while f"ch_{i}_full" in data:
            channels_full.append(data[f"ch_{i}_full"])
            channels_preview.append(data[f"ch_{i}_prev"])
            i += 1

        return cls(
            version=meta.get("version", "2.0"),
            file_entries=files,
            current_file=meta.get("current_file"),
            channel_settings=ch_settings,
            rois=rois,
            annotations=annots,
            zoom_level=meta.get("zoom", 1.0),
            pan_offset=meta.get("pan", [0, 0]),
            seg_mask=seg_mask,
            cell_data=cell_data,
            channel_groups=meta.get("channel_groups", {}),
            channels_full=channels_full,
            channels_preview=channels_preview,
        )

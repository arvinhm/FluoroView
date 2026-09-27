"""Pyramid cache on disk: an OME-Zarr v0.4 group of Zarr v2 arrays with raw 512x512 chunks.

Chunks are stored uncompressed. On 16-bit fluorescence with a camera offset, lossless codecs gain
only 1.25-1.43x while costing 1.3-3.5 ms to decode each tile (measured on a Cytation scan), so raw
chunks are both faster to write and faster to serve. Each chunk is written to a temporary file and
renamed into place, so readers never see a torn chunk while a build is running.
"""

from __future__ import annotations

import contextlib
import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..io.model import ImageInfo

TILE = 512
FORMAT = "fluoroview-pyramid-1"


@dataclass(frozen=True)
class Level:
    index: int
    width: int
    height: int

    @property
    def factor(self) -> int:
        return 1 << self.index

    def tiles_x(self, tile: int = TILE) -> int:
        return -(-self.width // tile)

    def tiles_y(self, tile: int = TILE) -> int:
        return -(-self.height // tile)


def plan_levels(width: int, height: int, tile: int = TILE) -> tuple[Level, ...]:
    levels = [Level(0, width, height)]
    while max(levels[-1].width, levels[-1].height) > tile:
        prev = levels[-1]
        levels.append(Level(prev.index + 1, (prev.width + 1) // 2, (prev.height + 1) // 2))
    return tuple(levels)


class PyramidStore:
    def __init__(self, root: Path, levels: tuple[Level, ...], n_channels: int, dtype: np.dtype, tile: int = TILE):
        self.root = Path(root)
        self.levels = levels
        self.n_channels = n_channels
        self.dtype = np.dtype(dtype)
        self.tile = tile
        self._tmp_seq = 0
        self._tmp_lock = threading.Lock()
        self._versions: dict[tuple[int, int, int, int], int] = {}

    # -- layout --------------------------------------------------------------------------------

    @classmethod
    def create(cls, root: Path, info: ImageInfo, tile: int = TILE) -> PyramidStore:
        levels = plan_levels(info.width, info.height, tile)
        store = cls(root, levels, len(info.channels), np.dtype(info.dtype).newbyteorder("<"), tile)
        root.mkdir(parents=True, exist_ok=True)
        (root / ".zgroup").write_text(json.dumps({"zarr_format": 2}))
        (root / ".zattrs").write_text(json.dumps(store._ome_attrs(info), indent=1))
        for level in levels:
            ldir = root / str(level.index)
            (ldir / ".zarray").parent.mkdir(parents=True, exist_ok=True)
            (ldir / ".zarray").write_text(json.dumps({
                "zarr_format": 2,
                "shape": [store.n_channels, level.height, level.width],
                "chunks": [1, tile, tile],
                "dtype": store.dtype.str,
                "compressor": None,
                "fill_value": 0,
                "order": "C",
                "filters": None,
                "dimension_separator": "/",
            }))
            for c in range(store.n_channels):
                for ty in range(level.tiles_y(tile)):
                    (ldir / str(c) / str(ty)).mkdir(parents=True, exist_ok=True)
        return store

    @classmethod
    def open(cls, root: Path) -> PyramidStore:
        levels = []
        i = 0
        while (root / str(i) / ".zarray").exists():
            meta = json.loads((root / str(i) / ".zarray").read_text())
            n_channels, height, width = meta["shape"]
            levels.append(Level(i, width, height))
            tile, dtype = meta["chunks"][1], np.dtype(meta["dtype"])
            i += 1
        if not levels:
            raise FileNotFoundError(f"no pyramid levels in {root}")
        return cls(root, tuple(levels), n_channels, dtype, tile)

    def _ome_attrs(self, info: ImageInfo) -> dict:
        px = info.pixel_size_um or 1.0
        top = 65535 if self.dtype.itemsize == 2 else 255
        return {
            "multiscales": [{
                "version": "0.4",
                "name": info.name,
                "axes": [
                    {"name": "c", "type": "channel"},
                    {"name": "y", "type": "space", "unit": "micrometer"},
                    {"name": "x", "type": "space", "unit": "micrometer"},
                ],
                "datasets": [
                    {"path": str(level.index),
                     "coordinateTransformations": [
                         {"type": "scale", "scale": [1.0, px * level.factor, px * level.factor]}]}
                    for level in self.levels
                ],
                "type": "2x2 area mean",
            }],
            "omero": {
                "channels": [
                    {"label": ch.name, "color": ch.color.lstrip("#").upper(), "active": True,
                     "window": {"min": 0, "max": top, "start": 0, "end": top}}
                    for ch in info.channels
                ],
            },
            "fluoroview": {"format": FORMAT, "source": info.path},
        }

    # -- chunks --------------------------------------------------------------------------------

    def chunk_path(self, level: int, c: int, ty: int, tx: int) -> Path:
        return self.root / str(level) / str(c) / str(ty) / str(tx)

    def write_chunk(self, level: int, c: int, ty: int, tx: int, data: np.ndarray, version: int = 0) -> None:
        """Write one chunk atomically. A write never replaces a chunk written with a higher version."""
        tile = self.tile
        if data.shape == (tile, tile) and data.flags.c_contiguous and data.dtype == self.dtype:
            block = data
        else:
            block = np.zeros((tile, tile), self.dtype)
            block[: data.shape[0], : data.shape[1]] = data
        path = self.chunk_path(level, c, ty, tx)
        key = (level, c, ty, tx)
        with self._tmp_lock:
            self._tmp_seq += 1
            tmp = path.with_name(f".{path.name}.{self._tmp_seq}.tmp")
        with open(tmp, "wb") as f:
            f.write(memoryview(block).cast("B"))
        with self._tmp_lock:
            if version < self._versions.get(key, -1):
                os.remove(tmp)
                return
            os.replace(tmp, path)
            self._versions[key] = version

    def read_chunk(self, level: int, c: int, ty: int, tx: int) -> np.ndarray | None:
        """The stored chunk cropped to the level bounds, or None if it has not been written."""
        lvl = self.levels[level]
        try:
            raw = self.chunk_path(level, c, ty, tx).read_bytes()
        except FileNotFoundError:
            return None
        block = np.frombuffer(raw, self.dtype).reshape(self.tile, self.tile)
        h = min(self.tile, lvl.height - ty * self.tile)
        w = min(self.tile, lvl.width - tx * self.tile)
        return block[:h, :w]

    def nbytes(self) -> int:
        total = 0
        for dirpath, _dirs, files in os.walk(self.root):
            for name in files:
                with contextlib.suppress(FileNotFoundError):
                    total += os.stat(os.path.join(dirpath, name)).st_size
        return total

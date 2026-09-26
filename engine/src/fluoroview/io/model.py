"""Image and channel descriptions shared by readers, the pyramid builder and the API."""

from __future__ import annotations

import os
from contextlib import AbstractContextManager
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any, Protocol

import numpy as np


class Layout(StrEnum):
    CONTIGUOUS = "contiguous"
    """Each channel plane is one uncompressed run of bytes, so any rows can be read by offset."""
    CHUNKED = "chunked"
    """Strips or tiles that have to be decoded (compressed, scattered or tiled)."""


@dataclass(frozen=True)
class Channel:
    index: int
    name: str
    color: str
    excitation_nm: float | None = None
    emission_nm: float | None = None
    kind: str = "fluorescence"
    """"fluorescence" or "transmitted" (bright field, phase contrast, DIC)."""


@dataclass(frozen=True)
class ImageInfo:
    path: str
    width: int
    height: int
    dtype: str
    channels: tuple[Channel, ...]
    pixel_size_um: float | None
    saturation: int | None
    layout: Layout
    vendor: str
    acquisition: dict = field(default_factory=dict)
    files: tuple[str, ...] = ()
    """Member files when the channels come from separate files; empty for a single file."""

    @property
    def name(self) -> str:
        base = self.path.rsplit("/", 1)[-1]
        return f"{base} · {len(self.files)} files" if self.files else base

    @property
    def folder(self) -> str:
        return self.path if self.files else os.path.dirname(self.path)

    def to_json(self) -> dict:
        out = asdict(self)
        out["layout"] = self.layout.value
        out["name"] = self.name
        out["folder"] = self.folder
        return out


class Source(Protocol):
    """What the pyramid builder and datasets need from a reader."""

    info: ImageInfo

    @property
    def dtype(self) -> np.dtype: ...

    def read_rows(self, c: int, y0: int, y1: int, *, fd: Any = None) -> np.ndarray: ...

    def stream(self) -> AbstractContextManager[Any]: ...

    def fingerprint(self) -> str: ...

    def close(self) -> None: ...


def file_fingerprint(path: str) -> str:
    real = os.path.realpath(path)
    st = os.stat(real)
    return f"{real}\0{st.st_size}\0{st.st_mtime_ns}"

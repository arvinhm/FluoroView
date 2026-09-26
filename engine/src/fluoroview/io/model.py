"""Image and channel descriptions shared by readers, the pyramid builder and the API."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum


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

    @property
    def name(self) -> str:
        return self.path.rsplit("/", 1)[-1]

    def to_json(self) -> dict:
        out = asdict(self)
        out["layout"] = self.layout.value
        out["name"] = self.name
        return out

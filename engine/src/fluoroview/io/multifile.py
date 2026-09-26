"""Several single-channel TIFF files of the same size read as one multichannel image."""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from typing import Any

import numpy as np

from .colors import PALETTE, TRANSMITTED, default_color, is_transmitted_name
from .model import Channel, ImageInfo, Layout
from .tiff import TiffSource, UnsupportedImage

_SUFFIX = re.compile(r"(\.ome)?\.(tiff?|btf|tf8|qptiff)$", re.I)
_TRAILING_INDEX = re.compile(r"[\s_\-]+(?:(?:channel|chan|ch|c)[\s_\-]*)?\d+$", re.I)
_NUCLEAR = re.compile(r"\b(dapi|hoechst|nuclei|nucleus)\b", re.I)
_GENERIC = re.compile(r"Channel \d+")


def channel_name_from_file(path: str) -> str:
    stem = _SUFFIX.sub("", os.path.basename(path))
    name = _TRAILING_INDEX.sub("", stem) or stem
    return re.sub(r"[_]+", " ", name).strip() or stem


def assign_colors(names: list[str], emissions: list[float | None], transmitted: list[bool]) -> list[str]:
    """Distinct colours: emission wavelength when known, blue for the nuclear stain, then the palette."""
    colors: list[str | None] = [None] * len(names)
    used: set[str] = set()
    for i, name in enumerate(names):
        if transmitted[i]:
            colors[i] = TRANSMITTED
            continue
        preferred = default_color(i, name, emissions[i]) if emissions[i] else (
            PALETTE[0] if _NUCLEAR.search(name) else None)
        if preferred and preferred not in used:
            colors[i] = preferred
            used.add(preferred)
    free = [c for c in PALETTE if c not in used]
    for i in range(len(names)):
        if colors[i] is None:
            colors[i] = free.pop(0) if free else PALETTE[i % len(PALETTE)]
    return [c for c in colors if c is not None]


class MultiFileSource:
    def __init__(self, paths: list[str]):
        if len(paths) < 2:
            raise UnsupportedImage("Choose at least two files to combine as channels.")
        self.members = [TiffSource(p) for p in paths]
        try:
            self._setup()
        except Exception:
            self.close()
            raise

    def _setup(self) -> None:
        first = self.members[0].info
        for m in self.members:
            i = m.info
            if len(i.channels) != 1:
                raise UnsupportedImage(f"{i.name} has {len(i.channels)} channels; combine single-channel files only.")
            if (i.width, i.height, i.dtype) != (first.width, first.height, first.dtype):
                raise UnsupportedImage(
                    f"{i.name} is {i.width} × {i.height} {i.dtype}, but {first.name} is "
                    f"{first.width} × {first.height} {first.dtype}; files must match to be combined.")
        names = [
            channel_name_from_file(m.path) if _GENERIC.fullmatch(m.info.channels[0].name) else m.info.channels[0].name
            for m in self.members
        ]
        emissions = [m.info.channels[0].emission_nm for m in self.members]
        transmitted = [m.info.channels[0].kind == "transmitted" or is_transmitted_name(n) for m, n in
                       zip(self.members, names, strict=True)]
        colors = assign_colors(names, emissions, transmitted)
        folder = os.path.dirname(self.members[0].path)
        self.info = ImageInfo(
            path=folder,
            width=first.width,
            height=first.height,
            dtype=first.dtype,
            channels=tuple(
                Channel(index=c, name=names[c], color=colors[c],
                        excitation_nm=m.info.channels[0].excitation_nm, emission_nm=emissions[c],
                        kind="transmitted" if transmitted[c] else "fluorescence")
                for c, m in enumerate(self.members)),
            pixel_size_um=next((m.info.pixel_size_um for m in self.members if m.info.pixel_size_um), None),
            saturation=next((m.info.saturation for m in self.members if m.info.saturation), None),
            layout=Layout.CONTIGUOUS if all(m.info.layout is Layout.CONTIGUOUS for m in self.members)
            else Layout.CHUNKED,
            vendor="multi-file",
            acquisition=first.acquisition,
            files=tuple(m.path for m in self.members),
        )

    @property
    def dtype(self) -> np.dtype:
        return self.members[0].dtype

    def read_rows(self, c: int, y0: int, y1: int, *, fd: Any = None) -> np.ndarray:
        return self.members[c].read_rows(0, y0, y1, fd=fd[c] if fd else None)

    @contextmanager
    def stream(self) -> Iterator[list[Any]]:
        with ExitStack() as stack:
            yield [stack.enter_context(m.stream()) for m in self.members]

    def fingerprint(self) -> str:
        return "\n".join(m.fingerprint() for m in self.members)

    def close(self) -> None:
        for m in getattr(self, "members", []):
            m.close()

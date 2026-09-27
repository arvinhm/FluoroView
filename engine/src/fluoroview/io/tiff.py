"""TIFF-family sources: BioTek Gen5, OME-TIFF, ImageJ and plain multi-page TIFF.

A source gives full-resolution rows of one channel at a time. Uncompressed planes stored as one
run of bytes (the Gen5 layout) are read by offset with large ``preadv`` calls; everything else goes
through tifffile's lazy Zarr view, which decodes only the strips or tiles that are touched.
"""

from __future__ import annotations

import fcntl
import os
import re
import sys
import threading
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from contextlib import contextmanager

import numpy as np
import tifffile
import zarr

from .biotek import is_biotek, parse_page
from .colors import default_color, is_transmitted_name
from .model import Channel, ImageInfo, Layout, file_fingerprint

SUPPORTED_DTYPES = (np.dtype(np.uint8), np.dtype(np.uint16))
_F_NOCACHE = getattr(fcntl, "F_NOCACHE", 48 if sys.platform == "darwin" else None)
_CHANNEL_AXES = "CIQ"


class UnsupportedImage(ValueError):
    pass


def _pread_into(fd: int, out: np.ndarray, offset: int) -> None:
    view = memoryview(out).cast("B")
    done = 0
    while done < len(view):
        n = os.preadv(fd, [view[done:]], offset + done)
        if n == 0:
            raise EOFError(f"unexpected end of file at byte {offset + done}")
        done += n


def _contiguous_offset(page, height: int, width: int, itemsize: int) -> int | None:
    key = page.keyframe
    if (
        int(key.compression) != 1
        or key.is_tiled
        or key.samplesperpixel != 1
        or int(key.predictor) != 1
        or int(key.fillorder) != 1
    ):
        return None
    offsets, counts = page.dataoffsets, page.databytecounts
    if not offsets or sum(counts) != height * width * itemsize:
        return None
    for i in range(len(offsets) - 1):
        if offsets[i] + counts[i] != offsets[i + 1]:
            return None
    return int(offsets[0])


class TiffSource:
    """Read access to one TIFF-family image at full resolution."""

    def __init__(self, path: str | os.PathLike):
        self.path = os.path.realpath(path)
        self._tf = tifffile.TiffFile(self.path)
        self._zarr = None
        self._zarr_lock = threading.Lock()
        try:
            self._setup()
        except Exception:
            self._tf.close()
            raise
        self._fd = os.open(self.path, os.O_RDONLY)

    # -- setup ---------------------------------------------------------------------------------

    def _setup(self) -> None:
        tf = self._tf
        series = tf.series[0]
        axes, shape = series.axes, tuple(series.shape)
        if "Y" not in axes or "X" not in axes:
            raise UnsupportedImage(f"no Y/X axes in {axes!r}")
        dtype = np.dtype(series.dtype)
        if dtype not in SUPPORTED_DTYPES:
            raise UnsupportedImage(f"FluoroView reads 8- and 16-bit integer images; this file is {dtype.name}.")
        self._file_dtype = dtype.newbyteorder(tf.byteorder)
        self._dtype = dtype.newbyteorder("=")
        self._axes, self._shape = axes, shape
        height, width = shape[axes.index("Y")], shape[axes.index("X")]

        chan_axis = next((a for a in _CHANNEL_AXES if a in axes), "S" if "S" in axes else None)
        n_channels = shape[axes.index(chan_axis)] if chan_axis else 1
        self._chan_axis = chan_axis

        pages = self._channel_pages(series, n_channels)
        offsets = None
        if pages is not None:
            offsets = [_contiguous_offset(p, height, width, self._dtype.itemsize) for p in pages]
            if any(o is None for o in offsets):
                offsets = None
        self._offsets = offsets
        layout = Layout.CONTIGUOUS if offsets else Layout.CHUNKED

        names: list[str | None] = [None] * n_channels
        ex: list[float | None] = [None] * n_channels
        em: list[float | None] = [None] * n_channels
        transmitted: list[bool | None] = [None] * n_channels
        pixel_size = saturation = None
        acquisition: dict = {}
        vendor = "tiff"

        first_desc = pages[0].keyframe.description if pages else tf.pages[0].description
        if pages and is_biotek(first_desc):
            vendor = "biotek-gen5"
            for c, page in enumerate(pages):
                meta = parse_page(tf.pages[page.index].description)
                names[c], ex[c], em[c] = meta.channel_name, meta.excitation_nm, meta.emission_nm
                transmitted[c] = meta.transmitted
                if c == 0:
                    pixel_size, saturation, acquisition = meta.pixel_size_um, meta.saturation, meta.acquisition
        elif tf.is_ome and tf.ome_metadata:
            vendor = "ome-tiff"
            pixel_size, ome_channels = _ome_channels(tf.ome_metadata)
            for c, (name, e_x, e_m) in enumerate(ome_channels[:n_channels]):
                names[c], ex[c], em[c] = name, e_x, e_m
        elif tf.is_imagej:
            vendor = "imagej"
            ij = tf.imagej_metadata or {}
            labels = ij.get("Labels") or []
            for c in range(min(n_channels, len(labels))):
                names[c] = str(labels[c]) or None
            if str(ij.get("unit", "")).lower() in ("micron", "microns", "um", "\u00b5m", "\u03bcm"):
                pixel_size = _resolution_um(tf.pages[0], per_unit=1.0)
        if pixel_size is None and vendor == "tiff":
            pixel_size = _resolution_um(tf.pages[0], per_unit=None)

        if chan_axis == "S" and n_channels == 3 and not any(names):
            names = ["Red", "Green", "Blue"]
        for c in range(n_channels):
            if transmitted[c] is None:
                transmitted[c] = em[c] is None and is_transmitted_name(names[c] or "")
        rgb = chan_axis == "S" and n_channels == 3
        channels = tuple(
            Channel(
                index=c,
                name=names[c] or f"Channel {c + 1}",
                color=("#ff4b3e", "#2bff6b", "#3d7aff")[c] if rgb
                else default_color(c, names[c] or "", em[c], bool(transmitted[c])),
                excitation_nm=ex[c],
                emission_nm=em[c],
                kind="transmitted" if transmitted[c] and not rgb else "fluorescence",
            )
            for c in range(n_channels)
        )
        self.info = ImageInfo(
            path=self.path,
            width=int(width),
            height=int(height),
            dtype=self._dtype.str,
            channels=channels,
            pixel_size_um=pixel_size,
            saturation=saturation,
            layout=layout,
            vendor=vendor,
            acquisition=acquisition,
        )

    def _channel_pages(self, series, n_channels: int):
        """One page per channel when every plane is its own page (YX last); otherwise None."""
        axes, shape = self._axes, self._shape
        if axes[-2:] != "YX":
            return None
        lead_axes, lead_shape = axes[:-2], shape[:-2]
        pages = series.pages
        if lead_axes == "":
            return [pages[0]]
        chan_axis = self._chan_axis
        out = []
        for c in range(n_channels):
            idx = tuple(c if a == chan_axis else 0 for a in lead_axes)
            page = pages[int(np.ravel_multi_index(idx, lead_shape))]
            if page is None:
                return None
            out.append(page)
        return out

    # -- reading -------------------------------------------------------------------------------

    @property
    def dtype(self) -> np.dtype:
        return self._dtype

    def read_rows(self, c: int, y0: int, y1: int, *, fd: int | None = None) -> np.ndarray:
        """Full-width rows ``[y0, y1)`` of channel ``c`` as a C-contiguous array."""
        width = self.info.width
        if self._offsets is not None:
            out = np.empty((y1 - y0, width), self._file_dtype)
            _pread_into(self._fd if fd is None else fd, out, self._offsets[c] + y0 * width * out.itemsize)
            if out.dtype != self._dtype:
                out = out.byteswap().view(self._dtype)
            return out
        return np.ascontiguousarray(self._zarr_view()[self._index(c, slice(y0, y1))])

    def read_segment(self, c: int, y: int, x0: int, x1: int) -> np.ndarray:
        """Pixels ``[x0, x1)`` of row ``y`` of channel ``c``, reading only the bytes or chunks they need."""
        if self._offsets is not None:
            out = np.empty(x1 - x0, self._file_dtype)
            _pread_into(self._fd, out, self._offsets[c] + (y * self.info.width + x0) * out.itemsize)
            return out.byteswap().view(self._dtype) if out.dtype != self._dtype else out
        return np.ascontiguousarray(self._zarr_view()[self._index(c, slice(y, y + 1), slice(x0, x1))]).reshape(-1)

    def _index(self, c: int, rows: slice, cols: slice = slice(None)) -> tuple:
        idx = []
        for a in self._axes:
            if a == "Y":
                idx.append(rows)
            elif a == "X":
                idx.append(cols)
            elif a == self._chan_axis:
                idx.append(c)
            else:
                idx.append(0)
        return tuple(idx)

    def _zarr_view(self):
        with self._zarr_lock:
            if self._zarr is None:
                self._zarr = zarr.open_array(self._tf.series[0].aszarr(level=0), mode="r")
            return self._zarr

    @contextmanager
    def stream(self) -> Iterator[int | None]:
        """A private descriptor for one sequential pass that bypasses the OS page cache."""
        if self._offsets is None:
            yield None
            return
        fd = os.open(self.path, os.O_RDONLY)
        try:
            if _F_NOCACHE is not None:
                fcntl.fcntl(fd, _F_NOCACHE, 1)
            yield fd
        finally:
            os.close(fd)

    def fingerprint(self) -> str:
        return file_fingerprint(self.path)

    def close(self) -> None:
        os.close(self._fd)
        self._tf.close()


def _ome_channels(xml: str) -> tuple[float | None, list[tuple[str | None, float | None, float | None]]]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None, []
    ns = re.match(r"\{.*\}", root.tag)
    q = ns.group(0) if ns else ""
    pixels = root.find(f"{q}Image/{q}Pixels")
    if pixels is None:
        return None, []
    size = pixels.get("PhysicalSizeX")
    unit = pixels.get("PhysicalSizeXUnit", "µm")
    scale = {"µm": 1.0, "um": 1.0, "nm": 1e-3, "mm": 1e3}.get(unit)
    pixel_size = float(size) * scale if size and scale else None

    def num(v: str | None) -> float | None:
        try:
            return float(v) if v else None
        except ValueError:
            return None

    channels = [
        (ch.get("Name") or None, num(ch.get("ExcitationWavelength")), num(ch.get("EmissionWavelength")))
        for ch in pixels.findall(f"{q}Channel")
    ]
    return pixel_size, channels


def _resolution_um(page, per_unit: float | None) -> float | None:
    """Pixel size from XResolution. ``per_unit`` forces the unit (ImageJ writes pixels per micron)."""
    tag = page.tags.get("XResolution")
    if tag is None:
        return None
    num, den = tag.value
    if not num or not den:
        return None
    pixels_per_unit = num / den
    if per_unit is not None:
        return per_unit / pixels_per_unit
    unit = page.tags.get("ResolutionUnit")
    if unit is not None and int(unit.value) == 3:  # centimetre
        return 1e4 / pixels_per_unit
    return None

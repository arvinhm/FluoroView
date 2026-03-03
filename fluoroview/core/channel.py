"""Channel data model and loaders for single- and multi-channel TIF files."""

from __future__ import annotations

import os
import glob
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import tifffile

from fluoroview.constants import MAX_PREVIEW_DIM, NUM_WORKERS


class ChannelData:
    """One image channel: memory-mapped full-res array + downsampled preview."""

    def __init__(self, path: str, full_data, preview, ds_factor: int,
                 vmin: float, vmax: float):
        self.path = path
        self.original_path = path
        self.full_data = full_data
        self.preview = preview          # float32
        self.ds_factor = ds_factor
        self.vmin = vmin
        self.vmax = vmax
        self.full_h, self.full_w = full_data.shape
        self.is_edited = False

    def reload_from(self, new_path: str):
        """Reload channel data from a (possibly edited) file."""
        try:
            full = tifffile.memmap(new_path, mode="r")
        except Exception:
            full = tifffile.imread(new_path)
        while full.ndim > 2:
            full = full[0]
        self.full_data = full
        self.full_h, self.full_w = full.shape
        ds = max(1, max(self.full_h, self.full_w) // MAX_PREVIEW_DIM)
        self.ds_factor = ds
        self.preview = full[::ds, ::ds].astype(np.float32)
        self.path = new_path
        self.is_edited = True
        sample_step = max(1, self.full_h // 500)
        sample = full[::sample_step, ::ds].astype(np.float32).ravel()
        nonzero = sample[sample > 0]
        if len(nonzero) > 100:
            self.vmin = float(np.percentile(nonzero, 0.5))
            self.vmax = float(np.percentile(nonzero, 99.5))
        else:
            self.vmin = float(self.preview.min())
            self.vmax = float(self.preview.max())


# ── loaders ────────────────────────────────────────────────────────────────


def _percentile_range(full, ds, h):
    sample_step = max(1, h // 500)
    sample = full[::sample_step, ::ds].astype(np.float32).ravel()
    nonzero = sample[sample > 0]
    if len(nonzero) > 100:
        return float(np.percentile(nonzero, 0.5)), float(np.percentile(nonzero, 99.5))
    return float(sample.min()), float(sample.max())


def load_channel(path: str, max_dim: int = MAX_PREVIEW_DIM) -> ChannelData:
    try:
        full = tifffile.memmap(path, mode="r")
    except Exception:
        full = tifffile.imread(path)
    while full.ndim > 2:
        full = full[0]
    h, w = full.shape
    ds = max(1, max(h, w) // max_dim)
    preview = full[::ds, ::ds].astype(np.float32)
    vmin, vmax = _percentile_range(full, ds, h)
    return ChannelData(path, full, preview, ds, vmin, vmax)


def load_multichannel_tif(path: str, max_dim: int = MAX_PREVIEW_DIM) -> list[ChannelData]:
    try:
        img = tifffile.memmap(path, mode="r")
    except Exception:
        img = tifffile.imread(path)

    if img.ndim == 2:
        channels_data = [img]
    elif img.ndim == 3:
        if img.shape[0] <= 100:
            channels_data = [img[c] for c in range(img.shape[0])]
        elif img.shape[2] <= 100:
            channels_data = [img[:, :, c] for c in range(img.shape[2])]
        else:
            channels_data = [img]
    else:
        channels_data = [img[0]] if img.ndim > 2 else [img]

    results: list[ChannelData] = []
    for ch_data in channels_data:
        while ch_data.ndim > 2:
            ch_data = ch_data[0]
        h, w = ch_data.shape
        ds = max(1, max(h, w) // max_dim)
        preview = ch_data[::ds, ::ds].astype(np.float32)
        vmin, vmax = _percentile_range(ch_data, ds, h)
        results.append(ChannelData(path, ch_data, preview, ds, vmin, vmax))
    return results


IMAGE_EXTENSIONS = (
    "*.tif", "*.tiff", "*.jpg", "*.jpeg", "*.png",
    "*.bmp", "*.gif", "*.webp", "*.ome.tif", "*.ome.tiff",
    "*.svs", "*.ndpi", "*.czi",
)


def load_any_image(path: str, max_dim: int = MAX_PREVIEW_DIM) -> "list[ChannelData]":
    """Load any supported image format (TIFF, JPG, PNG, etc.)."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".tif", ".tiff", ".ome.tif", ".svs", ".ndpi", ".czi"):
        return load_multichannel_tif(path, max_dim)
    # Raster formats via PIL
    from PIL import Image as PILImage
    pil = PILImage.open(path)
    arr = np.array(pil)
    if arr.ndim == 2:
        channels_data = [arr]
    elif arr.ndim == 3:
        if arr.shape[2] <= 4:
            channels_data = [arr[:, :, c] for c in range(min(arr.shape[2], 3))]
        else:
            channels_data = [arr]
    else:
        channels_data = [arr]

    results = []
    for ch_data in channels_data:
        while ch_data.ndim > 2:
            ch_data = ch_data[0]
        h, w = ch_data.shape
        ds = max(1, max(h, w) // max_dim)
        preview = ch_data[::ds, ::ds].astype(np.float32)
        vmin, vmax = _percentile_range(ch_data, ds, h)
        results.append(ChannelData(path, ch_data, preview, ds, vmin, vmax))
    return results


def scan_folder(folder_path: str) -> dict:
    """Return ``{display_name: ('multi', path) | ('folder', [paths])}``."""
    results: dict = {}
    for entry in sorted(os.listdir(folder_path)):
        full = os.path.join(folder_path, entry)
        if os.path.isdir(full):
            images = []
            for ext in IMAGE_EXTENSIONS:
                images.extend(glob.glob(os.path.join(full, ext)))
            images = sorted(set(images))
            if images:
                results[entry] = ("folder", images)
    # Single files in folder
    all_images = []
    for ext in IMAGE_EXTENSIONS:
        all_images.extend(glob.glob(os.path.join(folder_path, ext)))
    for img in sorted(set(all_images)):
        basename = os.path.splitext(os.path.basename(img))[0]
        if basename not in results:
            results[basename] = ("multi", img)
    return results


def get_pixel_size_um(path: str) -> float:
    """Try to extract pixel size in microns from TIFF metadata."""
    try:
        with tifffile.TiffFile(path) as tf:
            # OME metadata
            if tf.ome_metadata:
                import xml.etree.ElementTree as ET
                root = ET.fromstring(tf.ome_metadata)
                ns = {"ome": "http://www.openmicroscopy.org/Schemas/OME/2016-06"}
                pixels = root.find(".//ome:Pixels", ns)
                if pixels is not None:
                    psx = pixels.get("PhysicalSizeX")
                    if psx:
                        return float(psx)
            # Standard TIFF resolution tags
            page = tf.pages[0]
            tags = page.tags
            if "XResolution" in tags:
                xr = tags["XResolution"].value
                if isinstance(xr, tuple) and xr[1] > 0:
                    res_unit = tags.get("ResolutionUnit")
                    ppu = xr[0] / xr[1]
                    if ppu > 0:
                        if res_unit and res_unit.value == 3:  # cm
                            return 10000.0 / ppu
                        elif res_unit and res_unit.value == 2:  # inch
                            return 25400.0 / ppu
    except Exception:
        pass
    return 0.0

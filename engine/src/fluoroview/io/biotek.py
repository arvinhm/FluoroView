"""Metadata from BioTek / Agilent Gen5 TIFF exports (Cytation, Lionheart).

Gen5 writes one page per channel and stores a ``<BTIImageMetaData>`` XML document in each page's
ImageDescription. The channel is encoded in an attribute such as
``<Channel Color="Stitched[DAPI 377,447]">`` (name, excitation nm, emission nm).
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

_CHANNEL = re.compile(
    r"^\s*(?:[A-Za-z ]+\[)?\s*(?P<name>.*?)\s+(?P<ex>\d+(?:\.\d+)?)\s*,\s*(?P<em>\d+(?:\.\d+)?)\s*\]?\s*$"
)


@dataclass(frozen=True)
class BioTekPage:
    channel_name: str | None
    excitation_nm: float | None
    emission_nm: float | None
    width_px: int | None
    height_px: int | None
    width_um: float | None
    height_um: float | None
    saturation: int | None
    transmitted: bool = False
    acquisition: dict = field(default_factory=dict)

    @property
    def pixel_size_um(self) -> float | None:
        if self.width_um and self.width_px:
            return self.width_um / self.width_px
        return None


def is_biotek(description: str | None) -> bool:
    return bool(description) and "<BTIImageMetaData" in description[:1024]


def parse_channel(color_attr: str) -> tuple[str | None, float | None, float | None]:
    m = _CHANNEL.match(color_attr or "")
    if m and m["name"]:
        return m["name"].strip(), float(m["ex"]), float(m["em"])
    name = re.sub(r"^[A-Za-z ]+\[|\]$", "", color_attr or "").strip()
    return (name or None), None, None


def parse_page(description: str) -> BioTekPage:
    root = ET.fromstring(description)

    def text(path: str) -> str | None:
        el = root.find(path)
        return el.text.strip() if el is not None and el.text and el.text.strip() else None

    def number(path: str) -> float | None:
        value = text(path)
        try:
            return float(value) if value is not None else None
        except ValueError:
            return None

    channel = root.find("ImageAcquisition/Channel")
    name, ex, em = parse_channel(channel.get("Color", "") if channel is not None else "")
    transmitted = channel is not None and any(
        (channel.findtext(tag) or "").strip().upper() == "TRUE" for tag in ("BrightField", "PhaseContrast"))
    width_px, height_px = number("ImageAcquisition/PixelWidth"), number("ImageAcquisition/PixelHeight")
    saturation = number("System/Camera/SaturationLevel")

    acquisition = {
        "software": f"Gen5 {text('System/Gen5/Version')}" if text("System/Gen5/Version") else None,
        "camera": text("System/Camera/Model"),
        "objective": " ".join(
            v for v in (text("ImageAcquisition/DisplayedObjectiveSize"), text("ImageAcquisition/ObjectiveMfg")) if v
        ) or None,
        "numerical_aperture": number("ImageAcquisition/NumericalAperture"),
        "exposure_ms": number("ImageAcquisition/ShutterSpeedMS"),
        "camera_gain": number("ImageAcquisition/CameraGain"),
        "led_intensity": number("ImageAcquisition/LEDIntensity"),
        "date": text("ImageReference/Date"),
        "time": text("ImageReference/Time"),
        "plate": text("ImageReference/Plate"),
        "well": text("ImageReference/Well"),
        "original_filename": text("ImageReference/OriginalFilename"),
    }
    return BioTekPage(
        channel_name=name,
        excitation_nm=ex,
        emission_nm=em,
        width_px=int(width_px) if width_px else None,
        height_px=int(height_px) if height_px else None,
        width_um=number("ImageAcquisition/ImageWidthMicrons"),
        height_um=number("ImageAcquisition/ImageHeightMicrons"),
        saturation=int(saturation) if saturation else None,
        transmitted=transmitted,
        acquisition={k: v for k, v in acquisition.items() if v is not None},
    )

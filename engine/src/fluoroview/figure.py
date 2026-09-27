"""Publication figures and raw exports of an area, rendered from the pyramid.

A figure is the composite plus one panel per visible channel, side by side, with the studio's
display settings applied exactly as the viewer's shader does (window, gamma, tone curve, invert,
colour or colour map, intensity, then an additive or maximum blend). Every file is capped in size:
the finest pyramid level whose output fits is used, so pixels are either the originals or exact 2x2
area means, never resampled otherwise.
"""

from __future__ import annotations

import io
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

from . import __version__
from .luts import IDENTITY_CURVE, channel_lut, colormap_values, hex_rgb
from .projects import now_iso
from .pyramid.kernels import downsample2
from .regions import rings_of

GAP_FRACTION = 0.02
GAP_COLOR = (255, 255, 255)
PIN_FILL = (255, 255, 255)
PIN_TEXT = (11, 11, 12)
FONT = Path(__file__).with_name("fonts") / "IBMPlexSans-Medium.woff"
"""the studio's typeface (SIL Open Font License, fonts/OFL.txt); Pillow's built-in font has no µ"""


def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT), size)


@dataclass(frozen=True)
class Display:
    visible: bool
    color: str
    lo: float
    hi: float
    gamma: float
    lut: str = "color"
    invert: bool = False
    curve: tuple[tuple[float, float], ...] = IDENTITY_CURVE
    intensity: float = 1.0

    @property
    def plain(self) -> bool:
        """Only a window, gamma and tint, as before tone curves and colour maps existed."""
        return self.lut == "color" and not self.invert and self.curve == IDENTITY_CURVE and self.intensity == 1.0


@dataclass(frozen=True)
class Plan:
    level: int
    box: tuple[int, int, int, int]
    """full-resolution area, clipped to the image"""
    level_box: tuple[int, int, int, int]
    """the same area in pixels of `level`"""
    panels: tuple[int | None, ...]
    """None is the composite, otherwise a channel index"""
    panel_width: int
    panel_height: int
    gap: int
    width: int
    height: int

    def to_json(self) -> dict:
        return {"level": self.level, "downsample": 2**self.level, "box": list(self.box),
                "panels": ["composite" if p is None else p for p in self.panels],
                "panel_width": self.panel_width, "panel_height": self.panel_height,
                "width": self.width, "height": self.height}


def clip_box(box, width: int, height: int) -> tuple[int, int, int, int]:
    if not all(math.isfinite(v) for v in box):
        raise ValueError("the area must be given by finite numbers")
    x0, x1 = sorted((box[0], box[2]))
    y0, y1 = sorted((box[1], box[3]))
    out = (max(0, math.floor(x0)), max(0, math.floor(y0)), min(width, math.ceil(x1)), min(height, math.ceil(y1)))
    if out[2] <= out[0] or out[3] <= out[1]:
        raise ValueError("the area does not overlap the image")
    return out


def _level_box(levels, box: tuple[int, int, int, int], level: int) -> tuple[int, int, int, int]:
    """`box` in pixels of `level`. Levels past the stored pyramid continue its halving (ceil(n / 2^level))."""
    f = 2**level
    width, height = -(-levels[0].width // f), -(-levels[0].height // f)
    x0, y0 = box[0] // f, box[1] // f
    return x0, y0, max(x0 + 1, min(width, -(-box[2] // f))), max(y0 + 1, min(height, -(-box[3] // f)))


def plan(levels, box: tuple[int, int, int, int], panels: tuple[int | None, ...], max_side: int) -> Plan:
    """Finest level at which the panels side by side fit in `max_side` pixels."""
    level = 0
    while True:
        lb = _level_box(levels, box, level)
        pw, ph = lb[2] - lb[0], lb[3] - lb[1]
        gap = max(4, round(pw * GAP_FRACTION)) if len(panels) > 1 else 0
        width = len(panels) * pw + (len(panels) - 1) * gap
        if max(width, ph) <= max_side or (pw == 1 and ph == 1):
            return Plan(level, box, lb, panels, pw, ph, gap, width, ph)
        level += 1


def read_area(ds, level: int, c: int, lbox: tuple[int, int, int, int]) -> np.ndarray:
    """Raw values of `lbox` at `level`; past the stored pyramid, the same 2x2 area means computed on the fly."""
    top = len(ds.levels) - 1
    if level <= top:
        return ds.read_region(level, c, *lbox)
    k = 2 ** (level - top)
    x0, y0, x1, y1 = lbox
    top_level = ds.levels[top]
    a = ds.read_region(top, c, x0 * k, y0 * k, min(x1 * k, top_level.width), min(y1 * k, top_level.height))
    for _ in range(level - top):
        a = downsample2(a)
    return a[: y1 - y0, : x1 - x0]


def _rgb(color: str) -> np.ndarray:
    return hex_rgb(color).astype(np.float32)


def render_channel(data: np.ndarray, d: Display) -> np.ndarray:
    """Float RGB of one channel, as the viewer's shader draws it (on the CPU)."""
    t = np.clip((data.astype(np.float32) - d.lo) / max(d.hi - d.lo, 1.0), 0.0, 1.0)
    if d.gamma != 1.0:
        t **= 1.0 / d.gamma
    if d.plain:
        return t[..., None] * _rgb(d.color)
    table = channel_lut(d.color, d.lut, d.invert, d.curve, d.intensity).astype(np.float32)
    pos = t * np.float32(len(table) - 1)
    i0 = np.minimum(pos.astype(np.int32), len(table) - 2)
    f = (pos - i0)[..., None]
    return table[i0] * (1.0 - f) + table[i0 + 1] * f


def _label_color(d: Display) -> tuple[int, int, int]:
    """A channel's name in its colour, or in the brightest colour of its colour map."""
    rgb = _rgb(d.color) if d.lut == "color" else colormap_values(d.lut, np.array([1.0]))[0]
    return tuple(int(round(v * 255)) for v in rgb)


def compose(layers: list[np.ndarray], blend: str, shape: tuple[int, ...]) -> np.ndarray:
    """The composite of channel layers: their sum ("add") or their per-colour maximum ("max")."""
    out = np.zeros(shape, np.float32)
    for rgb in layers:
        if blend == "max":
            np.maximum(out, rgb, out=out)
        else:
            out += rgb
    return out


def to_u8(rgb: np.ndarray) -> np.ndarray:
    return (np.clip(rgb, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def nice_length(target_um: float) -> float:
    """Largest 1-2-5 length not longer than `target_um`."""
    pow10 = 10 ** math.floor(math.log10(target_um))
    return next((n * pow10 for n in (5, 2, 1) if n * pow10 <= target_um), pow10)


def format_length(um: float) -> str:
    if um >= 1000:
        return f"{um / 1000:.3g} mm"
    if um < 1:
        return f"{um * 1000:.3g} nm"
    return f"{um:.3g} µm"


class _Overlay:
    """Draws in panel pixels; image coordinates are full-resolution pixels."""

    def __init__(self, img: Image.Image, p: Plan):
        self.img = img
        self.draw = ImageDraw.Draw(img)
        self.f = 2**p.level
        self.x0, self.y0 = p.level_box[0], p.level_box[1]
        side = max(p.panel_width, p.panel_height)
        self.font_px = max(12, round(side * 0.028))
        self.font = _font(self.font_px)
        self.line = max(1, round(side / 700))

    def xy(self, x: float, y: float) -> tuple[float, float]:
        return x / self.f - self.x0, y / self.f - self.y0

    def text(self, xy: tuple[float, float], text: str, fill, anchor: str = "la") -> None:
        shadow = max(1, self.font_px // 12)
        self.draw.text((xy[0] + shadow, xy[1] + shadow), text, font=self.font, fill=(0, 0, 0), anchor=anchor)
        self.draw.text(xy, text, font=self.font, fill=fill, anchor=anchor)

    def region(self, r: dict) -> None:
        pts = [self.xy(x, y) for x, y in r["points"]]
        color = r.get("color") or "#ffffff"
        if r["shape"] in ("rectangle", "ellipse"):
            (ax, ay), (bx, by) = pts
            box = [min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)]
            if r["shape"] == "rectangle":
                self.draw.rectangle(box, outline=color, width=self.line)
            else:
                self.draw.ellipse(box, outline=color, width=self.line)
        else:
            self.draw.line([*pts, pts[0]], fill=color, width=self.line, joint="curve")
        for ring in rings_of(r):
            ring_pts = [self.xy(x, y) for x, y in ring]
            self.draw.line([*ring_pts, ring_pts[0]], fill=color, width=self.line, joint="curve")

    def pin(self, x: float, y: float, label: str) -> None:
        cx, cy = self.xy(x, y)
        r = max(7, round(self.font_px * 0.75))
        self.draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=PIN_FILL, outline=(0, 0, 0), width=max(1, r // 6))
        self.draw.text((cx, cy), label, font=_font(round(r * 1.1)), fill=PIN_TEXT, anchor="mm")

    def scale_bar(self, um_per_px: float, width: int, height: int) -> None:
        length_um = nice_length(0.2 * width * um_per_px)
        bar = length_um / um_per_px
        pad = self.font_px
        thick = max(3, round(height * 0.012))
        x1, y1 = width - pad, height - pad
        self.draw.rectangle([x1 - bar - 1, y1 - thick - 1, x1 + 1, y1 + 1], fill=(0, 0, 0))
        self.draw.rectangle([x1 - bar, y1 - thick, x1, y1], fill=(255, 255, 255))
        self.text((x1 - bar / 2, y1 - thick - pad * 0.4), format_length(length_um), (255, 255, 255), anchor="md")


def render_figure(ds, p: Plan, displays: list[Display], *, regions: list[dict], notes: list[dict],
                  scale_bar: bool, labels: bool, pixel_size: float | None, blend: str = "add") -> Image.Image:
    shape = (p.panel_height, p.panel_width, 3)
    layers: list[np.ndarray] = []
    channel_px: dict[int, np.ndarray] = {}
    for c, d in enumerate(displays):
        if not d.visible:
            continue
        rgb = render_channel(read_area(ds, p.level, c, p.level_box), d)
        layers.append(rgb)
        if c in p.panels:
            channel_px[c] = to_u8(rgb)
    composite = compose(layers, blend, shape)
    canvas = Image.new("RGB", (p.width, p.height), GAP_COLOR)
    px = pixel_size
    for i, panel in enumerate(p.panels):
        img = Image.fromarray(to_u8(composite) if panel is None else channel_px[panel], "RGB")
        ov = _Overlay(img, p)
        for r in regions:
            ov.region(r)
        for k, n in enumerate(notes):
            ov.pin(n["x"], n["y"], str(k + 1))
        if labels:
            name = "Composite" if panel is None else ds.info.channels[panel].name
            fill = (255, 255, 255) if panel is None else _label_color(displays[panel])
            ov.text((ov.font_px * 0.8, ov.font_px * 0.6), name, fill)
        if scale_bar and panel is None and px:
            ov.scale_bar(px * 2**p.level, p.panel_width, p.panel_height)
        canvas.paste(img, (i * (p.panel_width + p.gap), 0))
    return canvas


def provenance(ds, p: Plan, displays: list[Display], pixel_size: float | None, blend: str = "add") -> dict:
    """What the figure shows, for reproducibility. The file name only: figures are shared, paths are private."""
    px = pixel_size
    return {
        "software": f"FluoroView {__version__}",
        "created": now_iso(),
        "source": ds.info.scan_key,
        "area_px": list(p.box),
        "pyramid_level": p.level,
        "pixel_size_um": px * 2**p.level if px else None,
        "blend": blend,
        "channels": [{"name": ch.name, "visible": d.visible, "color": d.color, "lo": d.lo, "hi": d.hi, "gamma": d.gamma,
                      "lut": d.lut, "invert": d.invert, "curve": [list(pt) for pt in d.curve], "intensity": d.intensity}
                     for ch, d in zip(ds.info.channels, displays, strict=True)],
    }


def encode_png(img: Image.Image, dpi: int, meta: dict) -> bytes:
    info = PngImagePlugin.PngInfo()
    info.add_text("Software", meta["software"])
    info.add_text("Description", json.dumps(meta))
    buf = io.BytesIO()
    img.save(buf, "PNG", pnginfo=info, dpi=(dpi, dpi))
    return buf.getvalue()


def encode_tiff(img: Image.Image, dpi: int, meta: dict) -> bytes:
    buf = io.BytesIO()
    tifffile.imwrite(buf, np.asarray(img), photometric="rgb", resolution=(dpi, dpi), resolutionunit="INCH",
                     description=json.dumps(meta), software=meta["software"], compression="zlib", metadata=None)
    return buf.getvalue()


def write_ome(ds, p: Plan, path: Path, pixel_size: float | None) -> None:
    """Raw values of every channel in the planned area, one plane at a time, with the physical pixel size."""
    lx0, ly0, lx1, ly1 = p.level_box
    n = len(ds.info.channels)
    meta: dict = {"axes": "CYX", "Channel": {"Name": [ch.name for ch in ds.info.channels]}}
    px = pixel_size
    if px:
        size = px * 2**p.level
        meta.update(PhysicalSizeX=size, PhysicalSizeXUnit="µm", PhysicalSizeY=size, PhysicalSizeYUnit="µm")
    dtype = np.dtype(ds.source.dtype)
    nbytes = n * (lx1 - lx0) * (ly1 - ly0) * dtype.itemsize
    planes = (read_area(ds, p.level, c, p.level_box) for c in range(n))
    tifffile.imwrite(path, planes, shape=(n, ly1 - ly0, lx1 - lx0), dtype=dtype, ome=True, metadata=meta,
                     compression="zlib", bigtiff=nbytes > 2**31, software=f"FluoroView {__version__}")

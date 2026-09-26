from .model import Channel, ImageInfo, Layout
from .tiff import TiffSource, UnsupportedImage

OPENABLE_SUFFIXES = (".tif", ".tiff", ".btf", ".tf8", ".qptiff")


def is_openable(name: str) -> bool:
    return name.lower().endswith(OPENABLE_SUFFIXES) and not name.startswith("._")


__all__ = ["Channel", "ImageInfo", "Layout", "OPENABLE_SUFFIXES", "TiffSource", "UnsupportedImage", "is_openable"]

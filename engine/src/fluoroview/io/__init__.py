from .model import Channel, ImageInfo, Layout, Source, file_fingerprint
from .multifile import MultiFileSource
from .tiff import TiffSource, UnsupportedImage

OPENABLE_SUFFIXES = (".tif", ".tiff", ".btf", ".tf8", ".qptiff")


def is_openable(name: str) -> bool:
    return name.lower().endswith(OPENABLE_SUFFIXES) and not name.startswith("._")


__all__ = [
    "OPENABLE_SUFFIXES", "Channel", "ImageInfo", "Layout", "MultiFileSource", "Source", "TiffSource",
    "UnsupportedImage", "file_fingerprint", "is_openable",
]

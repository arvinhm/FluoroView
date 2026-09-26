"""Default display colours for fluorescence channels.

Colours follow the emission wavelength when it is known, then common dye names, then a fixed
palette. Blue / green / magenta / amber keeps the four most common channels distinguishable for
red-green colour-blind viewers.
"""

from __future__ import annotations

import re

PALETTE = ("#3d7aff", "#2bff6b", "#ff3df2", "#ffb000", "#00e1ff", "#ff4b3e", "#ffffff", "#f0ff3c")

_BY_NAME = (
    (("dapi", "hoechst"), 0),
    (("gfp", "fitc", "af488", "alexa488"), 1),
    (("rfp", "tritc", "cy3", "af555", "af568", "alexa555", "alexa568"), 2),
    (("cy5", "af647", "alexa647"), 3),
    (("cy7", "af750"), 4),
)


def default_color(index: int, name: str, emission_nm: float | None = None) -> str:
    if emission_nm:
        for limit, slot in ((490, 0), (560, 1), (630, 2), (720, 3)):
            if emission_nm < limit:
                return PALETTE[slot]
        return PALETTE[4]
    key = re.sub(r"[^a-z0-9]", "", name.lower())
    for names, slot in _BY_NAME:
        if any(n in key for n in names):
            return PALETTE[slot]
    return PALETTE[index % len(PALETTE)]

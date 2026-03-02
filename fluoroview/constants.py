"""Shared constants for FluoroView v2 — iOS-inspired Design System.

Uses CustomTkinter for genuine modern UI with rounded widgets,
smooth sliders, and Apple-quality aesthetics.
"""

import os

MAX_PREVIEW_DIM = 2500
NUM_WORKERS = os.cpu_count() or 4

IF_COLORS = {
    "Blue (DAPI)":    (0, 100, 255),
    "Green (FITC)":   (0, 255, 0),
    "Red (Cy5)":      (255, 0, 0),
    "Orange":         (255, 165, 0),
    "Magenta (Cy3)":  (255, 0, 255),
    "Cyan":           (0, 255, 255),
    "Yellow":         (255, 255, 0),
    "White":          (255, 255, 255),
    "Hot Pink":       (255, 50, 120),
}

DEFAULT_COLORS = [
    "Blue (DAPI)", "Green (FITC)", "Red (Cy5)", "Orange",
    "Magenta (Cy3)", "Cyan", "Yellow", "White", "Hot Pink",
]

LUT_PRESETS = {
    "Grays":     lambda v: (v, v, v),
    "Fire":      lambda v: (__import__('numpy').clip(v * 3, 0, 1),
                            __import__('numpy').clip(v * 3 - 1, 0, 1),
                            __import__('numpy').clip(v * 3 - 2, 0, 1)),
    "Ice":       lambda v: (__import__('numpy').clip(v * 3 - 2, 0, 1),
                            __import__('numpy').clip(v * 3 - 1, 0, 1),
                            __import__('numpy').clip(v * 3, 0, 1)),
    "GreenFire": lambda v: (__import__('numpy').clip(v * 2 - 1, 0, 1),
                            __import__('numpy').clip(v * 2, 0, 1),
                            __import__('numpy').clip(v * 3 - 2, 0, 1)),
}

# ══════════════════════════════════════════════════════════════════════
#  iOS-INSPIRED DARK THEME — used for manual Canvas drawing, charts, etc.
# ══════════════════════════════════════════════════════════════════════

THEME = {
    # Apple system dark backgrounds
    "BG":           "#0a0b10",
    "BG2":          "#111318",
    "BG3":          "#16181f",
    "BG4":          "#1c1e26",

    # Foreground
    "FG":           "#e5e5ea",
    "FG2":          "#8e8e93",
    "DIM":          "#48494e",

    # Apple system colors
    "ACCENT":       "#0a84ff",     # iOS blue
    "GREEN":        "#30d158",     # iOS green
    "RED":          "#ff453a",     # iOS red
    "ORANGE":       "#ff9f0a",     # iOS orange
    "YELLOW":       "#ffd60a",     # iOS yellow
    "TEAL":         "#64d2ff",     # iOS teal
    "PURPLE":       "#bf5af2",     # iOS purple
    "PINK":         "#ff375f",     # iOS pink

    # Borders
    "BORDER":       "#2c2e36",
    "SEPARATOR":    "#1e2028",

    # Charts
    "CHART_BG":     "#0e1017",
    "CHART_GRID":   "#1a1c24",
    "CHART_TEXT":   "#8e8e93",
}

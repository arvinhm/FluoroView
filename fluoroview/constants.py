
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
    "Lime":           (180, 255, 0),
    "Teal":           (0, 200, 180),
    "Coral":          (255, 100, 80),
    "Violet":         (160, 50, 255),
    "Sky Blue":       (100, 200, 255),
    "Gold":           (255, 215, 0),
    "Salmon":         (255, 140, 105),
    "Spring Green":   (0, 255, 160),
    "Deep Pink":      (255, 20, 147),
    "Turquoise":      (64, 224, 208),
    "Orchid":         (218, 112, 214),
    "Khaki":          (240, 230, 140),
    "Tomato":         (255, 99, 71),
    "Aquamarine":     (127, 255, 212),
    "Plum":           (221, 160, 221),
    "Chartreuse":     (127, 255, 0),
    "Sienna":         (255, 130, 71),
    "Pale Green":     (152, 251, 152),
    "Medium Blue":    (0, 80, 200),
    "Light Coral":    (240, 128, 128),
    "Steel Blue":     (100, 149, 237),
    "Peru":           (205, 133, 63),
    "Sea Green":      (60, 179, 113),
    "Slate Blue":     (106, 90, 205),
    "Dark Orange":    (255, 140, 0),
    "Olive":          (128, 180, 0),
    "Indian Red":     (205, 92, 92),
    "Cadet Blue":     (95, 158, 160),
    "Lawn Green":     (124, 252, 0),
    "Medium Orchid":  (186, 85, 211),
    "Sandy Brown":    (244, 164, 96),
    "Light Sea":      (32, 178, 170),
    "Dodger Blue":    (30, 144, 255),
    "Fire Brick":     (178, 34, 34),
    "Medium Aqua":    (102, 205, 170),
    "Royal Blue":     (65, 105, 225),
    "Dark Salmon":    (233, 150, 122),
    "Pale Violet":    (219, 112, 147),
    "Dark Cyan":      (0, 180, 180),
    "Bright Orange":  (255, 176, 56),
    "Mint":           (162, 255, 204),
    "Rose":           (255, 102, 153),
}

DEFAULT_COLORS = list(IF_COLORS.keys())

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


THEME = {
    "BG":           "#0a0b10",
    "BG2":          "#111318",
    "BG3":          "#16181f",
    "BG4":          "#1c1e26",

    "FG":           "#e5e5ea",
    "FG2":          "#8e8e93",
    "DIM":          "#48494e",

    "ACCENT":       "#0a84ff",
    "GREEN":        "#30d158",
    "RED":          "#ff453a",
    "ORANGE":       "#ff9f0a",
    "YELLOW":       "#ffd60a",
    "TEAL":         "#64d2ff",
    "PURPLE":       "#bf5af2",
    "PINK":         "#ff375f",

    "BORDER":       "#2c2e36",
    "SEPARATOR":    "#1e2028",

    "CHART_BG":     "#0e1017",
    "CHART_GRID":   "#1a1c24",
    "CHART_TEXT":   "#8e8e93",
}

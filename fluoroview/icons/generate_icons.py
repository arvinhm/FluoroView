"""Premium Glassmorphism Icon Generator for FluoroView.

Uses Pillow to render high-quality, 3D-like glass icons with:
- Drop shadows
- Semi-transparent frosted glass plates
- Inner light reflections (top/left white edge)
- Glowing neon symbols
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import math

ICON_DIR = Path(__file__).parent
SIZE = 48  # slightly larger for higher quality
PLATE_RADIUS = 12

def create_shadow(size, radius, offset_y=2):
    img = Image.new("RGBA", (size, size), (0,0,0,0))
    d = ImageDraw.Draw(img)
    pad = 4
    d.rounded_rectangle([(pad, pad+offset_y), (size-pad, size-pad+offset_y)], 
                        radius=radius, fill=(0,0,0, 100))
    return img.filter(ImageFilter.GaussianBlur(3))

def create_glass_plate(size, radius):
    img = Image.new("RGBA", (size, size), (0,0,0,0))
    d = ImageDraw.Draw(img)
    pad = 4
    # Frosted background (dark translucent with a hint of blue/cyan)
    d.rounded_rectangle([(pad, pad), (size-pad, size-pad)], 
                        radius=radius, fill=(30, 35, 45, 200)) # Dark glass
    
    # Gradient overlay (top-left to bottom-right)
    overlay = Image.new("RGBA", (size, size), (0,0,0,0))
    od = ImageDraw.Draw(overlay)
    for y in range(pad, size-pad):
        for x in range(pad, size-pad):
            # Distance from top-left
            dist = math.hypot(x - pad, y - pad)
            max_dist = math.hypot(size-2*pad, size-2*pad)
            # White highlight at top left, fading out
            alpha = int(60 * (1 - dist/max_dist))
            od.point((x, y), fill=(255, 255, 255, max(0, alpha)))
    
    # Mask overlay to the rounded rectangle
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([(pad, pad), (size-pad, size-pad)], radius=radius, fill=255)
    img.paste(overlay, mask=mask)
    
    # Inner border (Top and Left light reflection)
    d.rounded_rectangle([(pad, pad), (size-pad, size-pad)], 
                        radius=radius, outline=(255, 255, 255, 60), width=1)
    # Bottom and Right dark reflection
    d.rounded_rectangle([(pad+1, pad+1), (size-pad, size-pad)], 
                        radius=radius, outline=(0, 0, 0, 80), width=1)
    return img

def create_glowing_symbol(size, draw_func, color):
    # Draw symbol
    base = Image.new("RGBA", (size, size), (0,0,0,0))
    d = ImageDraw.Draw(base)
    draw_func(d, color)
    
    # Create glow
    glow = base.copy().filter(ImageFilter.GaussianBlur(2))
    
    # Combine (glow + base)
    comp = Image.alpha_composite(Image.new("RGBA", (size, size)), glow)
    comp = Image.alpha_composite(comp, base)
    return comp

def build_icon(name, draw_func, symbol_color):
    """Assembles shadow, glass plate, and glowing symbol."""
    bg = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
    
    shadow = create_shadow(SIZE, PLATE_RADIUS)
    bg = Image.alpha_composite(bg, shadow)
    
    plate = create_glass_plate(SIZE, PLATE_RADIUS)
    bg = Image.alpha_composite(bg, plate)
    
    symbol = create_glowing_symbol(SIZE, draw_func, symbol_color)
    bg = Image.alpha_composite(bg, symbol)
    
    # Save
    ICON_DIR.mkdir(exist_ok=True)
    bg.save(ICON_DIR / f"{name}.png")
    print(f"Generated {name}.png")

# --- Symbol Drawing Functions ---
# Padding inside plate is ~10px. Center is 24, usable area is 14 to 34.
C = 24
S = 8 # half-size of symbol

def draw_fit(d, col):
    """Four arrows pointing out."""
    w = 1.5
    # TL
    d.line([(C-S, C-S), (C-S+4, C-S)], fill=col, width=int(w))
    d.line([(C-S, C-S), (C-S, C-S+4)], fill=col, width=int(w))
    d.line([(C-S, C-S), (C-S+3, C-S+3)], fill=col, width=int(w))
    # TR
    d.line([(C+S, C-S), (C+S-4, C-S)], fill=col, width=int(w))
    d.line([(C+S, C-S), (C+S, C-S+4)], fill=col, width=int(w))
    d.line([(C+S, C-S), (C+S-3, C-S+3)], fill=col, width=int(w))
    # BL
    d.line([(C-S, C+S), (C-S+4, C+S)], fill=col, width=int(w))
    d.line([(C-S, C+S), (C-S, C+S-4)], fill=col, width=int(w))
    d.line([(C-S, C+S), (C-S+3, C+S-3)], fill=col, width=int(w))
    # BR
    d.line([(C+S, C+S), (C+S-4, C+S)], fill=col, width=int(w))
    d.line([(C+S, C+S), (C+S, C+S-4)], fill=col, width=int(w))
    d.line([(C+S, C+S), (C+S-3, C+S-3)], fill=col, width=int(w))

def draw_clear(d, col):
    """X mark."""
    d.line([(C-S+2, C-S+2), (C+S-2, C+S-2)], fill=col, width=2)
    d.line([(C+S-2, C-S+2), (C-S+2, C+S-2)], fill=col, width=2)

def draw_eye(d, col):
    """Eye."""
    d.arc([(C-S, C-4), (C+S, C+4)], 0, 180, fill=col, width=2)
    d.arc([(C-S, C-4), (C+S, C+4)], 180, 360, fill=col, width=2)
    d.ellipse([(C-2, C-2), (C+2, C+2)], fill=col)

def draw_brush(d, col):
    """Brush."""
    d.line([(C-S+2, C+S-2), (C+S-3, C-S+3)], fill=col, width=3)
    d.ellipse([(C-S-1, C+S-4), (C-S+4, C+S+1)], fill=col)

def draw_save(d, col):
    """Floppy."""
    d.rectangle([(C-S, C-S), (C+S, C+S)], outline=col, width=2)
    d.rectangle([(C-4, C-S), (C+4, C-S+3)], fill=(200,200,200,200))
    d.rectangle([(C-3, C+S-4), (C+3, C+S)], fill=col)

def draw_roi(d, col):
    """Rectangle with arrow."""
    d.rectangle([(C-S, C-S+2), (C+S-2, C+S)], outline=(200,200,200,200), width=1)
    # arrow out TR
    d.line([(C+S-2, C-S), (C+S-4, C-S)], fill=col, width=2)
    d.line([(C+S-2, C-S), (C+S-2, C-S+2)], fill=col, width=2)
    d.line([(C+S-4, C-S+2), (C+S-2, C-S)], fill=col, width=2)

def draw_csv(d, col):
    """Grid."""
    d.rectangle([(C-S, C-S), (C+S, C+S)], outline=col, width=1)
    d.line([(C-S, C), (C+S, C)], fill=col, width=1)
    d.line([(C, C-S), (C, C+S)], fill=col, width=1)

def draw_segment(d, col):
    """Two overlapping circles."""
    d.ellipse([(C-S-1, C-S+1), (C+1, C+S-1)], outline=(200,200,200,200), width=2)
    d.ellipse([(C-1, C-S+1), (C+S+1, C+S-1)], outline=col, width=2)

def draw_cells(d, col):
    """Scatter dots."""
    import random
    random.seed(42)
    for _ in range(8):
        x = C + random.randint(-S+2, S-2)
        y = C + random.randint(-S+2, S-2)
        d.ellipse([(x-1, y-1), (x+1, y+1)], fill=col)

def draw_group(d, col):
    """Tag."""
    pts = [(C-S, C-S+3), (C-S, C+S-3), (C+S-3, C+S-3), (C+S+1, C), (C+S-3, C-S+3)]
    d.polygon(pts, outline=col, width=1)
    d.ellipse([(C+S-3, C-1), (C+S-1, C+1)], fill=col)

def draw_plot(d, col):
    """Bar chart."""
    d.line([(C-S, C-S), (C-S, C+S)], fill=(200,200,200,200), width=2)
    d.line([(C-S, C+S), (C+S, C+S)], fill=(200,200,200,200), width=2)
    d.rectangle([(C-S+2, C+1), (C-S+4, C+S-1)], fill=col)
    d.rectangle([(C-S+6, C-2), (C-S+8, C+S-1)], fill=(48, 209, 88, 255))
    d.rectangle([(C-S+10, C-S+2), (C-S+12, C+S-1)], fill=(10, 132, 255, 255))

def draw_ai(d, col):
    """Brain/nodes."""
    d.ellipse([(C-S+2, C-S+2), (C+S-2, C+S-2)], outline=col, width=1)
    d.ellipse([(C-1, C-1), (C+1, C+1)], fill=col)
    d.ellipse([(C-S+2, C-2), (C-S+4, C)], fill=col)
    d.ellipse([(C+S-4, C), (C+S-2, C+2)], fill=col)
    d.line([(C-S+3, C-1), (C, C)], fill=col, width=1)
    d.line([(C, C), (C+S-3, C+1)], fill=col, width=1)

def draw_rect(d, col):
    d.rectangle([(C-S+2, C-S+4), (C+S-2, C+S-4)], outline=col, width=2)

def draw_circle(d, col):
    d.ellipse([(C-S+1, C-S+1), (C+S-1, C+S-1)], outline=col, width=2)

def draw_free(d, col):
    pts = [(C-S, C), (C-S+4, C-S+2), (C, C+S-2), (C+S-4, C-S+2), (C+S, C)]
    d.line(pts, fill=col, width=2, joint="curve")


if __name__ == "__main__":
    CYAN = (10, 132, 255, 255)
    GREEN = (48, 209, 88, 255)
    RED = (255, 69, 58, 255)
    WHITE = (240, 240, 245, 255)
    PURPLE = (191, 90, 242, 255)
    ORANGE = (255, 159, 10, 255)
    
    build_icon("fit", draw_fit, CYAN)
    build_icon("clear", draw_clear, RED)
    build_icon("eye", draw_eye, GREEN)
    build_icon("brush", draw_brush, PURPLE)
    build_icon("save", draw_save, CYAN)
    build_icon("roi", draw_roi, ORANGE)
    build_icon("csv", draw_csv, WHITE)
    build_icon("segment", draw_segment, CYAN)
    build_icon("cells", draw_cells, GREEN)
    build_icon("group", draw_group, PURPLE)
    build_icon("plot", draw_plot, CYAN)
    build_icon("ai", draw_ai, ORANGE)
    build_icon("rect", draw_rect, WHITE)
    build_icon("circle", draw_circle, WHITE)
    build_icon("free", draw_free, WHITE)

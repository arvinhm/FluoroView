"""Custom Canvas-based glass-effect widgets for FluoroView.

Provides premium frosted-glass UI elements using tkinter Canvas drawing:
rounded rectangles, gradient fills, glow borders, animated hover states.
All widgets are pure tkinter — no external dependencies.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from fluoroview.constants import THEME, FONTS, RADIUS


# ══════════════════════════════════════════════════════════════════════
#  UTILITY: Rounded rectangle on any Canvas
# ══════════════════════════════════════════════════════════════════════

def rounded_rect(canvas: tk.Canvas, x1, y1, x2, y2, r=10, **kwargs):
    """Draw a rounded rectangle.  Returns item id."""
    points = [
        x1 + r, y1,
        x2 - r, y1,
        x2, y1, x2, y1 + r,
        x2, y2 - r,
        x2, y2, x2 - r, y2,
        x1 + r, y2,
        x1, y2, x1, y2 - r,
        x1, y1 + r,
        x1, y1, x1 + r, y1,
    ]
    return canvas.create_polygon(points, smooth=True, **kwargs)


def hex_lerp(c1: str, c2: str, t: float) -> str:
    """Linearly interpolate between two hex colors."""
    r1, g1, b1 = int(c1[1:3], 16), int(c1[3:5], 16), int(c1[5:7], 16)
    r2, g2, b2 = int(c2[1:3], 16), int(c2[3:5], 16), int(c2[5:7], 16)
    r = int(r1 + (r2 - r1) * t)
    g = int(g1 + (g2 - g1) * t)
    b = int(b1 + (b2 - b1) * t)
    return f"#{r:02x}{g:02x}{b:02x}"


# ══════════════════════════════════════════════════════════════════════
#  GLASS PANEL — frosted container with glow border
# ══════════════════════════════════════════════════════════════════════

class GlassPanel(tk.Canvas):
    """A frosted-glass panel with rounded corners and subtle glow border.

    Use as a container: pack child widgets into ``self.interior``.
    """

    def __init__(self, parent, bg_color=None, border_color=None,
                 radius=RADIUS, pad=8, **kwargs):
        self._bg_color = bg_color or THEME["BG_GLASS"]
        self._border_color = border_color or THEME["BORDER"]
        self._radius = radius
        self._pad = pad
        super().__init__(parent, highlightthickness=0,
                         bg=THEME["BG"], **kwargs)
        self.interior = tk.Frame(self, bg=self._bg_color)
        self._win = self.create_window(pad, pad, window=self.interior,
                                       anchor="nw")
        self.bind("<Configure>", self._redraw)

    def _redraw(self, _event=None):
        self.delete("bg")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 4 or h < 4:
            return
        # Outer glow border
        rounded_rect(self, 0, 0, w - 1, h - 1, r=self._radius,
                      fill=self._bg_color, outline=self._border_color,
                      width=1, tags="bg")
        self.tag_lower("bg")
        self.itemconfig(self._win, width=w - self._pad * 2)


# ══════════════════════════════════════════════════════════════════════
#  GLASS CARD — elevated card with hover lift effect
# ══════════════════════════════════════════════════════════════════════

class GlassCard(tk.Canvas):
    """Card with subtle glass styling and hover highlight."""

    def __init__(self, parent, height=60, radius=8, **kwargs):
        self._radius = radius
        self._normal_bg = THEME["BG3"]
        self._hover_bg = THEME["HOVER_BG"]
        self._border = THEME["BORDER"]
        self._hover_border = THEME["GLASS_EDGE"]
        self._hovering = False
        super().__init__(parent, highlightthickness=0, height=height,
                         bg=THEME["BG"], **kwargs)
        self.interior = tk.Frame(self, bg=self._normal_bg)
        self._win = self.create_window(4, 4, window=self.interior, anchor="nw")
        self.bind("<Configure>", self._redraw)
        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)

    def _redraw(self, _event=None):
        self.delete("bg")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 4 or h < 4:
            return
        bg = self._hover_bg if self._hovering else self._normal_bg
        bd = self._hover_border if self._hovering else self._border
        rounded_rect(self, 1, 1, w - 2, h - 2, r=self._radius,
                      fill=bg, outline=bd, width=1, tags="bg")
        self.tag_lower("bg")
        self.itemconfig(self._win, width=max(1, w - 8))

    def _on_enter(self, _e):
        self._hovering = True
        self._redraw()

    def _on_leave(self, _e):
        self._hovering = False
        self._redraw()


# ══════════════════════════════════════════════════════════════════════
#  GLASS BUTTON — rounded button with glow hover
# ══════════════════════════════════════════════════════════════════════

class GlassButton(tk.Canvas):
    """Premium rounded button with hover glow effect."""

    def __init__(self, parent, text="", icon="", command=None,
                 accent=False, width=None, height=32, **kwargs):
        self._text = f"{icon} {text}".strip() if icon else text
        self._command = command
        self._accent = accent
        self._hovering = False
        self._pressing = False

        # Colors
        if accent:
            self._bg = "#0e3a4a"
            self._hover = "#154558"
            self._press = "#0a2e3c"
            self._fg = THEME["ACCENT"]
            self._border = "#1a5c72"
        else:
            self._bg = THEME["BG3"]
            self._hover = THEME["BG4"]
            self._press = THEME["BG3"]
            self._fg = THEME["FG"]
            self._border = THEME["BORDER"]

        super().__init__(parent, highlightthickness=0, height=height,
                         bg=THEME["BG"], cursor="hand2", **kwargs)
        if width:
            self.configure(width=width)

        self.bind("<Configure>", self._redraw)
        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)
        self.bind("<ButtonPress-1>", self._on_press)
        self.bind("<ButtonRelease-1>", self._on_release)

    def _redraw(self, _event=None):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 4 or h < 4:
            return
        if self._pressing:
            bg = self._press
        elif self._hovering:
            bg = self._hover
        else:
            bg = self._bg
        bd = THEME["GLASS_EDGE"] if self._hovering else self._border
        rounded_rect(self, 1, 1, w - 2, h - 2, r=6,
                      fill=bg, outline=bd, width=1)
        fg = "#00eeff" if self._accent and self._hovering else self._fg
        self.create_text(w // 2, h // 2, text=self._text,
                         fill=fg, font=FONTS["BODY_SMALL"])

    def _on_enter(self, _e):
        self._hovering = True; self._redraw()

    def _on_leave(self, _e):
        self._hovering = False; self._pressing = False; self._redraw()

    def _on_press(self, _e):
        self._pressing = True; self._redraw()

    def _on_release(self, _e):
        self._pressing = False; self._redraw()
        if self._command and self._hovering:
            self._command()


# ══════════════════════════════════════════════════════════════════════
#  GLASS ICON BUTTON — circular toolbar button
# ══════════════════════════════════════════════════════════════════════

class GlassIconButton(tk.Canvas):
    """Circular icon button with glow-on-hover for toolbars."""

    def __init__(self, parent, icon="", command=None, size=34,
                 accent=False, tooltip_text="", **kwargs):
        self._icon = icon
        self._command = command
        self._accent = accent
        self._hovering = False
        super().__init__(parent, width=size, height=size,
                         highlightthickness=0, bg=THEME["BG"],
                         cursor="hand2", **kwargs)
        self.bind("<Configure>", self._redraw)
        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)
        self.bind("<ButtonRelease-1>", self._on_click)
        self._redraw()

    def _redraw(self, _e=None):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        cx, cy = w // 2, h // 2
        r = min(w, h) // 2 - 2
        if self._hovering:
            # Glow ring
            self.create_oval(cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2,
                             fill="", outline=THEME["ACCENT"], width=1)
            bg = THEME["BG4"] if not self._accent else "#154558"
            fg = THEME["ACCENT"]
        else:
            bg = THEME["BG2"] if not self._accent else "#0e3a4a"
            fg = THEME["FG2"] if not self._accent else THEME["ACCENT"]
        self.create_oval(cx - r, cy - r, cx + r, cy + r,
                         fill=bg, outline=THEME["BORDER"], width=1)
        self.create_text(cx, cy, text=self._icon, fill=fg,
                         font=FONTS["TOOLBAR"])

    def _on_enter(self, _e):
        self._hovering = True; self._redraw()

    def _on_leave(self, _e):
        self._hovering = False; self._redraw()

    def _on_click(self, _e):
        if self._command and self._hovering:
            self._command()


# ══════════════════════════════════════════════════════════════════════
#  GLASS SEPARATOR — gradient fade line
# ══════════════════════════════════════════════════════════════════════

class GlassSeparator(tk.Canvas):
    """Horizontal separator with gradient fade on edges."""

    def __init__(self, parent, height=1, **kwargs):
        super().__init__(parent, height=height, highlightthickness=0,
                         bg=THEME["BG"], **kwargs)
        self.bind("<Configure>", self._redraw)

    def _redraw(self, _e=None):
        self.delete("all")
        w = self.winfo_width()
        if w < 10:
            return
        # Center bright, edges dark
        mid = THEME["GLASS_EDGE"]
        edge = THEME["BG"]
        steps = 20
        seg_w = w // (steps * 2)
        for i in range(steps):
            t = i / steps
            c = hex_lerp(edge, mid, t)
            x1 = i * seg_w
            x2 = x1 + seg_w
            self.create_line(x1, 0, x2, 0, fill=c, width=1)
            # Mirror
            x1m = w - x1 - seg_w
            x2m = x1m + seg_w
            self.create_line(x1m, 0, x2m, 0, fill=c, width=1)
        # Center fill
        self.create_line(steps * seg_w, 0, w - steps * seg_w, 0,
                         fill=mid, width=1)


# ══════════════════════════════════════════════════════════════════════
#  STATUS BAR — gradient strip with glow indicator
# ══════════════════════════════════════════════════════════════════════

class GlassStatusBar(tk.Canvas):
    """Premium status bar with gradient background and status indicator dot."""

    def __init__(self, parent, textvariable=None, **kwargs):
        self._textvar = textvariable
        super().__init__(parent, height=30, highlightthickness=0,
                         bg=THEME["BG2"], **kwargs)
        self.bind("<Configure>", self._redraw)
        if textvariable:
            textvariable.trace_add("write", lambda *_: self._redraw())
        self._redraw()

    def _redraw(self, _e=None):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 10:
            return
        # Gradient background (BG to BG2)
        steps = 8
        sh = max(1, h // steps)
        for i in range(steps):
            c = hex_lerp(THEME["BG"], THEME["BG2"], i / steps)
            self.create_rectangle(0, i * sh, w, (i + 1) * sh,
                                  fill=c, outline="")
        # Top border line
        self.create_line(0, 0, w, 0, fill=THEME["BORDER"], width=1)
        # Status dot
        text = self._textvar.get() if self._textvar else ""
        dot_color = THEME["EMERALD"] if "✓" in text or "Ready" in text else \
                    THEME["AMBER"] if "⏳" in text else \
                    THEME["CORAL"] if "✗" in text or "❌" in text else \
                    THEME["ACCENT"]
        self.create_oval(10, h // 2 - 3, 16, h // 2 + 3,
                         fill=dot_color, outline="")
        # Text
        self.create_text(24, h // 2, text=text, fill=THEME["FG2"],
                         font=FONTS["BODY_SMALL"], anchor="w")


# ══════════════════════════════════════════════════════════════════════
#  TOOLBAR GROUP — pill-shaped container for toolbar buttons
# ══════════════════════════════════════════════════════════════════════

class ToolbarGroup(tk.Frame):
    """Groups toolbar buttons in a frosted pill-shaped container."""

    def __init__(self, parent, **kwargs):
        super().__init__(parent, bg=THEME["BG2"],
                         highlightthickness=1,
                         highlightbackground=THEME["BORDER"],
                         padx=3, pady=2, **kwargs)


# ══════════════════════════════════════════════════════════════════════
#  SECTION HEADER — gradient underline header
# ══════════════════════════════════════════════════════════════════════

class SectionHeader(tk.Canvas):
    """Section header with icon, text, and gradient underline."""

    def __init__(self, parent, text="", icon="", **kwargs):
        self._text = f"{icon}  {text}" if icon else text
        super().__init__(parent, height=28, highlightthickness=0,
                         bg=THEME["BG"], **kwargs)
        self.bind("<Configure>", self._redraw)

    def _redraw(self, _e=None):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 10:
            return
        # Text
        self.create_text(8, h // 2 - 2, text=self._text,
                         fill=THEME["ACCENT"], font=FONTS["HEADING"],
                         anchor="w")
        # Gradient underline
        line_y = h - 2
        grad_w = min(w - 16, 120)
        steps = 15
        sw = max(1, grad_w // steps)
        for i in range(steps):
            t = 1 - i / steps
            c = hex_lerp(THEME["BG"], THEME["ACCENT"], t * 0.6)
            self.create_line(8 + i * sw, line_y, 8 + (i + 1) * sw, line_y,
                             fill=c, width=2)

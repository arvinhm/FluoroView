"""Apple iOS–inspired theme — applies CustomTkinter dark mode + custom JSON theme.

Call ``apply_dark_theme(root)`` once at startup.
"""

from __future__ import annotations

import os
import customtkinter as ctk


def apply_dark_theme(root):
    """Configure CustomTkinter for premium iOS-dark appearance."""
    ctk.set_appearance_mode("dark")
    theme_path = os.path.join(os.path.dirname(__file__), "ios_theme.json")
    ctk.set_default_color_theme(theme_path)

"""Premium tooltip using CustomTkinter's CTkToplevel."""

from __future__ import annotations

import tkinter as tk
import customtkinter as ctk

from fluoroview.constants import THEME


class ToolTip:
    """Attach a modern tooltip to any tkinter or CTk widget."""

    def __init__(self, widget, text: str, delay: int = 350):
        self.widget = widget
        self.text = text
        self.delay = delay
        self._tip_window = None
        self._after_id = None
        widget.bind("<Enter>", self._on_enter, add="+")
        widget.bind("<Leave>", self._on_leave, add="+")

    def _on_enter(self, _event):
        self._after_id = self.widget.after(self.delay, self._show)

    def _on_leave(self, _event):
        if self._after_id:
            self.widget.after_cancel(self._after_id)
            self._after_id = None
        self._hide()

    def _show(self):
        if self._tip_window:
            return
        T = THEME
        x = self.widget.winfo_rootx() + self.widget.winfo_width() // 2
        y = self.widget.winfo_rooty() + self.widget.winfo_height() + 6
        tw = tk.Toplevel(self.widget)
        tw.wm_overrideredirect(True)
        tw.wm_geometry(f"+{x}+{y}")
        tw.configure(bg=T["BG3"])
        lbl = tk.Label(
            tw, text=self.text, justify="left",
            bg=T["BG3"], fg="#e5e5ea",
            font=("SF Pro Display", 11),
            padx=10, pady=5,
            highlightbackground="#0a84ff", highlightthickness=1,
        )
        lbl.pack()
        self._tip_window = tw

    def _hide(self):
        if self._tip_window:
            self._tip_window.destroy()
            self._tip_window = None

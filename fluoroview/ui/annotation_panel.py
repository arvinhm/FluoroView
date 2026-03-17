
from __future__ import annotations

import tkinter as tk
from tkinter import simpledialog, messagebox

import customtkinter as ctk

from fluoroview.core.annotations import (
    Annotation, Reply, get_display_name, set_display_name,
)
from fluoroview.constants import THEME
from fluoroview.ui.tooltip import ToolTip


class AnnotationPanel(ctk.CTkFrame):

    def __init__(self, parent, app):
        super().__init__(parent, fg_color="transparent")
        self.app = app

        hdr = ctk.CTkFrame(self, fg_color="transparent")
        hdr.pack(fill="x", padx=4, pady=(4, 0))
        ctk.CTkLabel(hdr, text="\U0001F4CC Annotations",
                     font=ctk.CTkFont(size=14, weight="bold"),
                     text_color="#0a84ff").pack(side="left")
        nb = ctk.CTkButton(hdr, text="Name", width=50, height=26,
                           fg_color="#2c2e36", hover_color="#3a3c44",
                           command=self._change_display_name)
        nb.pack(side="right", padx=1)
        ToolTip(nb, "Change your display name")

        btn_fr = ctk.CTkFrame(self, fg_color="transparent")
        btn_fr.pack(fill="x", padx=4, pady=3)
        for txt, cmd, tip in [
            ("\U0001F4CC Pin", self._enter_pin_mode, "Place a note on the image"),
            ("\u270F Edit", self._edit_selected, "Edit selected note"),
            ("\U0001F4AC Reply", self._reply_to_selected, "Reply to selected note"),
            ("\u2715 Del", self._delete_selected, "Delete selected note"),
        ]:
            b = ctk.CTkButton(btn_fr, text=txt, width=55, height=28,
                              fg_color="#2c2e36", hover_color="#3a3c44",
                              font=ctk.CTkFont(size=10), command=cmd)
            b.pack(side="left", padx=1)
            ToolTip(b, tip)
        vb = ctk.CTkButton(btn_fr, text="\U0001F441", width=32, height=28,
                           fg_color="#2c2e36", hover_color="#3a3c44",
                           command=self._toggle_visibility)
        vb.pack(side="right", padx=1)
        ToolTip(vb, "Show / hide annotations")

        self.listbox = tk.Listbox(
            self, font=("SF Mono", 9), height=8,
            bg="#16181f", fg="#e5e5ea",
            selectbackground="#0a84ff", selectforeground="#ffffff",
            relief="flat", bd=0, highlightthickness=0,
            activestyle="none")
        self.listbox.pack(fill="both", expand=True, padx=4, pady=2)
        self.listbox.bind("<<ListboxSelect>>", self._on_select)
        self.listbox.bind("<Double-Button-1>", lambda e: self._show_thread())

        self.detail_label = ctk.CTkLabel(self, text="", wraplength=270,
                                         font=ctk.CTkFont(size=10),
                                         text_color="#8e8e93")
        self.detail_label.pack(fill="x", padx=4, pady=(0, 4))

        self.show_annotations = True


    def refresh(self):
        self.listbox.delete(0, "end")
        for a in self.app.annotations:
            lock = "" if a.owned_by_current_machine() else "\U0001F512"
            n_replies = len(a.replies)
            reply_tag = f" ({n_replies})" if n_replies else ""
            line = f"{lock}[{a.author}] {a.text[:22]}{reply_tag}"
            self.listbox.insert("end", line)
        self.detail_label.configure(text="")

    def add_annotation_at(self, x: float, y: float,
                          linked_roi: str | None = None):
        text = simpledialog.askstring("New Note", "Enter note text:",
                                      parent=self.app)
        if not text:
            return
        ann = Annotation(text=text, x=x, y=y, linked_roi=linked_roi)
        self.app.annotations.append(ann)
        self.refresh()
        self.app._schedule_update()


    def _selected_ann(self) -> Annotation | None:
        sel = self.listbox.curselection()
        if not sel:
            return None
        return self.app.annotations[sel[0]]

    def _change_display_name(self):
        current = get_display_name()
        new = simpledialog.askstring(
            "Your Display Name",
            "Enter your name (shown on annotation pins):",
            initialvalue=current, parent=self.app)
        if new and new.strip():
            new_name = new.strip()
            set_display_name(new_name)
            for ann in self.app.annotations:
                if ann.owned_by_current_machine():
                    ann.author = new_name
                for rep in ann.replies:
                    if rep.owned_by_current_machine():
                        rep.author = new_name
            self.refresh()
            self.app._schedule_update()
            self.app.status_var.set(f"Name set to '{new_name}'")

    def _enter_pin_mode(self):
        self.app.annotation_pin_mode = True
        self.app.canvas.config(cursor="plus")
        self.app.status_var.set("Click on the image to place a note")

    def _on_select(self, _event=None):
        ann = self._selected_ann()
        if not ann:
            return
        self.app._pan_to_annotation(ann)
        self._show_detail_for(ann)

    def _show_detail_for(self, ann: Annotation):
        own = "You" if ann.owned_by_current_machine() else "\U0001F512 Locked"
        lines = [f"{ann.author}  \u2022  {ann.pretty_time()}  \u2022  {own}",
                 ann.text]
        for r in ann.replies:
            lines.append(f"  \u21B3 {r.author} ({r.pretty_time()}): {r.text}")
        self.detail_label.configure(text="\n".join(lines))

    def _show_thread(self):
        ann = self._selected_ann()
        if not ann:
            return
        self._open_thread_window(ann)

    def _reply_to_selected(self):
        ann = self._selected_ann()
        if not ann:
            messagebox.showinfo("Select a note", "Select a note to reply to.",
                                parent=self.app)
            return
        self._open_thread_window(ann, focus_reply=True)

    def _open_thread_window(self, ann: Annotation, focus_reply: bool = False):
        win = ctk.CTkToplevel(self.app)
        win.title(f"Thread \u2014 {ann.author}")
        win.geometry("440x500")
        win.transient(self.app)

        hdr_fr = ctk.CTkFrame(win, corner_radius=0, fg_color="#111318")
        hdr_fr.pack(fill="x")
        ctk.CTkLabel(hdr_fr,
                     text=f"\U0001F4CC  {ann.author}  \u2022  {ann.pretty_time()}",
                     font=ctk.CTkFont(size=14, weight="bold"),
                     text_color="#0a84ff").pack(anchor="w", padx=12, pady=(10, 2))
        ctk.CTkLabel(hdr_fr, text=ann.text, wraplength=400,
                     font=ctk.CTkFont(size=12),
                     text_color="#e5e5ea").pack(anchor="w", padx=12, pady=(0, 8))

        replies_scroll = ctk.CTkScrollableFrame(win, fg_color="transparent")
        replies_scroll.pack(fill="both", expand=True, padx=8, pady=4)

        def _populate_replies():
            for w in replies_scroll.winfo_children():
                w.destroy()
            if not ann.replies:
                ctk.CTkLabel(replies_scroll, text="No replies yet",
                             text_color="#48494e").pack(pady=10)
            for i, rep in enumerate(ann.replies):
                rf = ctk.CTkFrame(replies_scroll, corner_radius=8,
                                  fg_color="#16181f", border_width=1,
                                  border_color="#2c2e36")
                rf.pack(fill="x", pady=3)
                own_icon = "" if rep.owned_by_current_machine() else "\U0001F512 "
                ctk.CTkLabel(rf,
                             text=f"{own_icon}{rep.author}  \u2022  {rep.pretty_time()}",
                             font=ctk.CTkFont(size=10),
                             text_color="#0a84ff").pack(anchor="w", padx=10, pady=(6, 0))
                ctk.CTkLabel(rf, text=rep.text, wraplength=360,
                             font=ctk.CTkFont(size=11),
                             text_color="#e5e5ea").pack(anchor="w", padx=10, pady=(2, 6))
                if rep.owned_by_current_machine():
                    btn_row = ctk.CTkFrame(rf, fg_color="transparent")
                    btn_row.pack(anchor="e", padx=8, pady=(0, 4))
                    ctk.CTkButton(btn_row, text="\u270F", width=28, height=24,
                                  fg_color="#2c2e36", hover_color="#3a3c44",
                                  command=lambda idx=i: _edit_reply(idx)).pack(
                        side="left", padx=1)
                    ctk.CTkButton(btn_row, text="\u2715", width=28, height=24,
                                  fg_color="#2c2e36", hover_color="#ff453a",
                                  command=lambda idx=i: _del_reply(idx)).pack(
                        side="left", padx=1)

        def _edit_reply(idx):
            rep = ann.replies[idx]
            new_text = simpledialog.askstring("Edit Reply", "Update reply:",
                                              initialvalue=rep.text, parent=win)
            if new_text is not None:
                rep.text = new_text
                _populate_replies()
                self.refresh()

        def _del_reply(idx):
            if messagebox.askyesno("Delete Reply", "Delete this reply?", parent=win):
                ann.replies.pop(idx)
                _populate_replies()
                self.refresh()

        _populate_replies()

        input_fr = ctk.CTkFrame(win, fg_color="transparent")
        input_fr.pack(fill="x", padx=10, pady=8)
        reply_entry = ctk.CTkEntry(input_fr, placeholder_text="Type a reply…",
                                   font=ctk.CTkFont(size=12))
        reply_entry.pack(side="left", fill="x", expand=True, padx=(0, 4))

        def _send_reply():
            text = reply_entry.get().strip()
            if not text:
                return
            ann.replies.append(Reply(text=text))
            reply_entry.delete(0, "end")
            _populate_replies()
            self.refresh()
            self.app._schedule_update()

        ctk.CTkButton(input_fr, text="\u27A4", width=40, height=32,
                      command=_send_reply).pack(side="right")
        reply_entry.bind("<Return>", lambda e: _send_reply())

        if focus_reply:
            reply_entry.focus_set()

    def _edit_selected(self):
        ann = self._selected_ann()
        if not ann:
            return
        if not ann.owned_by_current_machine():
            messagebox.showwarning(
                "Permission Denied",
                f"This note was created by '{ann.author}' on a different "
                f"machine.\n\nOnly the original machine can edit it.",
                parent=self.app)
            return
        new_text = simpledialog.askstring("Edit Note", "Update note:",
                                          initialvalue=ann.text, parent=self.app)
        if new_text is not None:
            ann.text = new_text
            self.refresh()
            self.app._schedule_update()

    def _delete_selected(self):
        ann = self._selected_ann()
        if not ann:
            return
        if not ann.owned_by_current_machine():
            messagebox.showwarning(
                "Permission Denied",
                f"This note was created by '{ann.author}' on a different "
                f"machine.\n\nOnly the original machine can delete it.",
                parent=self.app)
            return
        sel = self.listbox.curselection()
        if messagebox.askyesno("Delete Note",
                               f"Delete note by {ann.author}?\n\n\"{ann.text[:60]}\"",
                               parent=self.app):
            self.app.annotations.pop(sel[0])
            self.refresh()
            self.app._schedule_update()

    def _toggle_visibility(self):
        self.show_annotations = not self.show_annotations
        self.app._schedule_update()
        self.app.status_var.set(
            f"Annotations {'visible' if self.show_annotations else 'hidden'}")

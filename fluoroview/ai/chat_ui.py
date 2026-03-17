
from __future__ import annotations

import os
import re
import threading
import textwrap
import time

import tkinter as tk
import customtkinter as ctk

import json
from pathlib import Path

from fluoroview.constants import THEME
from fluoroview.ai.providers import PROVIDERS, list_models, chat
from fluoroview.ai.version_control import VersionControl

_AI_CONFIG_PATH = Path.home() / ".fluoroview_ai.json"
_CHAT_HISTORY_DIR = Path.home() / ".fluoroview_chats"


def _load_ai_config() -> dict:
    try:
        return json.loads(_AI_CONFIG_PATH.read_text())
    except Exception:
        return {}


def _save_ai_config(cfg: dict):
    try:
        _AI_CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    except Exception:
        pass


def _list_saved_chats() -> list[dict]:
    _CHAT_HISTORY_DIR.mkdir(exist_ok=True)
    chats = []
    for f in sorted(_CHAT_HISTORY_DIR.glob("*.json"), reverse=True):
        try:
            d = json.loads(f.read_text())
            d["_path"] = str(f)
            chats.append(d)
        except Exception:
            pass
    return chats


def _save_chat_session(title: str, messages: list[dict], provider: str, model: str):
    _CHAT_HISTORY_DIR.mkdir(exist_ok=True)
    ts = int(time.time())
    data = {"title": title, "timestamp": ts, "provider": provider,
            "model": model, "messages": messages}
    path = _CHAT_HISTORY_DIR / f"chat_{ts}.json"
    path.write_text(json.dumps(data, indent=2))


def _delete_chat_session(path: str):
    try:
        Path(path).unlink()
    except Exception:
        pass


_SYSTEM_PROMPT_TEMPLATE = textwrap.dedent("""\
    You are the built-in AI assistant for **FluoroView v2**, a Python/tkinter
    desktop application for multiplexed fluorescence microscopy image analysis.

    The full source tree of the application is shown below.  When the user asks
    you to add a feature or fix something, produce the exact file edits in
    fenced code blocks using this format:

    ```python:relative/path/to/file.py
    <full new contents of the file>
    ```

    Rules:
    - Always output the COMPLETE file contents — never partial snippets.
    - You may edit multiple files in one response.
    - Explain what you changed and why BEFORE the code blocks.
    - If the user just asks a question (no code change needed), answer normally.
    - Preserve existing functionality unless the user explicitly asks to remove it.
    - Follow the existing code style (dark-theme tkinter, numpy-based).

    === SOURCE TREE ===
    {source_tree}
""")


class AIChatPanel(ctk.CTkFrame):

    def __init__(self, parent, app):
        super().__init__(parent, fg_color="transparent")
        self.app = app

        self.vc = VersionControl()
        self.provider: str | None = None
        self.api_key: str | None = None
        self.model: str | None = None
        self.messages: list[dict] = []
        self._system_prompt: str = ""
        self._pending_edits: list[tuple[str, str]] = []
        self._fetching = False
        self._chat_ready = False
        self._history_visible = False

        saved = _load_ai_config()
        if saved.get("api_key") and saved.get("model") and saved.get("provider"):
            self.provider = saved["provider"]
            self.api_key = saved["api_key"]
            self.model = saved["model"]
            self.messages = saved.get("chat_history", [])
            self._init_system_prompt()
            self._chat_ready = True

        self._build_ui()

    def _init_system_prompt(self):
        source_tree = self.vc.read_source_tree()
        tree_text = "".join(f"\n--- {r} ---\n{c}\n" for r, c in source_tree.items())
        self._system_prompt = _SYSTEM_PROMPT_TEMPLATE.format(source_tree=tree_text)


    def _build_ui(self):
        hdr = ctk.CTkFrame(self, fg_color="transparent")
        hdr.pack(fill="x", padx=6, pady=(4, 2))

        ctk.CTkLabel(hdr, text="AI Chat",
                     font=ctk.CTkFont(size=13, weight="bold"),
                     text_color="#0a84ff").pack(side="left")

        self._status_dot = ctk.CTkLabel(hdr, text="●", font=ctk.CTkFont(size=14))
        self._set_connection_status(self._chat_ready)
        self._status_dot.pack(side="left", padx=(4, 0))

        ctk.CTkButton(hdr, text="Settings", width=55, height=20,
                      font=ctk.CTkFont(size=9),
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._show_settings).pack(side="right", padx=1)
        ctk.CTkButton(hdr, text="History", width=50, height=20,
                      font=ctk.CTkFont(size=9),
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._toggle_history).pack(side="right", padx=1)

        self._history_frame = ctk.CTkScrollableFrame(self, fg_color="#111318",
                                                      corner_radius=6, height=120)

        if self._chat_ready:
            self._build_chat_view()
        else:
            self._build_setup_view()

    def _set_connection_status(self, ok: bool):
        if hasattr(self, "_status_dot"):
            self._status_dot.configure(text_color="#30d158" if ok else "#ff453a")

    def _build_setup_view(self):
        self._setup_frame = ctk.CTkFrame(self, fg_color="transparent")
        self._setup_frame.pack(fill="both", expand=True, padx=6, pady=2)

        ctk.CTkLabel(self._setup_frame, text="Connect with AI",
                     font=ctk.CTkFont(size=12, weight="bold"),
                     text_color="#e5e5ea").pack(anchor="w", pady=(4, 6))

        ctk.CTkLabel(self._setup_frame, text="Provider",
                     text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", pady=(2, 0))
        self._provider_var = tk.StringVar(value="Google Gemini")
        ctk.CTkComboBox(self._setup_frame, variable=self._provider_var,
                        values=list(PROVIDERS.keys()), width=200,
                        height=26, font=ctk.CTkFont(size=10)).pack(fill="x", pady=2)

        ctk.CTkLabel(self._setup_frame, text="API Key",
                     text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", pady=(2, 0))
        self._key_entry = ctk.CTkEntry(self._setup_frame, show="\u2022",
                                        placeholder_text="Paste your API key...",
                                        height=26, font=ctk.CTkFont(size=10))
        self._key_entry.pack(fill="x", pady=2)

        ctk.CTkLabel(self._setup_frame, text="Model",
                     text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", pady=(2, 0))
        self._model_var = tk.StringVar()
        self._model_combo = ctk.CTkComboBox(self._setup_frame,
                                             variable=self._model_var,
                                             values=[], width=200, height=26,
                                             font=ctk.CTkFont(size=10))
        self._model_combo.pack(fill="x", pady=2)
        self._model_status = ctk.CTkLabel(self._setup_frame,
                                           text="Enter key to load models",
                                           text_color="#48494e",
                                           font=ctk.CTkFont(size=9))
        self._model_status.pack(anchor="w")

        self._key_entry.bind("<KeyRelease>", self._on_key_change)
        self._provider_var.trace_add("write", lambda *_: self._trigger_auto_fetch())

        ctk.CTkButton(self._setup_frame, text="Connect",
                      height=28, font=ctk.CTkFont(size=11),
                      command=self._start_chat).pack(fill="x", pady=(8, 4))

    def _build_chat_view(self):
        self._chat_frame = ctk.CTkFrame(self, fg_color="transparent")
        self._chat_frame.pack(fill="both", expand=True, padx=2, pady=2)

        top = ctk.CTkFrame(self._chat_frame, fg_color="transparent")
        top.pack(fill="x", padx=4, pady=2)
        short = (self.model or "")
        if len(short) > 22:
            short = short[:20] + "..."
        self._model_label = ctk.CTkLabel(
            top, text=f"{self.provider or ''} / {short}",
            font=ctk.CTkFont(size=9), text_color="#8e8e93")
        self._model_label.pack(side="left")
        ctk.CTkButton(top, text="New", width=32, height=18,
                      font=ctk.CTkFont(size=9),
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=self._new_chat).pack(side="right", padx=1)
        ctk.CTkButton(top, text="Apply", width=38, height=18,
                      font=ctk.CTkFont(size=9),
                      fg_color="#2c2e36", hover_color="#30d158",
                      command=self._apply_pending_edits).pack(side="right", padx=1)

        self._messages_scroll = ctk.CTkScrollableFrame(
            self._chat_frame, fg_color="#0e1017", corner_radius=8)
        self._messages_scroll.pack(fill="both", expand=True, padx=4, pady=4)

        input_bar = ctk.CTkFrame(self._chat_frame, fg_color="transparent")
        input_bar.pack(fill="x", padx=4, pady=(0, 4))
        self._input_entry = ctk.CTkEntry(input_bar,
                                          placeholder_text="Ask AI...",
                                          height=30,
                                          font=ctk.CTkFont(size=10))
        self._input_entry.pack(side="left", fill="x", expand=True, padx=(0, 2))
        self._input_entry.bind("<Return>", self._on_enter)
        ctk.CTkButton(input_bar, text="Send", width=42, height=30,
                      font=ctk.CTkFont(size=10),
                      command=self._send_message).pack(side="right")

        self._restore_chat_display()
        n_files = len(self.vc.read_source_tree())
        self._add_system_bubble(f"Ready | {n_files} source files loaded")


    def _show_settings(self):
        win = ctk.CTkToplevel(self.app)
        win.title("AI Settings")
        win.geometry("380x380")
        win.transient(self.app)
        win.configure(fg_color="#0a0b10")

        ctk.CTkLabel(win, text="AI Settings",
                     font=ctk.CTkFont(size=14, weight="bold"),
                     text_color="#0a84ff").pack(pady=(12, 8))

        f = ctk.CTkFrame(win, fg_color="transparent")
        f.pack(fill="x", padx=16)

        ctk.CTkLabel(f, text="Provider", text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", pady=(4, 0))
        prov_var = tk.StringVar(value=self.provider or "Google Gemini")
        ctk.CTkComboBox(f, variable=prov_var,
                        values=list(PROVIDERS.keys()),
                        height=28).pack(fill="x", pady=2)

        ctk.CTkLabel(f, text="API Key", text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", pady=(4, 0))
        key_entry = ctk.CTkEntry(f, show="\u2022", height=28)
        key_entry.pack(fill="x", pady=2)
        if self.api_key:
            key_entry.insert(0, self.api_key)

        ctk.CTkLabel(f, text="Model", text_color="#8e8e93",
                     font=ctk.CTkFont(size=10)).pack(anchor="w", pady=(4, 0))
        model_var = tk.StringVar(value=self.model or "")
        model_combo = ctk.CTkComboBox(f, variable=model_var,
                                       values=[], height=28)
        model_combo.pack(fill="x", pady=2)
        status_lbl = ctk.CTkLabel(f, text="", text_color="#48494e",
                                   font=ctk.CTkFont(size=9))
        status_lbl.pack(anchor="w")

        def _fetch():
            key = key_entry.get().strip()
            prov = prov_var.get()
            if not key or len(key) < 5:
                return
            status_lbl.configure(text="Fetching models...")

            def _do():
                try:
                    models = list_models(prov, key)
                    win.after(0, lambda: _on_fetched(models))
                except Exception as e:
                    win.after(0, lambda: status_lbl.configure(
                        text=f"Error: {str(e)[:50]}"))
            threading.Thread(target=_do, daemon=True).start()

        def _on_fetched(models):
            model_combo.configure(values=models)
            default = PROVIDERS[prov_var.get()]["default_model"]
            if default in models:
                model_var.set(default)
            elif models:
                model_var.set(models[0])
            status_lbl.configure(text=f"{len(models)} models available")

        ctk.CTkButton(f, text="Fetch Models", height=26,
                      fg_color="#2c2e36", hover_color="#3a3c44",
                      command=_fetch).pack(fill="x", pady=(6, 2))

        def _save():
            self.provider = prov_var.get()
            self.api_key = key_entry.get().strip()
            self.model = model_var.get()
            if not self.api_key or not self.model:
                return
            _save_ai_config({"provider": self.provider, "api_key": self.api_key,
                             "model": self.model})
            self._init_system_prompt()
            if hasattr(self, '_model_label'):
                short = self.model if len(self.model) <= 22 else self.model[:20] + "..."
                self._model_label.configure(
                    text=f"{self.provider} / {short}")
            if not self._chat_ready:
                self._chat_ready = True
                if hasattr(self, '_setup_frame'):
                    self._setup_frame.destroy()
                self._build_chat_view()
            self._add_system_bubble(f"Switched to {self.provider} / {self.model}")
            win.destroy()

        ctk.CTkButton(f, text="Save & Connect", height=30,
                      fg_color="#0a84ff", hover_color="#0070e0",
                      command=_save).pack(fill="x", pady=(8, 4))


    def _toggle_history(self):
        if self._history_visible:
            self._history_frame.pack_forget()
            self._history_visible = False
        else:
            self._history_frame.pack(fill="x", padx=6, pady=2,
                                      before=self._chat_frame if hasattr(self, '_chat_frame')
                                      else None)
            self._history_visible = True
            self._refresh_history_list()

    def _refresh_history_list(self):
        for w in self._history_frame.winfo_children():
            w.destroy()
        chats = _list_saved_chats()
        if not chats:
            ctk.CTkLabel(self._history_frame, text="No saved chats",
                         text_color="#48494e",
                         font=ctk.CTkFont(size=9)).pack(pady=4)
            return
        for ch in chats[:20]:
            row = ctk.CTkFrame(self._history_frame, fg_color="transparent")
            row.pack(fill="x", pady=1)
            title = ch.get("title", "Untitled")
            if len(title) > 25:
                title = title[:24] + "..."
            ts = ch.get("timestamp", 0)
            date_str = time.strftime("%m/%d %H:%M", time.localtime(ts)) if ts else ""
            n_msgs = len(ch.get("messages", []))
            ctk.CTkButton(row, text=f"{title} ({n_msgs})",
                          width=130, height=20,
                          font=ctk.CTkFont(size=9),
                          fg_color="#1c1e26", hover_color="#2c2e36",
                          text_color="#e5e5ea", anchor="w",
                          command=lambda c=ch: self._load_chat_session(c)).pack(
                side="left", padx=1)
            ctk.CTkLabel(row, text=date_str, font=ctk.CTkFont(size=8),
                         text_color="#48494e").pack(side="left", padx=2)
            ctk.CTkButton(row, text="Del", width=28, height=18,
                          font=ctk.CTkFont(size=8),
                          fg_color="#2c2e36", hover_color="#ff453a",
                          text_color="#ff453a",
                          command=lambda p=ch["_path"]: self._delete_and_refresh(p)).pack(
                side="right", padx=1)

    def _delete_and_refresh(self, path):
        _delete_chat_session(path)
        self._refresh_history_list()

    def _load_chat_session(self, chat_data):
        self.messages = chat_data.get("messages", [])
        self._pending_edits = []
        if hasattr(self, '_messages_scroll'):
            for w in self._messages_scroll.winfo_children():
                w.destroy()
            self._restore_chat_display()
            self._add_system_bubble(f"Loaded: {chat_data.get('title', 'Untitled')}")
        self._history_frame.pack_forget()
        self._history_visible = False


    def _on_key_change(self, event=None):
        key = self._key_entry.get().strip()
        if len(key) >= 10:
            self._trigger_auto_fetch()

    def _trigger_auto_fetch(self):
        key = self._key_entry.get().strip()
        if not key or len(key) < 10 or self._fetching:
            return
        self._fetching = True
        provider = self._provider_var.get()
        self._model_status.configure(text=f"Fetching {provider} models...")

        def _do():
            try:
                models = list_models(provider, key)
                self.after(0, lambda: self._on_models_fetched(models))
            except Exception as e:
                self.after(0, lambda: self._model_status.configure(
                    text=f"Error: {str(e)[:50]}"))
            finally:
                self._fetching = False
        threading.Thread(target=_do, daemon=True).start()

    def _on_models_fetched(self, models):
        self._model_combo.configure(values=models)
        default = PROVIDERS[self._provider_var.get()]["default_model"]
        if default in models:
            self._model_var.set(default)
        elif models:
            self._model_var.set(models[0])
        self._model_status.configure(text=f"{len(models)} models available")

    def _start_chat(self):
        self.provider = self._provider_var.get()
        self.api_key = self._key_entry.get().strip()
        self.model = self._model_var.get()
        if not self.api_key or not self.model:
            self.app.status_var.set("Enter API key and select model first")
            return
        _save_ai_config({"provider": self.provider, "api_key": self.api_key,
                         "model": self.model})
        self._init_system_prompt()
        self._chat_ready = True
        self._setup_frame.destroy()
        self._build_chat_view()


    def _on_enter(self, event):
        self._send_message()
        return "break"

    def _send_message(self):
        text = self._input_entry.get().strip()
        if not text:
            return
        self._input_entry.delete(0, "end")
        self._add_user_bubble(text)
        self.messages.append({"role": "user", "content": text})
        self._thinking_label = self._add_system_bubble("Thinking...")

        def _do():
            try:
                reply = chat(self.provider, self.api_key, self.model,
                             self.messages, self._system_prompt)
                self.messages.append({"role": "assistant", "content": reply})
                self.after(0, lambda: self._on_reply(reply))
            except Exception as e:
                self.after(0, lambda: self._on_error(str(e)))
        threading.Thread(target=_do, daemon=True).start()

    def _on_reply(self, reply):
        if hasattr(self, '_thinking_label') and self._thinking_label:
            self._thinking_label.destroy()
        self._set_connection_status(True)
        edits = self._extract_edits(reply)
        self._pending_edits = edits
        self._add_assistant_bubble(reply, edits)
        if edits:
            self._add_system_bubble(
                f"{len(edits)} edit(s) ready — press Apply to write them")
        self._save_chat_history()

    def _on_error(self, err):
        if hasattr(self, '_thinking_label') and self._thinking_label:
            self._thinking_label.destroy()
        self._set_connection_status(False)
        self._add_system_bubble(f"Error: {err[:100]}")


    def _add_user_bubble(self, text):
        wrapper = ctk.CTkFrame(self._messages_scroll, fg_color="transparent")
        wrapper.pack(fill="x", pady=2)
        bubble = ctk.CTkFrame(wrapper, corner_radius=12, fg_color="#0a84ff")
        bubble.pack(side="right", padx=4, pady=1)
        ctk.CTkLabel(bubble, text=text, wraplength=180,
                     font=ctk.CTkFont(size=11),
                     text_color="#ffffff",
                     justify="left").pack(padx=10, pady=6)
        self._scroll_to_bottom()

    def _add_assistant_bubble(self, text, edits=None):
        display = re.sub(r"```(?:python)?:[^\n]+\n.*?```", "", text,
                         flags=re.DOTALL).strip()
        if not display and edits:
            display = f"[{len(edits)} file edit(s)]"
        wrapper = ctk.CTkFrame(self._messages_scroll, fg_color="transparent")
        wrapper.pack(fill="x", pady=2)
        bubble = ctk.CTkFrame(wrapper, corner_radius=12, fg_color="#1c1e26",
                              border_width=1, border_color="#2c2e36")
        bubble.pack(side="left", padx=4, pady=1)
        if len(display) > 400:
            display = display[:400] + "..."
        ctk.CTkLabel(bubble, text=display, wraplength=180,
                     font=ctk.CTkFont(size=11),
                     text_color="#e5e5ea",
                     justify="left").pack(padx=10, pady=6)
        if edits:
            for rel, _ in edits:
                ctk.CTkLabel(bubble, text=f"  {rel}",
                             font=ctk.CTkFont(size=9),
                             text_color="#30d158").pack(padx=10, anchor="w")
        self._scroll_to_bottom()

    def _add_system_bubble(self, text):
        wrapper = ctk.CTkFrame(self._messages_scroll, fg_color="transparent")
        wrapper.pack(fill="x", pady=1)
        lbl = ctk.CTkLabel(wrapper, text=text,
                           font=ctk.CTkFont(size=9),
                           text_color="#48494e")
        lbl.pack(pady=2)
        self._scroll_to_bottom()
        return wrapper

    def _scroll_to_bottom(self):
        self.after(50, lambda: self._messages_scroll._parent_canvas.yview_moveto(1.0))


    def _extract_edits(self, text):
        pattern = r"```(?:python)?:([^\n]+)\n(.*?)```"
        return re.findall(pattern, text, re.DOTALL)

    def _apply_pending_edits(self):
        if not self._pending_edits:
            self.app.status_var.set("No edits to apply")
            return
        from tkinter import messagebox
        files_list = "\n".join(f"  - {r}" for r, _ in self._pending_edits)
        if not messagebox.askyesno(
                "Apply AI Edits",
                f"Modify {len(self._pending_edits)} file(s)?\n\n"
                f"{files_list}\n\nA backup will be created first.",
                parent=self.app):
            return
        pkg = self.vc.package_dir
        abs_paths = [str(pkg / r) for r, _ in self._pending_edits]
        desc = "AI edit"
        last_user = [m for m in self.messages if m["role"] == "user"]
        if last_user:
            desc = last_user[-1]["content"][:80]
        self.vc.snapshot_files(abs_paths, description=desc)
        applied = []
        for rel, content in self._pending_edits:
            target = pkg / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
            applied.append(rel)
        reloaded = self._hot_reload(applied)
        self._pending_edits = []
        self._add_system_bubble(
            f"Applied {len(applied)} file(s), reloaded {reloaded}")
        self.app.status_var.set(f"AI edits applied to {len(applied)} file(s)")


    def _save_chat_history(self):
        cfg = _load_ai_config()
        cfg["chat_history"] = self.messages[-50:]
        _save_ai_config(cfg)
        if self.messages:
            first_user = next((m["content"] for m in self.messages
                               if m["role"] == "user"), "Untitled")
            title = first_user[:40]
            _save_chat_session(title, self.messages[-50:],
                              self.provider or "", self.model or "")

    def _restore_chat_display(self):
        for m in self.messages:
            if m["role"] == "user":
                self._add_user_bubble(m["content"])
            elif m["role"] == "assistant":
                edits = self._extract_edits(m["content"])
                self._add_assistant_bubble(m["content"], edits)

    def _new_chat(self):
        self.messages = []
        self._pending_edits = []
        cfg = _load_ai_config()
        cfg["chat_history"] = []
        _save_ai_config(cfg)
        for w in self._messages_scroll.winfo_children():
            w.destroy()
        n_files = len(self.vc.read_source_tree())
        self._add_system_bubble(f"New chat | {n_files} files loaded")


    def _hot_reload(self, applied_paths):
        import importlib
        import sys
        reloaded = 0
        for rel in applied_paths:
            if not rel.endswith(".py"):
                continue
            mod_path = rel.replace("/", ".").replace("\\", ".")
            if mod_path.endswith(".py"):
                mod_path = mod_path[:-3]
            mod_name = f"fluoroview.{mod_path}" if not mod_path.startswith("fluoroview") else mod_path
            if mod_name.startswith("fluoroview.fluoroview."):
                mod_name = mod_name[len("fluoroview."):]
            if mod_name in sys.modules:
                try:
                    importlib.reload(sys.modules[mod_name])
                    reloaded += 1
                except Exception:
                    pass
        return reloaded


AIChatWindow = AIChatPanel

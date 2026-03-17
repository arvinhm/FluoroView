
from __future__ import annotations

import json
import platform
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path

_USER_CONFIG_PATH = Path.home() / ".fluoroview_user.json"


def _machine_id() -> str:
    return f"{platform.node()}|{platform.system()}|{platform.machine()}"


def _load_user_config() -> dict:
    try:
        return json.loads(_USER_CONFIG_PATH.read_text())
    except Exception:
        return {}


def _save_user_config(cfg: dict):
    try:
        _USER_CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    except Exception:
        pass


def get_display_name() -> str:
    cfg = _load_user_config()
    return cfg.get("display_name", platform.node() or "unknown")


def set_display_name(name: str):
    cfg = _load_user_config()
    cfg["display_name"] = name
    _save_user_config(cfg)


@dataclass
class Reply:

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    text: str = ""
    created: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    author: str = field(default_factory=get_display_name)
    machine_id: str = field(default_factory=_machine_id)

    def owned_by_current_machine(self) -> bool:
        return self.machine_id == _machine_id()

    def pretty_time(self) -> str:
        try:
            return datetime.fromisoformat(self.created).strftime("%m/%d %H:%M")
        except Exception:
            return self.created[:16]

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Reply":
        known = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class Annotation:

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    text: str = ""
    x: float = 0.0
    y: float = 0.0
    linked_roi: str | None = None
    color: str = "#ffff00"
    created: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    author: str = field(default_factory=get_display_name)
    machine_id: str = field(default_factory=_machine_id)
    replies: list[Reply] = field(default_factory=list)

    def owned_by_current_machine(self) -> bool:
        return self.machine_id == _machine_id()

    def pretty_time(self) -> str:
        try:
            return datetime.fromisoformat(self.created).strftime("%Y-%m-%d %H:%M")
        except Exception:
            return self.created[:16]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["replies"] = [r.to_dict() if isinstance(r, Reply) else r for r in self.replies]
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Annotation":
        known = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in d.items() if k in known and k != "replies"}
        ann = cls(**filtered)
        ann.replies = [Reply.from_dict(r) for r in d.get("replies", [])]
        return ann

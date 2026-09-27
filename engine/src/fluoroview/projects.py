"""Per-folder project state: regions, annotations, background region and display settings.

Projects live in FluoroView's own data folder, never next to the scans. One JSON file per scan
folder; each scan inside it is keyed by its file name (or the joined names of combined files), so
state survives re-opening and cache rebuilds.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path

FORMAT = "fluoroview-project-1"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def empty_scan() -> dict:
    return {"regions": [], "annotations": [], "background_region": None, "display": None, "calibration": None,
            "counters": [], "points": [], "updated": None}


def calibrated_pixel_size(state: dict, file_value: float | None) -> float | None:
    """The pixel size set by the user (Set Scale), else the one recorded in the file."""
    calibration = state.get("calibration")
    return calibration["pixel_size_um"] if calibration else file_value


class ProjectStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _file(self, folder: str) -> Path:
        key = hashlib.sha256(os.path.realpath(folder).encode()).hexdigest()[:16]
        return self.root / f"{key}.json"

    def _load(self, folder: str) -> dict:
        try:
            data = json.loads(self._file(folder).read_text())
            if data.get("format") == FORMAT:
                return data
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        return {"format": FORMAT, "folder": os.path.realpath(folder), "scans": {}}

    def scan(self, folder: str, scan_key: str) -> dict:
        with self._lock:
            return self._load(folder)["scans"].get(scan_key) or empty_scan()

    def scans(self, folder: str) -> dict[str, dict]:
        with self._lock:
            return self._load(folder)["scans"]

    def update(self, folder: str, scan_key: str, change: Callable[[dict], object]) -> object:
        """Apply ``change`` to one scan's state and save atomically; returns what ``change`` returns."""
        with self._lock:
            data = self._load(folder)
            state = data["scans"].setdefault(scan_key, empty_scan())
            result = change(state)
            state["updated"] = now_iso()
            path = self._file(folder)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1, allow_nan=False))
            os.replace(tmp, path)
            return result

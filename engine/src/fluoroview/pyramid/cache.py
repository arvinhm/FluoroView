"""Pyramid caches on the internal disk, keyed by source file identity, evicted least-recently-used."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from pathlib import Path

import numpy as np

from ..io.model import file_fingerprint
from .store import FORMAT

META = "fluoroview.json"
HIST = "histograms.npy"
PYRAMID = "pyramid.zarr"


class PyramidCache:
    def __init__(self, root: Path, limit_bytes: int):
        self.root = Path(root)
        self.limit_bytes = int(limit_bytes)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    @staticmethod
    def key_for_fingerprint(fingerprint: str) -> str:
        return hashlib.sha256(f"{fingerprint}\0{FORMAT}".encode()).hexdigest()[:24]

    @classmethod
    def key_for(cls, path: str | os.PathLike) -> str:
        return cls.key_for_fingerprint(file_fingerprint(str(path)))

    def dir(self, key: str) -> Path:
        return self.root / key

    def pyramid_dir(self, key: str) -> Path:
        return self.dir(key) / PYRAMID

    def meta(self, key: str) -> dict | None:
        try:
            return json.loads((self.dir(key) / META).read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def is_complete(self, key: str) -> bool:
        meta = self.meta(key)
        return bool(meta and meta.get("state") == "complete")

    def histograms(self, key: str) -> np.ndarray:
        return np.load(self.dir(key) / HIST)

    def begin(self, key: str, source_path: str) -> Path:
        with self._lock:
            shutil.rmtree(self.dir(key), ignore_errors=True)
            self.dir(key).mkdir(parents=True)
            self._write_meta(key, {"format": FORMAT, "source": source_path, "state": "building",
                                   "created": time.time(), "last_used": time.time()})
        return self.pyramid_dir(key)

    def finish(self, key: str, histograms: np.ndarray, build_seconds: float, nbytes: int, level0_cached: bool) -> None:
        np.save(self.dir(key) / HIST, histograms)
        meta = self.meta(key) or {}
        meta.update(state="complete", build_seconds=round(build_seconds, 3), level0_cached=level0_cached,
                    bytes=nbytes + histograms.nbytes, last_used=time.time())
        self._write_meta(key, meta)

    def discard(self, key: str) -> None:
        shutil.rmtree(self.dir(key), ignore_errors=True)

    def touch(self, key: str) -> None:
        meta = self.meta(key)
        if meta:
            meta["last_used"] = time.time()
            self._write_meta(key, meta)

    def entries(self) -> list[tuple[str, dict]]:
        out = []
        for d in self.root.iterdir():
            if d.is_dir():
                meta = self.meta(d.name)
                out.append((d.name, meta or {}))
        return out

    def evict(self, keep: set[str], reserve_bytes: int = 0) -> list[str]:
        """Remove least-recently-used complete caches until used + reserve fits the limit."""
        with self._lock:
            complete = [(k, m) for k, m in self.entries() if m.get("state") == "complete"]
            used = sum(m.get("bytes", 0) for _, m in complete)
            removed = []
            for key, meta in sorted(complete, key=lambda km: km[1].get("last_used", 0)):
                if used + reserve_bytes <= self.limit_bytes:
                    break
                if key in keep:
                    continue
                shutil.rmtree(self.dir(key), ignore_errors=True)
                used -= meta.get("bytes", 0)
                removed.append(key)
            return removed

    def remove_incomplete(self, keep: set[str]) -> None:
        for key, meta in self.entries():
            if meta.get("state") != "complete" and key not in keep:
                shutil.rmtree(self.dir(key), ignore_errors=True)

    def _write_meta(self, key: str, meta: dict) -> None:
        path = self.dir(key) / META
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, indent=1))
        os.replace(tmp, path)

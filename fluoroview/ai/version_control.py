
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime
from pathlib import Path


class VersionControl:

    def __init__(self, package_dir: str | None = None):
        if package_dir is None:
            package_dir = str(Path(__file__).resolve().parent.parent)
        self.package_dir = Path(package_dir)
        self.versions_dir = self.package_dir / ".fluoroview_versions"
        self.versions_dir.mkdir(exist_ok=True)
        self.manifest_path = self.versions_dir / "manifest.json"
        self._manifest: list[dict] = self._load_manifest()


    def _load_manifest(self) -> list[dict]:
        try:
            return json.loads(self.manifest_path.read_text())
        except Exception:
            return []

    def _save_manifest(self):
        self.manifest_path.write_text(json.dumps(self._manifest, indent=2))


    def snapshot_files(self, files: list[str], description: str = "") -> str:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        snap_dir = self.versions_dir / ts
        snap_dir.mkdir(parents=True, exist_ok=True)

        saved: list[dict] = []
        for fpath in files:
            p = Path(fpath)
            if not p.exists():
                continue
            rel = p.relative_to(self.package_dir) if p.is_relative_to(self.package_dir) else p
            dest = snap_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(p), str(dest))
            saved.append({
                "original": str(p),
                "relative": str(rel),
                "snapshot": str(dest),
            })

        entry = {
            "id": ts,
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "description": description,
            "files": saved,
        }
        self._manifest.append(entry)
        self._save_manifest()
        return ts

    def list_versions(self) -> list[dict]:
        return list(self._manifest)

    def restore_version(self, version_id: str) -> list[str]:
        entry = None
        for e in self._manifest:
            if e["id"] == version_id:
                entry = e
                break
        if entry is None:
            raise ValueError(f"Version {version_id} not found")

        restored: list[str] = []
        for fi in entry["files"]:
            src = Path(fi["snapshot"])
            dst = Path(fi["original"])
            if src.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(src), str(dst))
                restored.append(str(dst))
        return restored

    def snapshot_before_edit(self, file_path: str, description: str = "") -> str:
        return self.snapshot_files([file_path], description=description)


    def source_files(self) -> list[Path]:
        return sorted(self.package_dir.rglob("*.py"))

    def read_source_tree(self) -> dict[str, str]:
        tree: dict[str, str] = {}
        for p in self.source_files():
            rel = str(p.relative_to(self.package_dir))
            if ".fluoroview_versions" in rel:
                continue
            try:
                tree[rel] = p.read_text()
            except Exception:
                pass
        return tree

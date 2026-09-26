from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from pathlib import Path

import platformdirs

PACKAGE_DIR = Path(__file__).parent


def default_cache_dir() -> Path:
    return platformdirs.user_cache_path("FluoroView", appauthor=False) / "pyramids"


def default_projects_dir() -> Path:
    return platformdirs.user_data_path("FluoroView", appauthor=False) / "projects"


@dataclass
class Settings:
    host: str = "127.0.0.1"
    port: int = 0
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    cache_dir: Path = field(default_factory=default_cache_dir)
    projects_dir: Path = field(default_factory=default_projects_dir)
    cache_limit_bytes: int = 20_000_000_000
    cache_full_resolution: bool = False
    """Also copy full-resolution tiles into the cache. Uncompressed sources are otherwise read in place."""
    band_cache_bytes: int = 1 << 30
    studio_dir: Path | None = field(default_factory=lambda: PACKAGE_DIR / "_studio")
    extra_hosts: tuple[str, ...] = ()

    @property
    def allowed_hosts(self) -> set[str]:
        hosts = {f"127.0.0.1:{self.port}", f"localhost:{self.port}", f"[::1]:{self.port}"}
        return hosts | set(self.extra_hosts)

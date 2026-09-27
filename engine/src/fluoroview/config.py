from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

import platformdirs

PACKAGE_DIR = Path(__file__).parent


def default_cache_dir() -> Path:
    return platformdirs.user_cache_path("FluoroView", appauthor=False) / "pyramids"


def default_data_dir() -> Path:
    return platformdirs.user_data_path("FluoroView", appauthor=False)


def default_projects_dir() -> Path:
    return default_data_dir() / "projects"


def saved_token(path: Path | None = None) -> str:
    """The access token kept between launches, so the studio can remember it; created on first use in a
    file only this account can read. Deleting the file issues a new token at the next launch."""
    path = path or default_data_dir() / "token"
    try:
        token = path.read_text().strip()
    except FileNotFoundError:
        token = ""
    if not token:
        path.parent.mkdir(parents=True, exist_ok=True)
        token = secrets.token_urlsafe(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(token + "\n")
    if os.name == "posix":
        path.chmod(0o600)
    return token


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

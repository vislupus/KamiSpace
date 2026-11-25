"""Application configuration.

Everything is driven by environment variables prefixed with ``KAMISPACE_`` (or a
``.env`` file in the project root). All persistent state lives under
``data_dir``, which defaults to ``<project>/data`` so that the database,
uploads, backups, logs and temporary files never leave the project directory.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from dotenv import dotenv_values
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent

ENV_PREFIX = "KAMISPACE_"
# The project was called MindDock before; settings written for that name
# (environment or .env) keep working so an upgrade never silently falls back
# to defaults such as a different data directory.
LEGACY_ENV_PREFIX = "MIND" + "DOCK_"


def adopt_legacy_environment() -> list[str]:
    """Map old-prefix variables onto the current prefix; returns what was adopted."""
    env_file = BASE_DIR / ".env"
    from_file = dotenv_values(env_file) if env_file.is_file() else {}
    adopted: list[str] = []
    for key, value in {**from_file, **os.environ}.items():
        if not key.startswith(LEGACY_ENV_PREFIX) or value is None:
            continue
        current = ENV_PREFIX + key[len(LEGACY_ENV_PREFIX) :]
        if current not in os.environ and current not in from_file:
            os.environ[current] = value
            adopted.append(key)
    return adopted


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="KAMISPACE_",
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: Literal["development", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = 8000
    # Worker processes of `python -m app run`. One is enough for a small team;
    # several let the server use more than one CPU core.
    workers: int = Field(default=1, ge=1, le=64)
    log_level: str = "INFO"

    # Storage. A relative value is resolved against the project directory.
    data_dir: Path = Path("data")

    # Sessions
    session_cookie_name: str = "kamispace_session"
    session_idle_minutes: int = Field(default=60 * 24 * 7, ge=5)
    session_max_days: int = Field(default=30, ge=1)
    # "auto" marks the cookie Secure whenever the request arrived over HTTPS.
    cookie_secure: Literal["auto", "always", "never"] = "auto"

    # Login rate limiting
    login_max_failures: int = Field(default=5, ge=1)
    login_window_minutes: int = Field(default=15, ge=1)

    # Uploads
    max_upload_mb: int = Field(default=100, ge=1)

    # Documents
    max_document_kb: int = Field(default=4096, ge=64)
    # Autosaves by the same author within this window are folded into one version.
    version_interval_minutes: int = Field(default=10, ge=0)

    # Let the server fetch public web addresses on a user's request: link
    # previews for bookmarks and images pasted from web pages.
    allow_remote_fetch: bool = True

    # Optional comma separated Host header allow-list (e.g. "notes.example.com").
    allowed_hosts: str = ""

    # Apply pending database migrations automatically on `python -m app run`.
    auto_migrate: bool = True

    @field_validator("data_dir")
    @classmethod
    def _resolve_data_dir(cls, value: Path) -> Path:
        path = value if value.is_absolute() else BASE_DIR / value
        return path.resolve()

    @property
    def database_path(self) -> Path:
        return self.data_dir / "database.sqlite3"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.database_path.as_posix()}"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def temp_dir(self) -> Path:
        return self.data_dir / "temp"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def allowed_host_list(self) -> list[str]:
        return [h.strip() for h in self.allowed_hosts.split(",") if h.strip()]

    def ensure_directories(self) -> None:
        for path in (
            self.data_dir,
            self.uploads_dir,
            self.backups_dir,
            self.temp_dir,
            self.logs_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    adopt_legacy_environment()
    return Settings()

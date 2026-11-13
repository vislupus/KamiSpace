"""Application configuration.

Everything is driven by environment variables prefixed with ``MINDDOCK_`` (or a
``.env`` file in the project root). All persistent state lives under
``data_dir``, which defaults to ``<project>/data`` so that the database,
uploads, backups, logs and temporary files never leave the project directory.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MINDDOCK_",
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: Literal["development", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "INFO"

    # Storage. A relative value is resolved against the project directory.
    data_dir: Path = Path("data")

    # Sessions
    session_cookie_name: str = "minddock_session"
    session_idle_minutes: int = Field(default=60 * 24 * 7, ge=5)
    session_max_days: int = Field(default=30, ge=1)
    # "auto" marks the cookie Secure whenever the request arrived over HTTPS.
    cookie_secure: Literal["auto", "always", "never"] = "auto"

    # Login rate limiting
    login_max_failures: int = Field(default=5, ge=1)
    login_window_minutes: int = Field(default=15, ge=1)

    # Uploads
    max_upload_mb: int = Field(default=25, ge=1)

    # Documents
    max_document_kb: int = Field(default=4096, ge=64)
    # Autosaves by the same author within this window are folded into one version.
    version_interval_minutes: int = Field(default=10, ge=0)

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
    return Settings()

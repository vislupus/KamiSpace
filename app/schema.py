"""Keeping the database schema in step with the code.

The schema is changed by migrations. Whatever starts the application — the
``run`` command, a process manager calling uvicorn directly, a container —
the database is checked here first, so a mismatch shows up as one clear
message at start-up instead of failing requests later.
"""

from __future__ import annotations

import contextlib
import logging
import sqlite3
from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache

from app.config import BASE_DIR, Settings, get_settings
from app.db import reset_engine

logger = logging.getLogger("kamispace.schema")


class SchemaError(RuntimeError):
    """The database does not fit this version of the code."""


@dataclass(frozen=True)
class SchemaState:
    current: str | None  # revision of the database, None for a new one
    head: str  # revision this code needs
    known: bool  # whether this code knows the database's revision

    @property
    def status(self) -> str:
        if self.current == self.head:
            return "ok"
        # A revision this code has never heard of: the database was migrated
        # by a newer version than the one that is running.
        return "behind" if self.known else "ahead"


def alembic_config():
    from alembic.config import Config

    config = Config(str(BASE_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BASE_DIR / "migrations"))
    return config


@lru_cache
def _revisions() -> tuple[str, frozenset[str]]:
    """The newest revision and all revisions this code ships with."""
    from alembic.script import ScriptDirectory

    scripts = ScriptDirectory.from_config(alembic_config())
    return scripts.get_current_head() or "", frozenset(
        rev.revision for rev in scripts.walk_revisions()
    )


def schema_state(settings: Settings | None = None) -> SchemaState:
    settings = settings or get_settings()
    head, revisions = _revisions()
    current: str | None = None
    if settings.database_path.is_file():
        connection = sqlite3.connect(settings.database_path, timeout=5)
        try:
            row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
            current = row[0] if row else None
        except sqlite3.OperationalError:
            current = None  # no version table yet: an empty database
        finally:
            connection.close()
    known = current is None or current in revisions
    return SchemaState(current=current, head=head, known=known)


@contextlib.contextmanager
def _migration_lock(settings: Settings) -> Iterator[None]:
    """Only one process migrates at a time (several workers may start together)."""
    settings.ensure_directories()
    path = settings.temp_dir / "migrate.lock"
    with open(path, "w") as handle:
        try:
            import fcntl
        except ImportError:  # not available on Windows: migrate without a lock
            yield
            return
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def run_migrations() -> None:
    from alembic import command

    settings = get_settings()
    with _migration_lock(settings):
        command.upgrade(alembic_config(), "head")
    reset_engine()


def ensure_schema(settings: Settings | None = None) -> SchemaState:
    """Make sure the database fits the code; called when the application starts.

    A database that is behind is migrated (unless ``auto_migrate`` is off).
    Anything else stops the start with a message that says what to do.
    """
    settings = settings or get_settings()
    state = schema_state(settings)
    if state.status == "ok":
        return state
    where = f"database {settings.database_path}"
    if state.status == "ahead":
        message = (
            f"The {where} is at schema revision {state.current}, which this copy of the code "
            f"does not know (it expects {state.head}). The database was upgraded by a newer "
            "version of KamiSpace: deploy that version here too (pull the code and restart "
            "the service from it)."
        )
        logger.critical(message)
        raise SchemaError(message)
    if not settings.auto_migrate:
        message = (
            f"The {where} is at schema revision {state.current or 'none'} but this version "
            f"needs {state.head}. Run `python -m app migrate` with the same settings "
            "(KAMISPACE_DATA_DIR and .env) as the service, then start it again."
        )
        logger.critical(message)
        raise SchemaError(message)
    logger.warning(
        "Upgrading the %s from schema revision %s to %s", where, state.current or "none", state.head
    )
    run_migrations()
    state = schema_state(settings)
    if state.status != "ok":
        message = f"The {where} could not be upgraded to schema revision {state.head}."
        logger.critical(message)
        raise SchemaError(message)
    return state

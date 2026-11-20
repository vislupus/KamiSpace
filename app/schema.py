"""Keeping the database schema in step with the code.

The schema is changed by migrations. Whatever starts the application — the
``run`` command, a process manager calling uvicorn directly, a container —
the database is checked here first, so a mismatch shows up as one clear
message at start-up instead of failing requests later.

Three things have to agree: the revision this code was written for
(``REQUIRED_REVISION``), the migration files next to the code, and the
database. The revision number alone is not trusted: the tables and columns
the code uses are compared with what the database really has.
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

# The newest migration this code needs. Raise it together with every new
# migration (a test fails otherwise).
REQUIRED_REVISION = "0003"

MIGRATIONS_DIR = BASE_DIR / "migrations"


class SchemaError(RuntimeError):
    """The database does not fit this version of the code."""


@dataclass(frozen=True)
class SchemaState:
    current: str | None  # revision the database says it is at (None: new)
    head: str  # newest revision among the migration files next to the code
    required: str  # revision this code needs
    known: bool  # whether the migration files include the database's revision
    missing: tuple[str, ...] = ()  # tables / columns the code uses but the database lacks

    @property
    def status(self) -> str:
        if self.head != self.required:
            # The code was updated without its migrations/ folder (or the
            # other way round).
            return "incomplete"
        if not self.known:
            # A revision the migration files have never heard of: the
            # database was upgraded by a newer version than this code.
            return "ahead"
        if self.current != self.head:
            return "behind"
        # The revision is right, yet tables or columns are not there.
        return "damaged" if self.missing else "ok"


def alembic_config():
    from alembic.config import Config

    config = Config(str(BASE_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    return config


@lru_cache
def _revisions() -> tuple[str, tuple[str, ...]]:
    """The newest revision and all revisions among the migration files, oldest first."""
    from alembic.script import ScriptDirectory

    scripts = ScriptDirectory.from_config(alembic_config())
    ordered = tuple(reversed([rev.revision for rev in scripts.walk_revisions()]))
    return scripts.get_current_head() or "", ordered


def _missing_parts(connection: sqlite3.Connection) -> tuple[str, ...]:
    """Tables and columns of the models that the database does not have."""
    from app import models  # noqa: F401  (registers the tables)
    from app.db import Base

    missing: list[str] = []
    for table in Base.metadata.sorted_tables:
        columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table.name}")')}
        if not columns:
            missing.append(table.name)
            continue
        missing.extend(
            f"{table.name}.{column.name}" for column in table.columns if column.name not in columns
        )
    return tuple(missing)


def schema_state(settings: Settings | None = None) -> SchemaState:
    settings = settings or get_settings()
    head, revisions = _revisions()
    current: str | None = None
    missing: tuple[str, ...] = ()
    if settings.database_path.is_file():
        connection = sqlite3.connect(settings.database_path, timeout=5)
        try:
            try:
                row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
                current = row[0] if row else None
            except sqlite3.OperationalError:
                current = None  # no version table yet: an empty database
            if current is not None:
                missing = _missing_parts(connection)
        finally:
            connection.close()
    return SchemaState(
        current=current,
        head=head,
        required=REQUIRED_REVISION,
        known=current is None or current in revisions,
        missing=missing,
    )


def previous_revision(revision: str) -> str | None:
    """The revision before ``revision`` among the migration files."""
    _head, revisions = _revisions()
    if revision not in revisions:
        return None
    index = revisions.index(revision)
    return revisions[index - 1] if index else None


def explain(state: SchemaState, settings: Settings | None = None) -> str:
    """What is wrong and what to do about it, in plain words ('' when all is well)."""
    settings = settings or get_settings()
    where = f"The database {settings.database_path}"
    if state.status == "ok":
        return ""
    if state.status == "incomplete":
        return (
            f"This code needs schema revision {state.required}, but the newest migration in "
            f"{MIGRATIONS_DIR / 'versions'} is {state.head or 'none'}. The code was updated "
            "without its migrations/ folder (or only in part). Update the whole project — every "
            "folder, from the same version — and start again."
        )
    if state.status == "ahead":
        return (
            f"{where} is at schema revision {state.current}, which this copy of the code does "
            f"not know (it expects {state.head}). The database was upgraded by a newer version "
            "of KamiSpace: update the code here to that version."
        )
    if state.status == "behind":
        return (
            f"{where} is at schema revision {state.current or 'none'}; this version needs "
            f"{state.head}. Run `python -m app migrate` with the same settings "
            "(KAMISPACE_DATA_DIR and .env) as the service."
        )
    shown = ", ".join(state.missing[:8]) + (" …" if len(state.missing) > 8 else "")
    earlier = previous_revision(state.head) or "<revision>"
    return (
        f"{where} is marked as schema revision {state.current}, but it does not have what that "
        f"revision brings: {shown} missing. The revision mark and the tables disagree — this "
        "happens when the database file was replaced by an older copy, or the mark was set "
        f"by hand. Make a backup, then run `python -m app migrate --assume {earlier}` (use the "
        "revision the database really is at): it resets the mark and applies the migrations "
        "after it."
    )


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


def run_migrations(assume: str | None = None) -> None:
    """Upgrade the database to the newest revision.

    ``assume`` first sets the revision mark to the given revision, for a
    database whose mark does not say what it really contains.
    """
    from alembic import command

    settings = get_settings()
    with _migration_lock(settings):
        config = alembic_config()
        if assume is not None:
            command.stamp(config, assume)
        command.upgrade(config, "head")
    reset_engine()


def ensure_schema(settings: Settings | None = None) -> SchemaState:
    """Make sure the database fits the code; called when the application starts.

    A database that is behind is migrated (unless ``auto_migrate`` is off).
    Anything else stops the start with a message that says what to do.
    """
    settings = settings or get_settings()
    state = schema_state(settings)
    if state.status == "behind" and settings.auto_migrate:
        logger.warning(
            "Upgrading the database %s from schema revision %s to %s",
            settings.database_path,
            state.current or "none",
            state.head,
        )
        run_migrations()
        state = schema_state(settings)
    if state.status != "ok":
        message = explain(state, settings)
        logger.critical(message)
        raise SchemaError(message)
    return state

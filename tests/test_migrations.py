"""Database migrations."""

from __future__ import annotations

import sqlite3

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, text

from app.cli import run_migrations
from app.config import BASE_DIR, get_settings
from app.db import Base, get_engine, reset_engine

EXPECTED_TABLES = {
    "users",
    "sessions",
    "invites",
    "login_attempts",
    "settings",
    "workspaces",
    "workspace_members",
    "pages",
    "page_permissions",
    "page_versions",
    "tasks",
    "attachments",
    "page_attachments",
    "favorites",
    "page_visits",
    "audit_events",
    "pages_fts",
}


def alembic_config() -> Config:
    config = Config(str(BASE_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BASE_DIR / "migrations"))
    return config


def table_names() -> set[str]:
    connection = sqlite3.connect(get_settings().database_path)
    try:
        rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    finally:
        connection.close()
    return {name for (name,) in rows}


def use_empty_database(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("KAMISPACE_DATA_DIR", str(tmp_path / "fresh"))
    reset_engine()
    get_settings.cache_clear()


def test_upgrade_creates_the_full_schema(tmp_path, monkeypatch):
    use_empty_database(tmp_path, monkeypatch)
    run_migrations()
    assert table_names() >= EXPECTED_TABLES
    run_migrations()  # idempotent
    reset_engine()
    get_settings.cache_clear()


def test_downgrade_and_upgrade_again(tmp_path, monkeypatch):
    use_empty_database(tmp_path, monkeypatch)
    run_migrations()
    command.downgrade(alembic_config(), "base")
    assert not (table_names() & EXPECTED_TABLES)
    command.upgrade(alembic_config(), "head")
    assert table_names() >= EXPECTED_TABLES
    reset_engine()
    get_settings.cache_clear()


def test_models_match_migrations(data_dir):
    """Fails when a model changes without a corresponding migration."""
    engine = create_engine(get_settings().database_url)
    with engine.connect() as connection:
        context = MigrationContext.configure(
            connection,
            opts={
                "include_object": lambda obj, name, type_, *_: (
                    not (type_ == "table" and name.startswith("pages_fts"))
                )
            },
        )
        diff = compare_metadata(context, Base.metadata)
    engine.dispose()
    assert diff == []


def test_sqlite_is_configured_for_integrity(data_dir):
    with get_engine().connect() as connection:
        assert connection.execute(text("PRAGMA foreign_keys")).scalar() == 1
        assert connection.execute(text("PRAGMA journal_mode")).scalar() == "wal"
        assert connection.execute(text("PRAGMA busy_timeout")).scalar() == 5000


def test_upgrade_from_the_first_release_keeps_existing_data(tmp_path, monkeypatch):
    """A database created by 0001 (with email and display name) upgrades in place."""
    use_empty_database(tmp_path, monkeypatch)
    get_settings().ensure_directories()
    command.upgrade(alembic_config(), "0001")
    connection = sqlite3.connect(get_settings().database_path)
    connection.executescript(
        """
        INSERT INTO users (id, username, email, display_name, password_hash, is_admin, is_active,
                           created_at, updated_at)
        VALUES (1, 'admin', 'admin@example.com', 'Ada Admin', 'hash', 1, 1,
                '2026-01-01', '2026-01-01');
        INSERT INTO workspaces (id, name, kind, owner_id, created_at)
        VALUES (1, 'Personal', 'personal', 1, '2026-01-01');
        INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
        VALUES (1, 1, 'owner', '2026-01-01');
        INSERT INTO pages (id, workspace_id, title, content, revision, position, owner_id,
                           created_at, updated_at)
        VALUES (1, 1, 'Kept page', '{"type": "doc"}', 3, 1, 1, '2026-01-01', '2026-01-01');
        INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at,
                              expires_at)
        VALUES (1, 1, 'token', 'csrf', '2026-01-01', '2026-01-01', '2099-01-01');
        """
    )
    connection.commit()
    connection.close()

    run_migrations()
    connection = sqlite3.connect(get_settings().database_path)
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
        assert {"email", "display_name", "inbox_page_id"}.isdisjoint(columns)
        assert connection.execute("SELECT username, is_admin FROM users").fetchall() == [
            ("admin", 1)
        ]
        assert connection.execute(
            "SELECT title, revision, cover_position, font, small_text, full_width, locked "
            "FROM pages"
        ).fetchall() == [("Kept page", 3, 50, "default", 0, 0, 0)]
        assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone() == (1,)
        assert connection.execute("SELECT COUNT(*) FROM workspace_members").fetchone() == (1,)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()
    reset_engine()
    get_settings.cache_clear()

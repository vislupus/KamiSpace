"""Database migrations."""

from __future__ import annotations

import json
import sqlite3

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from fastapi.testclient import TestClient
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
        INSERT INTO pages (id, workspace_id, parent_id, title, content, revision, position,
                           owner_id, created_at, updated_at)
        VALUES (2, 1, 1, 'Existing child', '{"type": "doc"}', 1, 1, 1, '2026-01-01', '2026-01-01');
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
            "SELECT title, revision, cover_position, font, text_size, full_width, locked "
            "FROM pages WHERE id = 1"
        ).fetchall() == [("Kept page", 4, 50, "default", 16, 0, 0)]
        # Sub-pages that already existed are now linked in their parent.
        parent = json.loads(
            connection.execute("SELECT content FROM pages WHERE id = 1").fetchone()[0]
        )
        assert parent["content"] == [
            {"type": "pageLink", "attrs": {"pageId": 2}},
            {"type": "paragraph"},
        ]
        assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone() == (1,)
        assert connection.execute("SELECT COUNT(*) FROM workspace_members").fetchone() == (1,)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()
    reset_engine()
    get_settings.cache_clear()


def test_small_text_becomes_a_text_size(tmp_path, monkeypatch):
    """0003: the "small text" switch is replaced by a text size in pixels."""
    use_empty_database(tmp_path, monkeypatch)
    get_settings().ensure_directories()
    command.upgrade(alembic_config(), "0002")
    connection = sqlite3.connect(get_settings().database_path)
    connection.executescript(
        """
        INSERT INTO users (id, username, password_hash, is_admin, is_active, created_at,
                           updated_at)
        VALUES (1, 'admin', 'x', 1, 1, '2026-01-01', '2026-01-01');
        INSERT INTO workspaces (id, name, kind, owner_id, created_at)
        VALUES (1, 'Personal', 'personal', 1, '2026-01-01');
        INSERT INTO pages (id, workspace_id, title, content, revision, position, owner_id,
                           created_at, updated_at, cover_position, font, small_text,
                           full_width, locked)
        VALUES (1, 1, 'Small', '{"type": "doc"}', 1, 1, 1, '2026-01-01', '2026-01-01',
                50, 'default', 1, 0, 0),
               (2, 1, 'Normal', '{"type": "doc"}', 1, 2, 1, '2026-01-01', '2026-01-01',
                50, 'serif', 0, 1, 0);
        """
    )
    connection.commit()
    connection.close()

    run_migrations()
    connection = sqlite3.connect(get_settings().database_path)
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(pages)")}
        assert "small_text" not in columns
        assert {"text_size", "kind", "db_schema", "props"} <= columns
        assert connection.execute(
            "SELECT title, text_size, kind, font, full_width, props FROM pages ORDER BY id"
        ).fetchall() == [
            ("Small", 14, "page", "default", 0, None),
            ("Normal", 16, "page", "serif", 1, None),
        ]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()
    reset_engine()
    get_settings.cache_clear()


# -- the application checks the schema when it starts ---------------------------


def _set_revision(revision: str) -> None:
    connection = sqlite3.connect(get_settings().database_path)
    connection.execute("UPDATE alembic_version SET version_num = ?", (revision,))
    connection.commit()
    connection.close()


def test_starting_the_app_upgrades_a_database_that_is_behind(tmp_path, monkeypatch):
    """Whatever starts the app (not only `python -m app run`), the schema is brought up."""
    from app.main import create_app
    from app.schema import schema_state

    use_empty_database(tmp_path, monkeypatch)
    get_settings().ensure_directories()
    command.upgrade(alembic_config(), "0002")
    assert schema_state().status == "behind"

    client = TestClient(create_app())
    state = schema_state()
    assert (state.status, state.current) == ("ok", state.head)
    columns = {
        row[1]
        for row in sqlite3.connect(get_settings().database_path).execute("PRAGMA table_info(pages)")
    }
    assert {"kind", "text_size"} <= columns
    health = client.get("/healthz").json()
    assert health["status"] == "ok" and health["schema"] == "ok" and health["version"]
    reset_engine()
    get_settings.cache_clear()


def test_a_database_that_is_behind_stops_the_start_when_auto_migrate_is_off(tmp_path, monkeypatch):
    from app.main import create_app
    from app.schema import SchemaError

    use_empty_database(tmp_path, monkeypatch)
    monkeypatch.setenv("KAMISPACE_AUTO_MIGRATE", "false")
    get_settings.cache_clear()
    get_settings().ensure_directories()
    command.upgrade(alembic_config(), "0002")
    with pytest.raises(SchemaError, match="python -m app migrate"):
        create_app()
    reset_engine()
    get_settings.cache_clear()


def test_older_code_refuses_a_database_from_a_newer_version(tmp_path, monkeypatch, capsys):
    """Old code on an upgraded database must say so, not fail request by request."""
    from app.cli import main as cli_main
    from app.main import create_app
    from app.schema import SchemaError, schema_state

    use_empty_database(tmp_path, monkeypatch)
    run_migrations()
    _set_revision("9999")
    assert schema_state().status == "ahead"
    with pytest.raises(SchemaError, match="newer version"):
        create_app()
    # The command line says the same, and does not touch the database.
    assert cli_main(["migrate"]) == 1
    assert "does not know" in capsys.readouterr().err
    assert cli_main(["status"]) == 1
    output = capsys.readouterr().out
    assert str(get_settings().database_path) in output and "newer than this code" in output
    reset_engine()
    get_settings.cache_clear()


def test_status_command_reports_code_data_and_schema(data_dir, capsys):
    from app.cli import main as cli_main

    assert cli_main(["status"]) == 0
    output = capsys.readouterr().out
    assert str(data_dir) in output
    assert "matches this code" in output
    assert "0 user(s), 0 page(s)" in output

"""Command line interface: ``python -m app <command>``."""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

from app.config import BASE_DIR, get_settings
from app.db import reset_engine, session_scope
from app.errors import AppError
from app.schema import (
    MIGRATIONS_DIR,
    _revisions,
    explain,
    run_migrations,
    schema_state,
)


def cmd_run(args: argparse.Namespace) -> int:
    import uvicorn

    settings = get_settings()
    if settings.auto_migrate:
        run_migrations()
    uvicorn.run(
        "app.main:app",
        host=args.host or settings.host,
        port=args.port or settings.port,
        reload=args.reload,
        proxy_headers=True,
        forwarded_allow_ips=args.forwarded_allow_ips,
        log_level=settings.log_level.lower(),
    )
    return 0


def cmd_migrate(args: argparse.Namespace) -> int:
    settings = get_settings()
    before = schema_state(settings)
    print(f"Database:   {settings.database_path}")
    print(f"Migrations: {MIGRATIONS_DIR / 'versions'} (newest: {before.head or 'none'})")
    if before.status in ("incomplete", "ahead"):
        print(f"\n{explain(before, settings)}", file=sys.stderr)
        return 1
    if args.assume is not None:
        _head, known = _revisions()
        if args.assume not in known:
            print(f"Unknown revision {args.assume!r}. Known: {', '.join(known)}", file=sys.stderr)
            return 1
        print(f"Treating the database as schema revision {args.assume}.")
    run_migrations(assume=args.assume)
    after = schema_state(settings)
    if after.status != "ok":
        # Never report success on the revision number alone.
        print(f"\n{explain(after, settings)}", file=sys.stderr)
        return 1
    if before.current == after.current and args.assume is None:
        print(f"Already up to date: schema revision {after.current}, all tables checked.")
    else:
        start = args.assume or before.current or "none"
        print(f"Upgraded from schema revision {start} to {after.current}.")
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    """Which code, which data and whether they fit: the first thing to check."""
    import sqlite3

    from app import __version__

    settings = get_settings()
    state = schema_state(settings)
    print(f"KamiSpace {__version__} (needs schema revision {state.required})")
    print(f"Code:       {BASE_DIR}")
    print(f"Migrations: {MIGRATIONS_DIR / 'versions'} (newest: {state.head or 'none'})")
    print(f"Data:       {settings.data_dir}")
    print(f"Database:   {settings.database_path}")
    print(f"Log:        {settings.logs_dir / 'kamispace.log'}")
    if not settings.database_path.is_file():
        print("            (the database does not exist yet; it is created on the first start)")
        return 0 if state.status != "incomplete" else 1
    connection = sqlite3.connect(settings.database_path, timeout=5)
    try:
        users = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        pages = connection.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
        print(f"Contents:   {users} user(s), {pages} page(s)")
    except sqlite3.OperationalError as error:
        print(f"Contents:   could not be read ({error})")
    finally:
        connection.close()
    print(f"Schema:     revision {state.current or 'none'} — {state.status}")
    if state.status != "ok":
        print(f"\n{explain(state, settings)}")
        return 1
    return 0


def _read_password(args: argparse.Namespace) -> str:
    if args.password:
        return args.password
    if not sys.stdin.isatty():
        return sys.stdin.readline().rstrip("\n")
    password = getpass.getpass("Password: ")
    if getpass.getpass("Repeat password: ") != password:
        raise AppError("Passwords do not match")
    return password


def cmd_create_admin(args: argparse.Namespace) -> int:
    from app.services import auth

    run_migrations()
    username = args.username or input("Username: ")
    password = _read_password(args)
    with session_scope() as db:
        user = auth.create_user(db, username=username, password=password, is_admin=True)
        print(f"Administrator '{user.username}' created.")
    return 0


def cmd_reset_password(args: argparse.Namespace) -> int:
    from app.services import auth

    password = _read_password(args)
    with session_scope() as db:
        user = auth.find_user(db, args.username)
        if user is None:
            raise AppError(f"No user named '{args.username}'")
        auth.set_password(db, user, password)
        user.is_active = True
        print(f"Password updated for '{user.username}'. All their sessions were signed out.")
    return 0


def cmd_backup(_args: argparse.Namespace) -> int:
    from app.services import backups

    path = backups.create_backup()
    print(f"Backup written to {path}")
    return 0


def cmd_restore(args: argparse.Namespace) -> int:
    from app.services import backups

    archive = Path(args.archive)
    if not archive.is_file():
        candidate = get_settings().backups_dir / args.archive
        if not candidate.is_file():
            raise AppError(f"Backup archive not found: {args.archive}")
        archive = candidate
    manifest = backups.read_manifest(archive)
    print(f"Backup from {manifest.get('created_at')} (KamiSpace {manifest.get('app_version')}),")
    print(f"{manifest.get('upload_count')} uploaded files.")
    if not args.yes:
        print("\nThis replaces the current database and uploads. Stop the server first.")
        if input("Type 'restore' to continue: ").strip().lower() != "restore":
            print("Aborted.")
            return 1
    reset_engine()
    result = backups.restore_backup(archive)
    run_migrations()
    print("Restore complete.")
    print(f"The previous data was moved to {result['previous_data']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app", description="KamiSpace management")
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="Start the web server")
    run.add_argument("--host")
    run.add_argument("--port", type=int)
    run.add_argument("--reload", action="store_true", help="Auto-reload on code changes")
    run.add_argument(
        "--forwarded-allow-ips",
        default="127.0.0.1",
        help="Proxies trusted for X-Forwarded-* headers (default: 127.0.0.1)",
    )
    run.set_defaults(func=cmd_run)

    status = commands.add_parser(
        "status", help="Show which code and data are in use and whether they fit together"
    )
    status.set_defaults(func=cmd_status)

    migrate = commands.add_parser("migrate", help="Apply database migrations")
    migrate.add_argument(
        "--assume",
        metavar="REVISION",
        help="repair: first mark the database as being at this schema revision "
        "(when the mark does not say what the database really contains)",
    )
    migrate.set_defaults(func=cmd_migrate)

    admin = commands.add_parser("create-admin", help="Create an administrator account")
    admin.add_argument("--username")
    admin.add_argument("--password", help="Avoid this on shared machines; omit to be prompted")
    admin.set_defaults(func=cmd_create_admin)

    reset = commands.add_parser("reset-password", help="Set a new password for a user")
    reset.add_argument("username")
    reset.add_argument("--password")
    reset.set_defaults(func=cmd_reset_password)

    backup = commands.add_parser("backup", help="Create a backup archive in data/backups")
    backup.set_defaults(func=cmd_backup)

    restore = commands.add_parser("restore", help="Restore data from a backup archive")
    restore.add_argument("archive", help="Path or name of a backup archive")
    restore.add_argument("--yes", action="store_true", help="Do not ask for confirmation")
    restore.set_defaults(func=cmd_restore)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except AppError as exc:
        print(f"Error: {exc.message}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130

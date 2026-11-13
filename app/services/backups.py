"""Local backups: a consistent SQLite snapshot plus all uploaded files.

The database is copied with SQLite's online backup API, so a backup can be
taken while the application is running. Restoring replaces the live data and
is therefore only offered through the command line (with the server stopped).
"""

from __future__ import annotations

import json
import re
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app import __version__
from app.config import get_settings
from app.errors import NotFound, ValidationFailed

BACKUP_NAME_RE = re.compile(r"^minddock-backup-\d{8}-\d{6}(-\d+)?\.zip$")
_UPLOAD_MEMBER_RE = re.compile(r"^uploads/[0-9a-f]{2}/[0-9a-f]{32}$")
DB_MEMBER = "database.sqlite3"
MANIFEST_MEMBER = "manifest.json"
FORMAT_VERSION = 1


def _snapshot_database(source: Path, destination: Path) -> None:
    src = sqlite3.connect(source)
    try:
        dst = sqlite3.connect(destination)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _schema_revision(database: Path) -> str | None:
    connection = sqlite3.connect(database)
    try:
        row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None
    finally:
        connection.close()


def create_backup() -> Path:
    settings = get_settings()
    settings.ensure_directories()
    now = datetime.now(UTC)
    base = f"minddock-backup-{now:%Y%m%d-%H%M%S}"
    target = settings.backups_dir / f"{base}.zip"
    counter = 1
    while target.exists():
        counter += 1
        target = settings.backups_dir / f"{base}-{counter}.zip"

    with tempfile.TemporaryDirectory(prefix="backup-", dir=settings.temp_dir) as work:
        work_dir = Path(work)
        snapshot = work_dir / DB_MEMBER
        _snapshot_database(settings.database_path, snapshot)

        archive_path = work_dir / "archive.zip"
        file_count = 0
        total_bytes = 0
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            archive.write(snapshot, DB_MEMBER)
            for path in sorted(settings.uploads_dir.rglob("*")):
                if not path.is_file():
                    continue
                member = "uploads/" + path.relative_to(settings.uploads_dir).as_posix()
                if not _UPLOAD_MEMBER_RE.match(member):
                    continue
                # Most uploads are already compressed formats.
                archive.write(path, member, compress_type=zipfile.ZIP_STORED)
                file_count += 1
                total_bytes += path.stat().st_size
            manifest = {
                "format": FORMAT_VERSION,
                "app_version": __version__,
                "created_at": now.isoformat(),
                "schema_revision": _schema_revision(snapshot),
                "upload_count": file_count,
                "upload_bytes": total_bytes,
            }
            archive.writestr(MANIFEST_MEMBER, json.dumps(manifest, indent=2))
        shutil.move(str(archive_path), target)
    return target


def describe(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "created_at": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
    }


def list_backups() -> list[dict[str, Any]]:
    directory = get_settings().backups_dir
    if not directory.exists():
        return []
    items = [
        describe(path)
        for path in directory.iterdir()
        if path.is_file() and BACKUP_NAME_RE.match(path.name)
    ]
    return sorted(items, key=lambda item: item["name"], reverse=True)


def backup_path(name: str) -> Path:
    """Resolve a backup by name; the strict pattern rules out path tricks."""
    if not BACKUP_NAME_RE.match(name):
        raise NotFound("Backup not found")
    path = get_settings().backups_dir / name
    if not path.is_file():
        raise NotFound("Backup not found")
    return path


def delete_backup(name: str) -> None:
    backup_path(name).unlink()


def read_manifest(archive_path: Path) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            if DB_MEMBER not in names or MANIFEST_MEMBER not in names:
                raise ValidationFailed("Not a MindDock backup archive")
            manifest = json.loads(archive.read(MANIFEST_MEMBER))
    except (zipfile.BadZipFile, json.JSONDecodeError, OSError) as exc:
        raise ValidationFailed(f"Cannot read backup archive: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT_VERSION:
        raise ValidationFailed("Unsupported backup format")
    return manifest


def restore_backup(archive_path: Path) -> dict[str, Any]:
    """Replace the current database and uploads with the archive's content.

    The application must not be running. The data being replaced is moved to
    ``data/backups/pre-restore-<timestamp>/`` rather than deleted.
    """
    settings = get_settings()
    settings.ensure_directories()
    manifest = read_manifest(archive_path)

    with tempfile.TemporaryDirectory(prefix="restore-", dir=settings.temp_dir) as work:
        work_dir = Path(work)
        new_uploads = work_dir / "uploads"
        new_uploads.mkdir()
        with zipfile.ZipFile(archive_path) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                # Only known member names are extracted, to fixed locations.
                if info.filename == DB_MEMBER:
                    destination = work_dir / DB_MEMBER
                elif _UPLOAD_MEMBER_RE.match(info.filename):
                    destination = work_dir / info.filename
                else:
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, open(destination, "wb") as out:
                    shutil.copyfileobj(source, out)

        new_database = work_dir / DB_MEMBER
        connection = sqlite3.connect(new_database)
        try:
            result = connection.execute("PRAGMA integrity_check").fetchone()
        finally:
            connection.close()
        if not result or result[0] != "ok":
            raise ValidationFailed("The database inside the backup is corrupted")

        stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        previous = settings.backups_dir / f"pre-restore-{stamp}"
        previous.mkdir(parents=True, exist_ok=True)
        for suffix in ("", "-wal", "-shm"):
            current = Path(str(settings.database_path) + suffix)
            if current.exists():
                shutil.move(str(current), previous / current.name)
        if settings.uploads_dir.exists():
            shutil.move(str(settings.uploads_dir), previous / "uploads")

        shutil.move(str(new_database), settings.database_path)
        shutil.move(str(new_uploads), settings.uploads_dir)

    manifest["previous_data"] = str(previous)
    return manifest

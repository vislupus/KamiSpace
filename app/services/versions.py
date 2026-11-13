"""Document version history.

Invariant: after every save the newest version of a page equals its current
content. Autosaves by the same author inside ``version_interval_minutes`` are
folded into that newest version, so history grows by sessions rather than by
keystrokes. Restoring never rewrites history — it appends a new version.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import utcnow
from app.errors import NotFound
from app.models import Page, PageVersion, User

KIND_AUTO = "auto"
KIND_MANUAL = "manual"
KIND_RESTORE = "restore"


def latest_version(db: Session, page_id: int) -> PageVersion | None:
    return db.execute(
        select(PageVersion)
        .where(PageVersion.page_id == page_id)
        .order_by(PageVersion.number.desc())
        .limit(1)
    ).scalar_one_or_none()


def record_version(
    db: Session,
    page: Page,
    user: User,
    *,
    kind: str = KIND_AUTO,
    description: str | None = None,
    force_new: bool = False,
) -> PageVersion:
    """Snapshot the page's current state, folding into the newest version when allowed."""
    latest = latest_version(db, page.id)
    now = utcnow()
    window = timedelta(minutes=get_settings().version_interval_minutes)
    can_fold = (
        latest is not None
        and not force_new
        and kind == KIND_AUTO
        and latest.kind == KIND_AUTO
        and latest.author_id == user.id
        and now - latest.created_at < window
    )
    if can_fold:
        assert latest is not None
        latest.title = page.title
        latest.content = page.content
        latest.updated_at = now
        return latest

    version = PageVersion(
        page_id=page.id,
        number=(latest.number if latest else 0) + 1,
        title=page.title,
        content=page.content,
        author_id=user.id,
        kind=kind,
        description=description,
        created_at=now,
        updated_at=now,
    )
    db.add(version)
    db.flush()
    return version


def list_versions(db: Session, page_id: int) -> list[dict[str, Any]]:
    rows = db.execute(
        select(PageVersion, User.display_name)
        .outerjoin(User, User.id == PageVersion.author_id)
        .where(PageVersion.page_id == page_id)
        .order_by(PageVersion.number.desc())
    ).all()
    return [serialize_version(version, author) for version, author in rows]


def get_version(db: Session, page_id: int, version_id: int) -> PageVersion:
    version = db.get(PageVersion, version_id)
    if version is None or version.page_id != page_id:
        raise NotFound("Version not found")
    return version


def serialize_version(
    version: PageVersion, author_name: str | None, *, with_content: bool = False
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": version.id,
        "number": version.number,
        "title": version.title,
        "kind": version.kind,
        "description": version.description,
        "author_id": version.author_id,
        "author_name": author_name or "Deleted user",
        "created_at": version.created_at.isoformat(),
        "updated_at": version.updated_at.isoformat(),
    }
    if with_content:
        data["content"] = version.content
    return data


def author_name(db: Session, version: PageVersion) -> str | None:
    if version.author_id is None:
        return None
    return db.execute(
        select(User.display_name).where(User.id == version.author_id)
    ).scalar_one_or_none()


def count_versions(db: Session, page_id: int) -> int:
    return db.execute(
        select(func.count()).select_from(PageVersion).where(PageVersion.page_id == page_id)
    ).scalar_one()

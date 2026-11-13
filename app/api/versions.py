"""Version history of a page."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.deps import Db, UserAccess
from app.models import ROLE_EDITOR, ROLE_VIEWER
from app.schemas import VersionCreateIn
from app.services import pages, versions

router = APIRouter(prefix="/pages/{page_id}/versions", tags=["versions"])


@router.get("")
def list_versions(page_id: int, access: UserAccess, db: Db) -> list[dict[str, Any]]:
    page = access.require_page(page_id, ROLE_VIEWER, allow_deleted=True)
    return versions.list_versions(db, page.id)


@router.post("", status_code=201)
def create_version(
    page_id: int, body: VersionCreateIn, access: UserAccess, db: Db
) -> dict[str, Any]:
    """Save a named snapshot of the page as it is right now."""
    page = access.require_page(page_id, ROLE_EDITOR)
    description = " ".join((body.description or "").split()) or None
    version = versions.record_version(
        db,
        page,
        access.user,
        kind=versions.KIND_MANUAL,
        description=description,
        force_new=True,
    )
    db.commit()
    return versions.serialize_version(version, access.user.display_name)


@router.get("/{version_id}")
def get_version(page_id: int, version_id: int, access: UserAccess, db: Db) -> dict[str, Any]:
    page = access.require_page(page_id, ROLE_VIEWER, allow_deleted=True)
    version = versions.get_version(db, page.id, version_id)
    return versions.serialize_version(version, versions.author_name(db, version), with_content=True)


@router.post("/{version_id}/restore")
def restore_version(page_id: int, version_id: int, access: UserAccess, db: Db) -> dict[str, Any]:
    page = pages.restore_version(db, access, page_id, version_id)
    db.commit()
    return pages.page_detail(db, access, page)

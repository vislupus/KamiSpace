"""Pages: create, read, update, move, duplicate, favourite."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.db import session_scope
from app.deps import Db, UserAccess
from app.models import ROLE_VIEWER
from app.schemas import ContentSaveIn, PageCreateIn, PageMetaIn, PageMoveIn
from app.services import pages

router = APIRouter(prefix="/pages", tags=["pages"])


@router.post("", status_code=201)
def create_page(body: PageCreateIn, access: UserAccess, db: Db) -> dict[str, Any]:
    page = pages.create_page(
        db,
        access,
        workspace_id=body.workspace_id,
        parent_id=body.parent_id,
        title=body.title,
        icon=body.icon,
        content=body.content,
    )
    db.commit()
    return pages.page_detail(db, access, page)


@router.get("/{page_id}")
def get_page(page_id: int, access: UserAccess, db: Db) -> dict[str, Any]:
    page = access.require_page(page_id, ROLE_VIEWER, allow_deleted=True)
    detail = pages.page_detail(db, access, page)
    if page.deleted_at is None:
        with session_scope() as write:
            pages.record_visit(write, access.user, page.id)
    return detail


@router.patch("/{page_id}")
def update_page(page_id: int, body: PageMetaIn, access: UserAccess, db: Db) -> dict[str, Any]:
    page = pages.update_meta(db, access, page_id, fields=body.model_dump(exclude_unset=True))
    db.commit()
    return {
        **pages.serialize_meta(page, access.page_role(page.id)),
        "cover_attachment_id": page.cover_attachment_id,
        "updated_at": page.updated_at.isoformat(),
    }


@router.put("/{page_id}/content")
def save_content(page_id: int, body: ContentSaveIn, access: UserAccess, db: Db) -> dict[str, Any]:
    page, version_number = pages.save_content(
        db,
        access,
        page_id,
        content=body.content,
        base_revision=body.base_revision,
        force=body.force,
    )
    db.commit()
    return {
        "revision": page.revision,
        "updated_at": page.updated_at.isoformat(),
        "version_number": version_number,
    }


@router.post("/{page_id}/move")
def move_page(page_id: int, body: PageMoveIn, access: UserAccess, db: Db) -> dict[str, Any]:
    page = pages.move_page(
        db,
        access,
        page_id,
        parent_id=body.parent_id,
        workspace_id=body.workspace_id,
        before_id=body.before_id,
        after_id=body.after_id,
    )
    db.commit()
    return pages.serialize_meta(page, access.page_role(page.id))


@router.post("/{page_id}/duplicate", status_code=201)
def duplicate_page(page_id: int, access: UserAccess, db: Db) -> dict[str, Any]:
    page = pages.duplicate_page(db, access, page_id)
    db.commit()
    return pages.serialize_meta(page, access.page_role(page.id))


@router.delete("/{page_id}")
def trash_page(page_id: int, access: UserAccess, db: Db) -> dict[str, Any]:
    trashed = pages.trash_page(db, access, page_id)
    db.commit()
    return {"trashed": trashed}


@router.put("/{page_id}/favorite")
def add_favorite(page_id: int, access: UserAccess, db: Db) -> dict[str, bool]:
    pages.set_favorite(db, access, page_id, True)
    db.commit()
    return {"favorite": True}


@router.delete("/{page_id}/favorite")
def remove_favorite(page_id: int, access: UserAccess, db: Db) -> dict[str, bool]:
    pages.set_favorite(db, access, page_id, False)
    db.commit()
    return {"favorite": False}

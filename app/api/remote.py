"""Requests the server makes to the web on a user's behalf."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.deps import CurrentUser, Db, UserAccess
from app.models import ROLE_EDITOR
from app.schemas import UrlIn
from app.services import files, remote

router = APIRouter(tags=["remote"])


@router.post("/bookmarks")
def bookmark(body: UrlIn, user: CurrentUser) -> dict[str, Any]:
    """Look up the title and description of a web page for a bookmark block."""
    return remote.bookmark_preview(body.url.strip())


@router.post("/pages/{page_id}/files/remote", status_code=201)
def import_remote_image(page_id: int, body: UrlIn, access: UserAccess, db: Db) -> dict[str, Any]:
    """Copy an image from the web into the page (used when pasting web content)."""
    page = access.require_page(page_id, ROLE_EDITOR)
    attachment = remote.import_image(db, access.user, page.id, body.url.strip())
    try:
        db.commit()
    except Exception:
        files.unlink_files([files.storage_path(attachment.storage_name)])
        raise
    return files.serialize_attachment(attachment)

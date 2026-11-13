"""Recycle bin."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from app.deps import Db, UserAccess, client_ip
from app.services import audit, files, pages

router = APIRouter(prefix="/trash", tags=["trash"])


@router.get("")
def list_trash(access: UserAccess, db: Db) -> list[dict[str, Any]]:
    return pages.list_trash(db, access)


@router.post("/{page_id}/restore")
def restore(page_id: int, access: UserAccess, db: Db) -> dict[str, Any]:
    page = pages.restore_page(db, access, page_id)
    db.commit()
    return pages.serialize_meta(page, access.page_role(page.id))


@router.delete("/{page_id}")
def purge(page_id: int, request: Request, access: UserAccess, db: Db) -> dict[str, bool]:
    orphaned = pages.purge_page(db, access, page_id)
    audit.record(
        db,
        "page.purged",
        user=access.user,
        target_type="page",
        target_id=page_id,
        ip=client_ip(request),
    )
    db.commit()
    files.unlink_files(orphaned)
    return {"ok": True}


@router.delete("")
def empty(request: Request, access: UserAccess, db: Db) -> dict[str, int]:
    count, orphaned = pages.empty_trash(db, access)
    audit.record(
        db, "trash.emptied", user=access.user, detail={"count": count}, ip=client_ip(request)
    )
    db.commit()
    files.unlink_files(orphaned)
    return {"purged": count}

"""Per-page sharing with specific users."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from app.deps import Db, UserAccess, client_ip
from app.models import ROLE_VIEWER
from app.schemas import ShareIn
from app.services import audit, sharing

router = APIRouter(prefix="/pages/{page_id}/shares", tags=["sharing"])


@router.get("")
def list_shares(page_id: int, access: UserAccess, db: Db) -> dict[str, Any]:
    page = access.require_page(page_id, ROLE_VIEWER)
    return sharing.list_shares(db, access, page)


@router.put("/{user_id}")
def set_share(
    page_id: int, user_id: int, body: ShareIn, request: Request, access: UserAccess, db: Db
) -> dict[str, Any]:
    sharing.set_share(db, access, page_id, user_id, body.role)
    audit.record(
        db,
        "page.shared",
        user=access.user,
        target_type="page",
        target_id=page_id,
        detail={"user_id": user_id, "role": body.role},
        ip=client_ip(request),
    )
    db.commit()
    page = access.require_page(page_id, ROLE_VIEWER)
    return sharing.list_shares(db, access, page)


@router.delete("/{user_id}")
def remove_share(
    page_id: int, user_id: int, request: Request, access: UserAccess, db: Db
) -> dict[str, Any]:
    sharing.remove_share(db, access, page_id, user_id)
    audit.record(
        db,
        "page.unshared",
        user=access.user,
        target_type="page",
        target_id=page_id,
        detail={"user_id": user_id},
        ip=client_ip(request),
    )
    db.commit()
    page = access.require_page(page_id, ROLE_VIEWER)
    return sharing.list_shares(db, access, page)

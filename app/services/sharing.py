"""Sharing a page with specific users."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.errors import NotFound, ValidationFailed
from app.models import (
    ROLE_EDITOR,
    ROLE_OWNER,
    ROLE_VIEWER,
    Page,
    PagePermission,
    User,
    Workspace,
    WorkspaceMember,
)
from app.services.permissions import Access

SHAREABLE_ROLES = (ROLE_VIEWER, ROLE_EDITOR)


def list_shares(db: Session, access: Access, page: Page) -> dict[str, Any]:
    """Who can open this page: direct grants, inherited grants and the workspace."""
    chain_ids = [page.id]
    seen = {page.id}
    parent_id = page.parent_id
    while parent_id is not None and parent_id not in seen:
        seen.add(parent_id)
        chain_ids.append(parent_id)
        parent_id = db.execute(
            select(Page.parent_id).where(Page.id == parent_id)
        ).scalar_one_or_none()

    rows = db.execute(
        select(PagePermission, User, Page.title)
        .join(User, User.id == PagePermission.user_id)
        .join(Page, Page.id == PagePermission.page_id)
        .where(PagePermission.page_id.in_(chain_ids))
        .order_by(func.lower(User.display_name))
    ).all()
    direct, inherited = [], []
    for grant, user, source_title in rows:
        entry = {
            "user_id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "role": grant.role,
        }
        if grant.page_id == page.id:
            direct.append(entry)
        else:
            inherited.append(
                {**entry, "from_page_id": grant.page_id, "from_title": source_title or "Untitled"}
            )

    workspace = db.get(Workspace, page.workspace_id)
    member_count = db.execute(
        select(func.count())
        .select_from(WorkspaceMember)
        .where(WorkspaceMember.workspace_id == page.workspace_id)
    ).scalar_one()
    return {
        "direct": direct,
        "inherited": inherited,
        "workspace": {
            "id": page.workspace_id,
            "name": workspace.name if workspace else "",
            "kind": workspace.kind if workspace else "",
            "member_count": member_count,
        },
        "can_manage": access.can_manage(page.id),
    }


def set_share(db: Session, access: Access, page_id: int, user_id: int, role: str) -> None:
    page = access.require_page(page_id, ROLE_OWNER)
    if role not in SHAREABLE_ROLES:
        raise ValidationFailed("Role must be 'viewer' or 'editor'")
    if user_id == access.user.id:
        raise ValidationFailed("You already have access to this page")
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise NotFound("User not found")
    grant = db.execute(
        select(PagePermission).where(
            PagePermission.page_id == page.id, PagePermission.user_id == user_id
        )
    ).scalar_one_or_none()
    if grant is None:
        db.add(
            PagePermission(page_id=page.id, user_id=user_id, role=role, granted_by=access.user.id)
        )
    else:
        grant.role = role
    db.flush()


def remove_share(db: Session, access: Access, page_id: int, user_id: int) -> None:
    page = access.require_page(page_id, ROLE_OWNER)
    grant = db.execute(
        select(PagePermission).where(
            PagePermission.page_id == page.id, PagePermission.user_id == user_id
        )
    ).scalar_one_or_none()
    if grant is None:
        raise NotFound("This user has no direct access to the page")
    db.delete(grant)
    db.flush()


def user_directory(db: Session, query: str, limit: int = 12) -> list[dict[str, Any]]:
    """Active colleagues matching a name, for the share and member pickers."""
    statement = select(User).where(User.is_active)
    query = query.strip().lower()
    if query:
        # Names only: matching on email would let anyone probe addresses.
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        statement = statement.where(
            or_(
                func.lower(User.display_name).like(like, escape="\\"),
                User.username.like(like, escape="\\"),
            )
        )
    rows = db.execute(statement.order_by(func.lower(User.display_name)).limit(limit)).scalars()
    return [
        {"id": user.id, "username": user.username, "display_name": user.display_name}
        for user in rows
    ]

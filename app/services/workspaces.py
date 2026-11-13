"""Team workspaces and their members."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.models import (
    ROLE_OWNER,
    ROLES,
    WORKSPACE_PERSONAL,
    WORKSPACE_TEAM,
    Page,
    User,
    Workspace,
    WorkspaceMember,
)
from app.services import pages
from app.services.permissions import Access


def clean_name(name: str) -> str:
    name = " ".join(name.split())[:120]
    if not name:
        raise ValidationFailed("Workspace name is required")
    return name


def serialize_workspace(workspace: Workspace, role: str | None) -> dict[str, Any]:
    return {
        "id": workspace.id,
        "name": workspace.name,
        "kind": workspace.kind,
        "role": role,
    }


def list_for_user(db: Session, access: Access) -> list[dict[str, Any]]:
    if not access.memberships:
        return []
    rows = db.execute(
        select(Workspace)
        .where(Workspace.id.in_(access.memberships.keys()))
        .order_by(Workspace.kind, func.lower(Workspace.name), Workspace.id)
    ).scalars()
    return [serialize_workspace(ws, access.memberships[ws.id]) for ws in rows]


def list_all_teams(db: Session, access: Access) -> list[dict[str, Any]]:
    """Team workspaces for the administration screen (no page content)."""
    rows = db.execute(
        select(Workspace, func.count(WorkspaceMember.user_id))
        .outerjoin(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(Workspace.kind == WORKSPACE_TEAM)
        .group_by(Workspace.id)
        .order_by(func.lower(Workspace.name))
    ).all()
    return [
        {**serialize_workspace(ws, access.memberships.get(ws.id)), "member_count": count}
        for ws, count in rows
    ]


def create_team(db: Session, user: User, name: str) -> Workspace:
    if not user.is_admin:
        raise Forbidden("Only administrators can create team workspaces")
    workspace = Workspace(name=clean_name(name), kind=WORKSPACE_TEAM, owner_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=ROLE_OWNER))
    db.flush()
    return workspace


def require_manageable(db: Session, access: Access, workspace_id: int) -> Workspace:
    """Workspace owners and application administrators manage team workspaces.

    Managing membership does not by itself give an administrator access to the
    pages; they would have to add themselves as a member, which is audited.
    """
    workspace = db.get(Workspace, workspace_id)
    is_owner = access.workspace_role(workspace_id) == ROLE_OWNER
    if workspace is None or not (is_owner or access.user.is_admin):
        raise NotFound("Workspace not found")
    if workspace.kind == WORKSPACE_PERSONAL and not is_owner:
        raise NotFound("Workspace not found")
    return workspace


def require_team(workspace: Workspace) -> None:
    if workspace.kind != WORKSPACE_TEAM:
        raise Conflict("Personal workspaces cannot be shared, renamed or deleted")


def list_members(db: Session, workspace_id: int) -> list[dict[str, Any]]:
    rows = db.execute(
        select(WorkspaceMember, User)
        .join(User, User.id == WorkspaceMember.user_id)
        .where(WorkspaceMember.workspace_id == workspace_id)
        .order_by(func.lower(User.display_name))
    ).all()
    return [
        {
            "user_id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "is_active": user.is_active,
            "role": member.role,
        }
        for member, user in rows
    ]


def _owner_count(db: Session, workspace_id: int, *, excluding: int) -> int:
    return db.execute(
        select(func.count())
        .select_from(WorkspaceMember)
        .where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.role == ROLE_OWNER,
            WorkspaceMember.user_id != excluding,
        )
    ).scalar_one()


def set_member(db: Session, workspace: Workspace, user_id: int, role: str) -> None:
    require_team(workspace)
    if role not in ROLES:
        raise ValidationFailed("Unknown role")
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise NotFound("User not found")
    member = db.get(WorkspaceMember, (workspace.id, user_id))
    if member is None:
        db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user_id, role=role))
    else:
        if (
            member.role == ROLE_OWNER
            and role != ROLE_OWNER
            and _owner_count(db, workspace.id, excluding=user_id) == 0
        ):
            raise Conflict("A workspace needs at least one owner")
        member.role = role
    db.flush()


def remove_member(db: Session, workspace: Workspace, user_id: int) -> None:
    require_team(workspace)
    member = db.get(WorkspaceMember, (workspace.id, user_id))
    if member is None:
        raise NotFound("Member not found")
    if member.role == ROLE_OWNER and _owner_count(db, workspace.id, excluding=user_id) == 0:
        raise Conflict("A workspace needs at least one owner")
    db.delete(member)
    db.flush()


def delete_workspace(db: Session, workspace: Workspace) -> list[Path]:
    """Delete a team workspace with all its pages. Returns files to unlink."""
    require_team(workspace)
    root_ids = list(
        db.execute(
            select(Page.id).where(Page.workspace_id == workspace.id, Page.parent_id.is_(None))
        ).scalars()
    )
    paths = pages.purge_pages(db, root_ids)
    db.delete(workspace)
    db.flush()
    return paths

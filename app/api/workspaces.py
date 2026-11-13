"""Team workspaces and membership."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from app.deps import CurrentUser, Db, UserAccess, client_ip
from app.schemas import MemberIn, WorkspaceIn
from app.services import audit, files, workspaces

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


@router.get("")
def list_workspaces(access: UserAccess, db: Db) -> list[dict[str, Any]]:
    return workspaces.list_for_user(db, access)


@router.post("", status_code=201)
def create_workspace(
    body: WorkspaceIn, request: Request, user: CurrentUser, db: Db
) -> dict[str, Any]:
    workspace = workspaces.create_team(db, user, body.name)
    audit.record(
        db,
        "workspace.created",
        user=user,
        target_type="workspace",
        target_id=workspace.id,
        detail={"name": workspace.name},
        ip=client_ip(request),
    )
    db.commit()
    return workspaces.serialize_workspace(workspace, "owner")


@router.patch("/{workspace_id}")
def rename_workspace(
    workspace_id: int, body: WorkspaceIn, access: UserAccess, db: Db
) -> dict[str, Any]:
    workspace = workspaces.require_manageable(db, access, workspace_id)
    workspaces.require_team(workspace)
    workspace.name = workspaces.clean_name(body.name)
    db.commit()
    return workspaces.serialize_workspace(workspace, access.workspace_role(workspace.id))


@router.delete("/{workspace_id}")
def delete_workspace(
    workspace_id: int, request: Request, access: UserAccess, db: Db
) -> dict[str, bool]:
    workspace = workspaces.require_manageable(db, access, workspace_id)
    name = workspace.name
    orphaned = workspaces.delete_workspace(db, workspace)
    audit.record(
        db,
        "workspace.deleted",
        user=access.user,
        target_type="workspace",
        target_id=workspace_id,
        detail={"name": name},
        ip=client_ip(request),
    )
    db.commit()
    files.unlink_files(orphaned)
    return {"ok": True}


@router.get("/{workspace_id}/members")
def list_members(workspace_id: int, access: UserAccess, db: Db) -> list[dict[str, Any]]:
    if access.workspace_role(workspace_id) is None:
        workspaces.require_manageable(db, access, workspace_id)
    return workspaces.list_members(db, workspace_id)


@router.put("/{workspace_id}/members/{user_id}")
def set_member(
    workspace_id: int,
    user_id: int,
    body: MemberIn,
    request: Request,
    access: UserAccess,
    db: Db,
) -> list[dict[str, Any]]:
    workspace = workspaces.require_manageable(db, access, workspace_id)
    workspaces.set_member(db, workspace, user_id, body.role)
    audit.record(
        db,
        "workspace.member_set",
        user=access.user,
        target_type="workspace",
        target_id=workspace_id,
        detail={"user_id": user_id, "role": body.role},
        ip=client_ip(request),
    )
    db.commit()
    return workspaces.list_members(db, workspace_id)


@router.delete("/{workspace_id}/members/{user_id}")
def remove_member(
    workspace_id: int, user_id: int, request: Request, access: UserAccess, db: Db
) -> list[dict[str, Any]]:
    workspace = workspaces.require_manageable(db, access, workspace_id)
    workspaces.remove_member(db, workspace, user_id)
    audit.record(
        db,
        "workspace.member_removed",
        user=access.user,
        target_type="workspace",
        target_id=workspace_id,
        detail={"user_id": user_id},
        ip=client_ip(request),
    )
    db.commit()
    return workspaces.list_members(db, workspace_id)

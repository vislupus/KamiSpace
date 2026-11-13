"""Administration: users, invitations, settings, backups, audit log.

Nothing in here returns page content. Administrators manage the application,
not other people's notes.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, select

from app.db import utcnow
from app.deps import AdminUser, Db, UserAccess, client_ip
from app.errors import Conflict, NotFound
from app.models import AuditEvent, Invite, User, UserSession
from app.schemas import AppSettingsIn, InviteIn, PasswordResetIn, UserCreateIn, UserUpdateIn
from app.services import audit, auth, backups, workspaces

router = APIRouter(prefix="/admin", tags=["admin"])


# -- users -------------------------------------------------------------------


@router.get("/users")
def list_users(admin: AdminUser, db: Db) -> list[dict[str, Any]]:
    rows = db.execute(select(User).order_by(func.lower(User.display_name))).scalars()
    return [auth.serialize_user(user, private=True) for user in rows]


@router.post("/users", status_code=201)
def create_user(body: UserCreateIn, request: Request, admin: AdminUser, db: Db) -> dict[str, Any]:
    user = auth.create_user(
        db,
        username=body.username,
        email=body.email,
        password=body.password,
        display_name=body.display_name,
        is_admin=body.is_admin,
    )
    audit.record(
        db,
        "user.created",
        user=admin,
        target_type="user",
        target_id=user.id,
        detail={"username": user.username, "is_admin": user.is_admin},
        ip=client_ip(request),
    )
    db.commit()
    return auth.serialize_user(user, private=True)


def _get_user(db: Db, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise NotFound("User not found")
    return user


@router.patch("/users/{user_id}")
def update_user(
    user_id: int, body: UserUpdateIn, request: Request, admin: AdminUser, db: Db
) -> dict[str, Any]:
    user = _get_user(db, user_id)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)

    loses_admin = changes.get("is_admin") is False and user.is_admin
    deactivated = changes.get("is_active") is False and user.is_active
    if (loses_admin or (deactivated and user.is_admin)) and auth.count_active_admins(
        db, excluding=user.id
    ) == 0:
        raise Conflict("The last active administrator cannot be demoted or deactivated")

    if "display_name" in changes:
        user.display_name = auth.clean_display_name(changes["display_name"], user.username)
    if "email" in changes:
        email = auth.normalize_email(changes["email"])
        taken = db.execute(select(User.id).where(User.email == email, User.id != user.id)).first()
        if taken:
            raise Conflict("This email address is already in use")
        user.email = email
    if "is_admin" in changes:
        user.is_admin = changes["is_admin"]
    if "is_active" in changes:
        user.is_active = changes["is_active"]
        if deactivated:
            db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    audit.record(
        db,
        "user.updated",
        user=admin,
        target_type="user",
        target_id=user.id,
        detail={k: v for k, v in changes.items() if k in ("is_admin", "is_active")},
        ip=client_ip(request),
    )
    db.commit()
    return auth.serialize_user(user, private=True)


@router.post("/users/{user_id}/password")
def reset_password(
    user_id: int, body: PasswordResetIn, request: Request, admin: AdminUser, db: Db
) -> dict[str, bool]:
    user = _get_user(db, user_id)
    auth.set_password(db, user, body.password)
    audit.record(
        db,
        "user.password_reset",
        user=admin,
        target_type="user",
        target_id=user.id,
        ip=client_ip(request),
    )
    db.commit()
    return {"ok": True}


# -- invitations -------------------------------------------------------------


def _serialize_invite(invite: Invite) -> dict[str, Any]:
    return {
        "id": invite.id,
        "email": invite.email,
        "is_admin": invite.is_admin,
        "created_at": invite.created_at.isoformat(),
        "expires_at": invite.expires_at.isoformat(),
    }


@router.get("/invites")
def list_invites(admin: AdminUser, db: Db) -> list[dict[str, Any]]:
    rows = db.execute(
        select(Invite)
        .where(Invite.used_at.is_(None), Invite.expires_at > utcnow())
        .order_by(Invite.created_at.desc())
    ).scalars()
    return [_serialize_invite(invite) for invite in rows]


@router.post("/invites", status_code=201)
def create_invite(body: InviteIn, request: Request, admin: AdminUser, db: Db) -> dict[str, Any]:
    invite, token = auth.create_invite(db, admin, email=body.email, is_admin=body.is_admin)
    audit.record(
        db,
        "invite.created",
        user=admin,
        target_type="invite",
        target_id=invite.id,
        detail={"email": invite.email, "is_admin": invite.is_admin},
        ip=client_ip(request),
    )
    db.commit()
    # The token is only ever shown once, as part of the link to hand over.
    return {**_serialize_invite(invite), "token": token, "path": f"/register?invite={token}"}


@router.delete("/invites/{invite_id}")
def revoke_invite(invite_id: int, admin: AdminUser, db: Db) -> dict[str, bool]:
    invite = db.get(Invite, invite_id)
    if invite is None:
        raise NotFound("Invitation not found")
    db.delete(invite)
    db.commit()
    return {"ok": True}


# -- settings ----------------------------------------------------------------


@router.get("/settings")
def get_settings(admin: AdminUser, db: Db) -> dict[str, Any]:
    return auth.get_app_settings(db)


@router.put("/settings")
def update_settings(
    body: AppSettingsIn, request: Request, admin: AdminUser, db: Db
) -> dict[str, Any]:
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    values = auth.update_app_settings(db, changes)
    audit.record(db, "settings.updated", user=admin, detail=changes, ip=client_ip(request))
    db.commit()
    return values


# -- workspaces --------------------------------------------------------------


@router.get("/workspaces")
def list_team_workspaces(admin: AdminUser, access: UserAccess, db: Db) -> list[dict[str, Any]]:
    return workspaces.list_all_teams(db, access)


# -- backups -----------------------------------------------------------------


@router.get("/backups")
def list_backups(admin: AdminUser) -> list[dict[str, Any]]:
    return backups.list_backups()


@router.post("/backups", status_code=201)
def create_backup(request: Request, admin: AdminUser, db: Db) -> dict[str, Any]:
    # End this request's transaction first: the snapshot must not wait on it.
    db.rollback()
    path = backups.create_backup()
    audit.record(
        db, "backup.created", user=admin, detail={"name": path.name}, ip=client_ip(request)
    )
    db.commit()
    return backups.describe(path)


@router.get("/backups/{name}")
def download_backup(name: str, request: Request, admin: AdminUser, db: Db) -> FileResponse:
    path = backups.backup_path(name)
    db.close()
    return FileResponse(
        path,
        media_type="application/zip",
        filename=path.name,
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/backups/{name}")
def delete_backup(name: str, request: Request, admin: AdminUser, db: Db) -> dict[str, bool]:
    backups.delete_backup(name)
    audit.record(db, "backup.deleted", user=admin, detail={"name": name}, ip=client_ip(request))
    db.commit()
    return {"ok": True}


# -- audit log ---------------------------------------------------------------


@router.get("/audit")
def audit_log(
    admin: AdminUser, db: Db, limit: int = Query(default=100, ge=1, le=500)
) -> list[dict[str, Any]]:
    rows = db.execute(
        select(AuditEvent, User.display_name)
        .outerjoin(User, User.id == AuditEvent.user_id)
        .order_by(AuditEvent.id.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": event.id,
            "action": event.action,
            "user_name": name,
            "target_type": event.target_type,
            "target_id": event.target_id,
            "detail": event.detail,
            "ip": event.ip,
            "created_at": event.created_at.isoformat(),
        }
        for event, name in rows
    ]

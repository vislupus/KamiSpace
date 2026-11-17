"""The signed-in user's own account."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.deps import CurrentSession, CurrentUser, Db
from app.errors import Forbidden
from app.schemas import AccountUpdateIn, PasswordChangeIn
from app.security import verify_password
from app.services import audit, auth

router = APIRouter(prefix="/account", tags=["account"])


@router.patch("")
def update_account(body: AccountUpdateIn, user: CurrentUser, db: Db) -> dict[str, Any]:
    """Change your own username (it is also what you sign in with)."""
    previous = user.username
    auth.rename_user(db, user, body.username)
    if user.username != previous:
        audit.record(
            db, "account.renamed", user=user, detail={"from": previous, "to": user.username}
        )
    db.commit()
    return auth.serialize_user(user, private=True)


@router.post("/password")
def change_password(body: PasswordChangeIn, session: CurrentSession, db: Db) -> dict[str, bool]:
    user = session.user
    if not verify_password(user.password_hash, body.current_password):
        raise Forbidden("Your current password is incorrect")
    auth.set_password(db, user, body.new_password, keep_session_id=session.id)
    audit.record(db, "account.password_changed", user=user)
    db.commit()
    return {"ok": True}


@router.get("/sessions")
def sessions(session: CurrentSession, db: Db) -> list[dict[str, Any]]:
    return auth.list_sessions(db, session.user, session.id)


@router.delete("/sessions/{session_id}")
def revoke(session_id: int, session: CurrentSession, db: Db) -> dict[str, bool]:
    auth.revoke_session(db, session_id, session.user)
    db.commit()
    return {"ok": True}

"""Sign-in, sign-out and registration."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response

from app.config import get_settings
from app.db import session_scope
from app.deps import CurrentSession, Db, client_ip
from app.errors import Unauthorized
from app.models import UserSession
from app.schemas import LoginIn, RegisterIn
from app.services import audit, auth

router = APIRouter(prefix="/auth", tags=["auth"])


def _cookie_secure(request: Request) -> bool:
    mode = get_settings().cookie_secure
    if mode == "always":
        return True
    if mode == "never":
        return False
    return request.url.scheme == "https"


def set_session_cookie(request: Request, response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_max_days * 24 * 3600,
        httponly=True,
        secure=_cookie_secure(request),
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(get_settings().session_cookie_name, path="/")


def _start_session(request: Request, response: Response, db: Db, user) -> UserSession:
    session, token = auth.create_session(
        db, user, ip=client_ip(request), user_agent=request.headers.get("user-agent")
    )
    set_session_cookie(request, response, token)
    return session


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Db) -> dict[str, Any]:
    ip = client_ip(request)
    user = auth.authenticate(db, body.identifier, body.password, ip)
    if user is None:
        db.rollback()
        # Persist the failed attempt independently of this request's outcome.
        with session_scope() as attempts:
            auth.register_failed_login(attempts, body.identifier.strip().lower(), ip)
            audit.record(
                attempts, "auth.login_failed", detail={"identifier": body.identifier[:64]}, ip=ip
            )
        raise Unauthorized("Incorrect username or password")
    session = _start_session(request, response, db, user)
    audit.record(db, "auth.login", user=user, ip=ip)
    db.commit()
    return {"user": auth.serialize_user(user, private=True), "csrf_token": session.csrf_token}


@router.post("/logout")
def logout(session: CurrentSession, response: Response, db: Db) -> dict[str, bool]:
    audit.record(db, "auth.logout", user=session.user)
    db.delete(session)
    db.commit()
    clear_session_cookie(response)
    return {"ok": True}


@router.get("/registration")
def registration_status(db: Db, invite: str | None = None) -> dict[str, Any]:
    found = auth.find_valid_invite(db, invite)
    return {
        "open": bool(auth.get_app_settings(db)[auth.SETTING_ALLOW_REGISTRATION]),
        "invite_valid": found is not None,
        "invite_email": found.email if found else None,
    }


@router.post("/register")
def register(body: RegisterIn, request: Request, response: Response, db: Db) -> dict[str, Any]:
    user = auth.register(
        db,
        username=body.username,
        email=body.email,
        password=body.password,
        display_name=body.display_name,
        invite_token=body.invite,
    )
    session = _start_session(request, response, db, user)
    audit.record(db, "auth.register", user=user, ip=client_ip(request))
    db.commit()
    return {"user": auth.serialize_user(user, private=True), "csrf_token": session.csrf_token}

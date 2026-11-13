"""FastAPI dependencies: database session, authentication, CSRF."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import new_session, session_scope, utcnow
from app.errors import Forbidden, Unauthorized
from app.models import User, UserSession
from app.security import constant_time_equals
from app.services import auth
from app.services.permissions import Access

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_HEADER = "x-csrf-token"


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def get_db(request: Request) -> Iterator[Session]:
    """One session per request. GET requests run in a read-only transaction.

    Route handlers commit explicitly; anything left uncommitted is rolled back.
    """
    session = new_session(read_only=request.method in SAFE_METHODS)
    try:
        yield session
    finally:
        session.close()


Db = Annotated[Session, Depends(get_db)]


def _touch_session(session_id: int) -> None:
    """Sliding expiration, written in its own short transaction."""
    with session_scope() as db:
        row = db.get(UserSession, session_id)
        if row is not None:
            row.last_seen_at = utcnow()


def get_optional_session(request: Request, db: Db) -> UserSession | None:
    token = request.cookies.get(get_settings().session_cookie_name, "")
    session = auth.find_session(db, token)
    if session is None:
        return None
    if utcnow() - session.last_seen_at > auth.SESSION_TOUCH_INTERVAL:
        if request.method in SAFE_METHODS:
            _touch_session(session.id)
        else:
            session.last_seen_at = utcnow()
    return session


def get_current_session(
    request: Request, session: Annotated[UserSession | None, Depends(get_optional_session)]
) -> UserSession:
    if session is None:
        raise Unauthorized()
    if request.method not in SAFE_METHODS:
        supplied = request.headers.get(CSRF_HEADER, "")
        if not supplied or not constant_time_equals(supplied, session.csrf_token):
            raise Forbidden("Missing or invalid CSRF token")
    return session


CurrentSession = Annotated[UserSession, Depends(get_current_session)]


def get_current_user(session: CurrentSession) -> User:
    return session.user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise Forbidden("Administrator access required")
    return user


AdminUser = Annotated[User, Depends(get_admin)]


def get_access(db: Db, user: CurrentUser) -> Access:
    return Access(db, user)


UserAccess = Annotated[Access, Depends(get_access)]

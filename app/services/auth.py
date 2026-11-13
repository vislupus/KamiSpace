"""Accounts, sessions, invitations and login rate limiting."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import utcnow
from app.errors import Conflict, Forbidden, NotFound, TooManyRequests, ValidationFailed
from app.models import (
    ROLE_OWNER,
    WORKSPACE_PERSONAL,
    Invite,
    LoginAttempt,
    Setting,
    User,
    UserSession,
    Workspace,
    WorkspaceMember,
)
from app.security import (
    hash_password,
    hash_token,
    new_token,
    password_needs_rehash,
    verify_password,
)

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$|^[a-z0-9]{2,3}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 256
SESSION_TOUCH_INTERVAL = timedelta(minutes=5)
INVITE_VALID_DAYS = 7

SETTING_ALLOW_REGISTRATION = "allow_registration"
DEFAULT_SETTINGS: dict[str, Any] = {SETTING_ALLOW_REGISTRATION: False}


# -- settings ----------------------------------------------------------------


def get_app_settings(db: Session) -> dict[str, Any]:
    values = dict(DEFAULT_SETTINGS)
    for row in db.execute(select(Setting)).scalars():
        if row.key in values:
            values[row.key] = row.value
    return values


def update_app_settings(db: Session, changes: dict[str, Any]) -> dict[str, Any]:
    for key, value in changes.items():
        if key not in DEFAULT_SETTINGS:
            continue
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
    db.flush()
    return get_app_settings(db)


# -- validation --------------------------------------------------------------


def normalize_username(username: str) -> str:
    username = username.strip().lower()
    if not USERNAME_RE.match(username):
        raise ValidationFailed(
            "Username must be 2–64 characters: lowercase letters, digits, dots, "
            "dashes or underscores"
        )
    return username


def normalize_email(email: str) -> str:
    email = email.strip().lower()
    if len(email) > 254 or not EMAIL_RE.match(email):
        raise ValidationFailed("Enter a valid email address")
    return email


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValidationFailed(f"Password must be at least {MIN_PASSWORD_LENGTH} characters long")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise ValidationFailed("Password is too long")


def clean_display_name(name: str, fallback: str) -> str:
    return " ".join(name.split())[:120] or fallback


# -- users -------------------------------------------------------------------


def serialize_user(user: User, *, private: bool = False) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
    }
    if private:
        data.update(
            email=user.email,
            is_admin=user.is_admin,
            is_active=user.is_active,
            created_at=user.created_at.isoformat(),
            last_login_at=user.last_login_at.isoformat() if user.last_login_at else None,
        )
    return data


def create_user(
    db: Session,
    *,
    username: str,
    email: str,
    password: str,
    display_name: str = "",
    is_admin: bool = False,
) -> User:
    """Create an account together with its private personal workspace."""
    username = normalize_username(username)
    email = normalize_email(email)
    validate_password(password)
    taken = db.execute(
        select(User.id).where(or_(User.username == username, User.email == email))
    ).first()
    if taken:
        raise Conflict("A user with this username or email already exists")

    user = User(
        username=username,
        email=email,
        display_name=clean_display_name(display_name, username),
        password_hash=hash_password(password),
        is_admin=is_admin,
    )
    db.add(user)
    db.flush()
    workspace = Workspace(name="Personal", kind=WORKSPACE_PERSONAL, owner_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=ROLE_OWNER))
    db.flush()
    return user


def find_user(db: Session, identifier: str) -> User | None:
    identifier = identifier.strip().lower()
    if not identifier:
        return None
    return db.execute(
        select(User).where(or_(User.username == identifier, User.email == identifier))
    ).scalar_one_or_none()


def set_password(
    db: Session, user: User, password: str, *, keep_session_id: int | None = None
) -> None:
    """Change a password and sign the user out everywhere else."""
    validate_password(password)
    user.password_hash = hash_password(password)
    query = delete(UserSession).where(UserSession.user_id == user.id)
    if keep_session_id is not None:
        query = query.where(UserSession.id != keep_session_id)
    db.execute(query)


def count_active_admins(db: Session, *, excluding: int | None = None) -> int:
    query = select(func.count()).select_from(User).where(User.is_admin, User.is_active)
    if excluding is not None:
        query = query.where(User.id != excluding)
    return db.execute(query).scalar_one()


# -- login -------------------------------------------------------------------


def _check_rate_limit(db: Session, identifier: str, ip: str) -> None:
    settings = get_settings()
    since = utcnow() - timedelta(minutes=settings.login_window_minutes)
    by_identifier = db.execute(
        select(func.count())
        .select_from(LoginAttempt)
        .where(LoginAttempt.identifier == identifier, LoginAttempt.created_at >= since)
    ).scalar_one()
    by_ip = db.execute(
        select(func.count())
        .select_from(LoginAttempt)
        .where(LoginAttempt.ip == ip, LoginAttempt.created_at >= since)
    ).scalar_one()
    if by_identifier >= settings.login_max_failures or by_ip >= settings.login_max_failures * 4:
        raise TooManyRequests(
            "Too many failed sign-in attempts. Please wait a few minutes and try again.",
            extra={"retry_after": settings.login_window_minutes * 60},
        )


def register_failed_login(db: Session, identifier: str, ip: str) -> None:
    """Record a failed attempt. Runs in its own transaction (see the route)."""
    settings = get_settings()
    cutoff = utcnow() - timedelta(minutes=settings.login_window_minutes * 4)
    db.execute(delete(LoginAttempt).where(LoginAttempt.created_at < cutoff))
    db.add(LoginAttempt(identifier=identifier[:254], ip=ip[:64]))


def authenticate(db: Session, identifier: str, password: str, ip: str) -> User | None:
    """Return the user for valid credentials, None otherwise.

    Raises TooManyRequests when the identifier or address is locked out.
    """
    identifier = identifier.strip().lower()[:254]
    _check_rate_limit(db, identifier, ip)
    user = find_user(db, identifier)
    password_ok = verify_password(user.password_hash if user else None, password)
    if user is None or not password_ok or not user.is_active:
        return None
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    db.execute(delete(LoginAttempt).where(LoginAttempt.identifier == identifier))
    user.last_login_at = utcnow()
    return user


# -- sessions ----------------------------------------------------------------


def create_session(
    db: Session, user: User, *, ip: str | None, user_agent: str | None
) -> tuple[UserSession, str]:
    """Create a server-side session; returns it with the raw cookie token."""
    settings = get_settings()
    token = new_token()
    now = utcnow()
    session = UserSession(
        user_id=user.id,
        token_hash=hash_token(token),
        csrf_token=new_token(24),
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(days=settings.session_max_days),
        ip=(ip or "")[:64] or None,
        user_agent=(user_agent or "")[:255] or None,
    )
    db.add(session)
    db.execute(delete(UserSession).where(UserSession.expires_at < now))
    db.flush()
    return session, token


def session_is_valid(session: UserSession, now: datetime | None = None) -> bool:
    settings = get_settings()
    now = now or utcnow()
    if session.expires_at <= now:
        return False
    if now - session.last_seen_at > timedelta(minutes=settings.session_idle_minutes):
        return False
    return session.user.is_active


def find_session(db: Session, token: str) -> UserSession | None:
    if not token:
        return None
    session = db.execute(
        select(UserSession).where(UserSession.token_hash == hash_token(token))
    ).scalar_one_or_none()
    if session is None or not session_is_valid(session):
        return None
    return session


def revoke_session(db: Session, session_id: int, user: User) -> None:
    session = db.get(UserSession, session_id)
    if session is None or session.user_id != user.id:
        raise NotFound("Session not found")
    db.delete(session)


def list_sessions(db: Session, user: User, current_id: int) -> list[dict[str, Any]]:
    rows = db.execute(
        select(UserSession)
        .where(UserSession.user_id == user.id)
        .order_by(UserSession.last_seen_at.desc())
    ).scalars()
    return [
        {
            "id": s.id,
            "current": s.id == current_id,
            "ip": s.ip,
            "user_agent": s.user_agent,
            "created_at": s.created_at.isoformat(),
            "last_seen_at": s.last_seen_at.isoformat(),
        }
        for s in rows
        if session_is_valid(s)
    ]


# -- invitations and registration -------------------------------------------


def create_invite(
    db: Session, admin: User, *, email: str | None, is_admin: bool = False
) -> tuple[Invite, str]:
    token = new_token()
    invite = Invite(
        token_hash=hash_token(token),
        email=normalize_email(email) if email else None,
        is_admin=is_admin,
        created_by=admin.id,
        expires_at=utcnow() + timedelta(days=INVITE_VALID_DAYS),
    )
    db.add(invite)
    db.flush()
    return invite, token


def find_valid_invite(db: Session, token: str | None) -> Invite | None:
    if not token:
        return None
    invite = db.execute(
        select(Invite).where(Invite.token_hash == hash_token(token))
    ).scalar_one_or_none()
    if invite is None or invite.used_at is not None or invite.expires_at <= utcnow():
        return None
    return invite


def register(
    db: Session,
    *,
    username: str,
    email: str,
    password: str,
    display_name: str,
    invite_token: str | None,
) -> User:
    """Self-service sign-up: needs a valid invitation unless registration is open."""
    invite = find_valid_invite(db, invite_token)
    if invite is None:
        if invite_token:
            raise Forbidden("This invitation is no longer valid")
        if not get_app_settings(db)[SETTING_ALLOW_REGISTRATION]:
            raise Forbidden("Registration is disabled. Ask an administrator for an invitation.")
    if invite is not None and invite.email and normalize_email(email) != invite.email:
        raise ValidationFailed("This invitation was issued for a different email address")
    user = create_user(
        db,
        username=username,
        email=email,
        password=password,
        display_name=display_name,
        is_admin=bool(invite and invite.is_admin),
    )
    if invite is not None:
        invite.used_at = utcnow()
        invite.used_by = user.id
    return user

"""Audit trail for security relevant actions."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditEvent, User


def record(
    db: Session,
    action: str,
    *,
    user: User | None = None,
    target_type: str | None = None,
    target_id: int | str | None = None,
    detail: dict[str, Any] | None = None,
    ip: str | None = None,
) -> None:
    db.add(
        AuditEvent(
            user_id=user.id if user else None,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else None,
            detail=detail,
            ip=ip,
        )
    )

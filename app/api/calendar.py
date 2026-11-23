"""The calendar: dated rows of databases and due tasks in a range of days."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.deps import Db, UserAccess
from app.services import calendar

router = APIRouter(tags=["calendar"])


@router.get("/calendar")
def get_calendar(
    access: UserAccess,
    db: Db,
    start: str = Query(max_length=10),
    end: str = Query(max_length=10),
) -> dict[str, Any]:
    return calendar.calendar(db, access, start=start, end=end)

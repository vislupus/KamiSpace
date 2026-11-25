"""What the calendar shows: rows of databases that have a date, and due tasks.

Nothing comes from outside the installation. Only databases and rows the
user may see are read; public holidays are calculated in the browser.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import ValidationFailed
from app.models import ROLE_EDITOR, Page, Task
from app.services.databases import COLOR_KEY, KIND_DATABASE, clean_color
from app.services.permissions import Access, PageNode, role_at_least

MAX_DAYS = 800


def _day(value: str, name: str) -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValidationFailed(f"{name}: expected a date like 2026-11-23") from None


def calendar(db: Session, access: Access, *, start: str, end: str) -> dict[str, Any]:
    first, last = _day(start, "start"), _day(end, "end")
    if last < first:
        raise ValidationFailed("end: must not be before start")
    if (last - first).days > MAX_DAYS:
        raise ValidationFailed(f"The range may cover at most {MAX_DAYS} days")
    first_day, last_day = first.isoformat(), last.isoformat()

    items: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    # Database id → what is needed to read its rows.
    readable: dict[int, dict[str, Any]] = {}
    databases = db.execute(
        select(
            Page.id,
            Page.parent_id,
            Page.workspace_id,
            Page.owner_id,
            Page.title,
            Page.icon,
            Page.locked,
            Page.db_schema,
        )
        .where(Page.kind == KIND_DATABASE, Page.deleted_at.is_(None))
        .order_by(Page.title, Page.id)
    ).all()
    access.prime([PageNode(d.id, d.parent_id, d.workspace_id, d.owner_id) for d in databases])
    for database in databases:
        role = access.page_role(database.id)
        if role is None:
            continue
        schema = database.db_schema if isinstance(database.db_schema, dict) else {}
        properties = schema.get("properties") or []
        date_properties = [prop for prop in properties if prop.get("type") == "date"]
        if not date_properties:
            continue
        can_edit = role_at_least(role, ROLE_EDITOR) and not database.locked
        color = clean_color(schema.get("color"))
        sources.append(
            {
                "id": database.id,
                "title": database.title,
                "icon": database.icon,
                "can_edit": can_edit,
                "color": color,
                "date_properties": [
                    {"id": prop["id"], "name": prop["name"]} for prop in date_properties
                ],
            }
        )
        readable[database.id] = {
            "title": database.title,
            "locked": database.locked,
            "color": color,
            "date_properties": date_properties,
        }

    # The rows of every database in one query, and only the columns the
    # calendar shows (never the text of the pages).
    rows = (
        db.execute(
            select(
                Page.id,
                Page.parent_id,
                Page.workspace_id,
                Page.owner_id,
                Page.title,
                Page.icon,
                Page.locked,
                Page.props,
            ).where(
                Page.parent_id.in_(readable.keys()),
                Page.deleted_at.is_(None),
                Page.props.is_not(None),
            )
        ).all()
        if readable
        else []
    )
    access.prime([PageNode(r.id, r.parent_id, r.workspace_id, r.owner_id) for r in rows])
    for row in rows:
        source = readable[row.parent_id]
        props = row.props or {}
        dated = [
            (prop, props[prop["id"]])
            for prop in source["date_properties"]
            if isinstance(props.get(prop["id"]), dict) and props[prop["id"]].get("start")
        ]
        if not dated:
            continue
        row_role: str | None = None
        for prop, value in dated:
            begins = value["start"]
            ends = value.get("end")
            # Compared by day: "2026-11-23T14:30" belongs to 23 November.
            if begins[:10] > last_day or (ends or begins)[:10] < first_day:
                continue
            if row_role is None:
                row_role = access.page_role(row.id)
                if row_role is None:
                    break
            row_color = clean_color(props.get(COLOR_KEY))
            items.append(
                {
                    "kind": "row",
                    "id": row.id,
                    "title": row.title,
                    "icon": row.icon,
                    "database_id": row.parent_id,
                    "database_title": source["title"],
                    "property_id": prop["id"],
                    "property": prop["name"],
                    "start": begins,
                    "end": ends,
                    # The row's own colour, or else the colour of its database.
                    "color": row_color or source["color"],
                    "own_color": row_color,
                    "can_edit": role_at_least(row_role, ROLE_EDITOR)
                    and not row.locked
                    and not source["locked"],
                }
            )

    due = db.execute(
        select(Task, Page)
        .join(Page, Page.id == Task.page_id)
        .where(
            Task.assignee_id == access.user.id,
            Task.due.is_not(None),
            Task.due >= first_day,
            Task.due <= last_day,
            Page.deleted_at.is_(None),
        )
        .order_by(Task.due, Task.id)
    ).all()
    for task, page in due:
        can_open = access.can_view(page.id)
        items.append(
            {
                "kind": "task",
                "id": page.id if can_open else None,
                "task_key": task.task_key,
                "title": task.text,
                "start": task.due,
                "end": None,
                "checked": task.checked,
                # Only the task itself is shown to someone who cannot open the page.
                "page_title": page.title if can_open else None,
                "can_toggle": not page.locked,
            }
        )
    items.sort(key=lambda item: (item["start"], item["title"] or ""))
    return {"start": first_day, "end": last_day, "items": items, "databases": sources}

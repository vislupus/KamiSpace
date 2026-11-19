"""Databases: pages that hold a table of rows, shown as a table or a board.

A database is a page of kind ``database``. Its rows are ordinary sub-pages
that carry property values, so everything pages can do also works for rows:
they inherit access from the database, can be opened and written in, shared,
moved to the recycle bin and found by search.

The schema (properties and views) and every property value pass through an
allow-list here; nothing the client sends is stored as it came.
"""

from __future__ import annotations

import copy
import math
import re
import secrets
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.errors import Locked, NotFound, ValidationFailed
from app.models import ROLE_EDITOR, ROLE_VIEWER, Page, User
from app.services import pages, search
from app.services.document import is_safe_url
from app.services.permissions import Access, role_at_least

KIND_DATABASE = "database"

PROPERTY_TYPES = {
    "title",
    "text",
    "number",
    "select",
    "multi_select",
    "status",
    "date",
    "person",
    "checkbox",
    "url",
}
OPTION_TYPES = {"select", "multi_select", "status"}
OPTION_COLORS = {
    "default",
    "gray",
    "brown",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "pink",
    "red",
}
NUMBER_FORMATS = {"number", "percent", "bar"}
VIEW_TYPES = {"table", "board"}
GROUPABLE_TYPES = {"select", "status", "person"}
FILTER_OPS = {
    "contains",
    "not_contains",
    "is",
    "is_not",
    "empty",
    "not_empty",
    "checked",
    "unchecked",
    "before",
    "after",
    "gt",
    "lt",
}
CALCULATIONS = {"count", "values", "empty", "sum", "average", "min", "max"}

MAX_PROPERTIES = 50
MAX_OPTIONS = 100
MAX_VIEWS = 20
MAX_ROWS = 5000
TITLE_ID = "title"

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,24}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def new_id(prefix: str) -> str:
    return prefix + secrets.token_hex(4)


def _name(value: Any, fallback: str, limit: int = 100) -> str:
    if not isinstance(value, str):
        return fallback
    cleaned = " ".join(value.split())[:limit]
    return cleaned or fallback


def _is_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    return math.isfinite(value)


def _clean_id(value: Any) -> str | None:
    return value if isinstance(value, str) and _ID_RE.match(value) else None


# -- schema -------------------------------------------------------------------


def default_schema(first_view: str = "table") -> dict[str, Any]:
    status = new_id("p")
    views = [
        {"id": new_id("v"), "name": "Table", "type": "table"},
        {"id": new_id("v"), "name": "Board", "type": "board", "groupBy": status},
    ]
    if first_view == "board":
        views.reverse()
    return sanitize_schema(
        {
            "properties": [
                {"id": TITLE_ID, "name": "Name", "type": "title"},
                {
                    "id": status,
                    "name": "Status",
                    "type": "status",
                    "options": [
                        {"id": new_id("o"), "name": "Not started", "color": "gray"},
                        {"id": new_id("o"), "name": "In progress", "color": "blue"},
                        {"id": new_id("o"), "name": "Done", "color": "green"},
                    ],
                },
                {"id": new_id("p"), "name": "Assignee", "type": "person"},
                {"id": new_id("p"), "name": "Date", "type": "date"},
            ],
            "views": views,
        }
    )


def _clean_options(raw: Any) -> list[dict[str, str]]:
    options: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or len(options) >= MAX_OPTIONS:
            continue
        option_id = _clean_id(item.get("id"))
        if option_id is None or option_id in seen:
            continue
        seen.add(option_id)
        color = item.get("color")
        options.append(
            {
                "id": option_id,
                "name": _name(item.get("name"), "Option"),
                "color": color if color in OPTION_COLORS else "default",
            }
        )
    return options


def _clean_properties(raw: Any) -> list[dict[str, Any]]:
    properties: list[dict[str, Any]] = []
    seen: set[str] = set()
    title: dict[str, Any] | None = None
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or len(properties) >= MAX_PROPERTIES:
            continue
        prop_id = _clean_id(item.get("id"))
        prop_type = item.get("type")
        if prop_id is None or prop_id in seen or prop_type not in PROPERTY_TYPES:
            continue
        # Exactly one title property, always with the same id.
        if (prop_type == "title") != (prop_id == TITLE_ID):
            continue
        seen.add(prop_id)
        prop: dict[str, Any] = {
            "id": prop_id,
            "name": _name(item.get("name"), "Name" if prop_type == "title" else "Property"),
            "type": prop_type,
        }
        if prop_type in OPTION_TYPES:
            prop["options"] = _clean_options(item.get("options"))
        if prop_type == "number":
            number_format = item.get("format")
            prop["format"] = number_format if number_format in NUMBER_FORMATS else "number"
        if prop_type == "title":
            title = prop
        properties.append(prop)
    if title is None:
        properties.insert(0, {"id": TITLE_ID, "name": "Name", "type": "title"})
    return properties


def _clean_views(raw: Any, properties: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {prop["id"]: prop for prop in properties}
    views: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or len(views) >= MAX_VIEWS:
            continue
        view_id = _clean_id(item.get("id"))
        view_type = item.get("type")
        if view_id is None or view_id in seen or view_type not in VIEW_TYPES:
            continue
        seen.add(view_id)
        view: dict[str, Any] = {
            "id": view_id,
            "name": _name(item.get("name"), "Board" if view_type == "board" else "Table"),
            "type": view_type,
        }

        def known(values: Any) -> list[str]:
            result: list[str] = []
            for value in values if isinstance(values, list) else []:
                if isinstance(value, str) and value in by_id and value not in result:
                    result.append(value)
            return result

        view["hidden"] = [prop_id for prop_id in known(item.get("hidden")) if prop_id != TITLE_ID]
        view["order"] = known(item.get("order"))

        sorts = []
        for sort in item.get("sort") if isinstance(item.get("sort"), list) else []:
            if isinstance(sort, dict) and sort.get("property") in by_id and len(sorts) < 5:
                direction = "desc" if sort.get("direction") == "desc" else "asc"
                sorts.append({"property": sort["property"], "direction": direction})
        view["sort"] = sorts

        filters = []
        for rule in item.get("filter") if isinstance(item.get("filter"), list) else []:
            if not isinstance(rule, dict) or len(filters) >= 10:
                continue
            if rule.get("property") not in by_id or rule.get("op") not in FILTER_OPS:
                continue
            value = rule.get("value")
            if isinstance(value, str):
                value = value[:200]
            elif not _is_number(value):
                value = None
            filters.append({"property": rule["property"], "op": rule["op"], "value": value})
        view["filter"] = filters

        if view_type == "table":
            widths: dict[str, int] = {}
            raw_widths = item.get("widths") if isinstance(item.get("widths"), dict) else {}
            for prop_id, width in raw_widths.items():
                if (
                    prop_id in by_id
                    and isinstance(width, int | float)
                    and not isinstance(width, bool)
                ):
                    widths[prop_id] = max(60, min(900, int(width)))
            view["widths"] = widths
            calc: dict[str, str] = {}
            raw_calc = item.get("calc") if isinstance(item.get("calc"), dict) else {}
            for prop_id, name in raw_calc.items():
                if prop_id in by_id and name in CALCULATIONS:
                    calc[prop_id] = name
            view["calc"] = calc
        else:
            group = item.get("groupBy")
            groupable = [prop["id"] for prop in properties if prop["type"] in GROUPABLE_TYPES]
            if group not in groupable:
                group = groupable[0] if groupable else None
            view["groupBy"] = group
        views.append(view)
    if not views:
        views.append(
            {
                "id": new_id("v"),
                "name": "Table",
                "type": "table",
                "hidden": [],
                "order": [],
                "sort": [],
                "filter": [],
                "widths": {},
                "calc": {},
            }
        )
    return views


def sanitize_schema(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    properties = _clean_properties(raw.get("properties"))
    return {"properties": properties, "views": _clean_views(raw.get("views"), properties)}


# -- values --------------------------------------------------------------------


def _clean_value(prop: dict[str, Any], value: Any, users: set[int]) -> Any:
    """One property value in its stored form, or None when it is empty or invalid."""
    prop_type = prop["type"]
    if value is None:
        return None
    if prop_type == "text":
        if isinstance(value, int | float) and not isinstance(value, bool):
            value = str(value)
        return value[:2000] or None if isinstance(value, str) else None
    if prop_type == "number":
        if isinstance(value, str):
            try:
                value = float(value.replace(",", ".").strip())
            except ValueError:
                return None
        if isinstance(value, bool) or not isinstance(value, int | float):
            return None
        if not math.isfinite(value) or abs(value) > 1e15:
            return None
        return int(value) if float(value).is_integer() else round(float(value), 6)
    if prop_type in ("select", "status"):
        if isinstance(value, list):
            value = value[0] if value else None
        valid = {option["id"] for option in prop.get("options", [])}
        return value if isinstance(value, str) and value in valid else None
    if prop_type == "multi_select":
        if isinstance(value, str):
            value = [value]
        valid = {option["id"] for option in prop.get("options", [])}
        chosen: list[str] = []
        for item in value if isinstance(value, list) else []:
            if isinstance(item, str) and item in valid and item not in chosen:
                chosen.append(item)
        return chosen or None
    if prop_type == "date":
        if isinstance(value, str):
            value = {"start": value}
        if not isinstance(value, dict):
            return None
        start, end = value.get("start"), value.get("end")
        if not isinstance(start, str) or not _DATE_RE.match(start):
            return None
        if not isinstance(end, str) or not _DATE_RE.match(end) or end <= start:
            return {"start": start}
        return {"start": start, "end": end}
    if prop_type == "person":
        if isinstance(value, int) and not isinstance(value, bool):
            value = [value]
        people: list[int] = []
        for item in value if isinstance(value, list) else []:
            valid = isinstance(item, int) and not isinstance(item, bool) and item in users
            if valid and item not in people and len(people) < 20:
                people.append(item)
        return people or None
    if prop_type == "checkbox":
        return True if value is True else None
    if prop_type == "url":
        if not isinstance(value, str):
            return None
        value = value.strip()
        return value if value and is_safe_url(value) else None
    return None


def _user_ids(db: Session) -> set[int]:
    return set(db.execute(select(User.id)).scalars())


def clean_props(
    schema: dict[str, Any], props: Any, users: set[int], *, base: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Property values checked against the schema. ``props`` updates ``base``."""
    result = dict(base or {})
    by_id = {prop["id"]: prop for prop in schema["properties"]}
    for prop_id, value in (props if isinstance(props, dict) else {}).items():
        prop = by_id.get(prop_id)
        if prop is None or prop["type"] == "title":
            continue
        cleaned = _clean_value(prop, value, users)
        if cleaned is None:
            result.pop(prop_id, None)
        else:
            result[prop_id] = cleaned
    return {prop_id: value for prop_id, value in result.items() if prop_id in by_id}


# -- reading --------------------------------------------------------------------


def require_database(access: Access, page_id: int, role: str = ROLE_VIEWER) -> Page:
    page = access.require_page(page_id, role)
    if page.kind != KIND_DATABASE:
        raise NotFound("This page is not a database")
    return page


def _schema(page: Page) -> dict[str, Any]:
    return page.db_schema if isinstance(page.db_schema, dict) else sanitize_schema(None)


def _has_content(page: Page) -> bool:
    blocks = (page.content or {}).get("content") or []
    return len(blocks) > 1 or any(block.get("content") for block in blocks)


def serialize_row(page: Page, role: str | None) -> dict[str, Any]:
    return {
        "id": page.id,
        "title": page.title,
        "icon": page.icon,
        "props": page.props or {},
        "position": page.position,
        "has_content": _has_content(page),
        "can_edit": role_at_least(role, ROLE_EDITOR) and not page.locked,
        "created_at": page.created_at.isoformat(),
        "updated_at": page.updated_at.isoformat(),
    }


def _rows(db: Session, access: Access, database: Page) -> list[Page]:
    rows = db.execute(
        select(Page)
        .where(Page.parent_id == database.id, Page.deleted_at.is_(None))
        .order_by(Page.position, Page.id)
    ).scalars()
    return [row for row in rows if access.can_view(row.id)]


def detail(db: Session, access: Access, database: Page) -> dict[str, Any]:
    role = access.page_role(database.id)
    schema = _schema(database)
    return {
        "id": database.id,
        "title": database.title,
        "icon": database.icon,
        "parent_id": database.parent_id if access.can_view(database.parent_id or 0) else None,
        "can_edit": role_at_least(role, ROLE_EDITOR) and not database.locked,
        "locked": database.locked,
        "properties": schema["properties"],
        "views": schema["views"],
        "rows": [
            serialize_row(row, access.page_role(row.id)) for row in _rows(db, access, database)
        ],
    }


def row_context(db: Session, access: Access, page: Page) -> dict[str, Any] | None:
    """For a page that is a row: its database's properties and its own values."""
    if page.parent_id is None:
        return None
    parent = db.get(Page, page.parent_id)
    if parent is None or parent.kind != KIND_DATABASE or not access.can_view(parent.id):
        return None
    return {
        "database_id": parent.id,
        "database_title": parent.title,
        "properties": _schema(parent)["properties"],
        "props": page.props or {},
    }


# -- writing --------------------------------------------------------------------


def _editable(access: Access, page_id: int) -> Page:
    database = require_database(access, page_id, ROLE_EDITOR)
    if database.locked:
        raise Locked()
    return database


def _touch(page: Page, user: User) -> None:
    page.updated_at = utcnow()
    page.updated_by = user.id


def create_database(
    db: Session,
    access: Access,
    *,
    workspace_id: int | None,
    parent_id: int | None,
    title: str,
    view: str,
) -> Page:
    # Shown inline in its parent by a database block, so no link is added.
    page = pages.create_page(
        db,
        access,
        workspace_id=workspace_id,
        parent_id=parent_id,
        title=title,
        link_in_parent=False,
    )
    page.kind = KIND_DATABASE
    page.db_schema = default_schema(view)
    db.flush()
    return page


def update_schema(
    db: Session,
    access: Access,
    page_id: int,
    *,
    properties: list[dict[str, Any]] | None,
    views: list[dict[str, Any]] | None,
) -> Page:
    database = _editable(access, page_id)
    current = _schema(database)
    schema = sanitize_schema(
        {
            "properties": properties if properties is not None else current["properties"],
            "views": views if views is not None else current["views"],
        }
    )
    database.db_schema = schema
    _touch(database, access.user)
    if properties is not None and schema["properties"] != current["properties"]:
        # A removed property, a changed type or a deleted option: values that
        # no longer fit are dropped from every row.
        users = _user_ids(db)
        rows = db.execute(select(Page).where(Page.parent_id == database.id)).scalars()
        for row in rows:
            cleaned = clean_props(schema, row.props or {}, users)
            if cleaned != (row.props or {}):
                row.props = cleaned
    db.flush()
    return database


def create_row(
    db: Session,
    access: Access,
    page_id: int,
    *,
    title: str,
    props: dict[str, Any] | None,
    before_id: int | None = None,
    after_id: int | None = None,
) -> Page:
    database = _editable(access, page_id)
    existing = db.execute(
        select(Page.id).where(Page.parent_id == database.id, Page.deleted_at.is_(None))
    ).all()
    if len(existing) >= MAX_ROWS:
        raise ValidationFailed(f"A database can hold at most {MAX_ROWS} rows")
    row = pages.create_page(
        db,
        access,
        workspace_id=None,
        parent_id=database.id,
        title=title,
        link_in_parent=False,
    )
    row.props = clean_props(_schema(database), props, _user_ids(db))
    if before_id is not None or after_id is not None:
        pages._place(db, row, before_id=before_id, after_id=after_id)
    db.flush()
    return row


def update_row(
    db: Session,
    access: Access,
    page_id: int,
    row_id: int,
    *,
    fields: dict[str, Any],
) -> Page:
    database = require_database(access, page_id, ROLE_VIEWER)
    if database.locked:
        raise Locked()
    row = access.require_page(row_id, ROLE_EDITOR)
    if row.parent_id != database.id:
        raise NotFound("This row is not part of the database")
    if row.locked:
        raise Locked()
    if fields.get("title") is not None:
        title = pages.clean_title(fields["title"])
        if title != row.title:
            row.title = title
            db.flush()
            search.index_page(db, row)
    if "icon" in fields:
        row.icon = pages.clean_icon(fields["icon"])
    if fields.get("props") is not None:
        row.props = clean_props(
            _schema(database), fields["props"], _user_ids(db), base=copy.deepcopy(row.props or {})
        )
    before_id, after_id = fields.get("before_id"), fields.get("after_id")
    if before_id is not None or after_id is not None:
        pages._place(db, row, before_id=before_id, after_id=after_id)
    _touch(row, access.user)
    db.flush()
    return row

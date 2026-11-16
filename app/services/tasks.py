"""To-do items across pages: the index behind "My tasks"."""

from __future__ import annotations

import copy
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.errors import Locked, NotFound
from app.models import ROLE_EDITOR, Page, Task, User
from app.services import search, versions
from app.services.document import extract_tasks, set_task_checked
from app.services.permissions import Access


def sync_page(db: Session, page: Page) -> None:
    """Rebuild the task rows of one page from its document."""
    db.execute(delete(Task).where(Task.page_id == page.id))
    known_users: set[int] | None = None
    for position, item in enumerate(extract_tasks(page.content)):
        assignee = item["assignee"]
        if assignee is not None:
            if known_users is None:
                known_users = set(db.execute(select(User.id)).scalars())
            if assignee not in known_users:
                assignee = None
        db.add(
            Task(
                page_id=page.id,
                task_key=item["task_key"],
                text=item["text"],
                checked=item["checked"],
                assignee_id=assignee,
                due=item["due"],
                position=position,
            )
        )
    db.flush()


def _visible(db: Session, access: Access, *, include_done: bool) -> list[tuple[Task, Page]]:
    query = (
        select(Task, Page)
        .join(Page, Page.id == Task.page_id)
        .where(Task.assignee_id == access.user.id, Page.deleted_at.is_(None))
    )
    if not include_done:
        query = query.where(Task.checked.is_(False))
    rows = db.execute(query.order_by(Task.checked, Task.due.is_(None), Task.due, Task.id)).all()
    return [(task, page) for task, page in rows if access.can_view(page.id)]


def count_open(db: Session, access: Access) -> int:
    assigned = db.execute(
        select(func.count())
        .select_from(Task)
        .join(Page, Page.id == Task.page_id)
        .where(
            Task.assignee_id == access.user.id,
            Task.checked.is_(False),
            Page.deleted_at.is_(None),
        )
    ).scalar_one()
    if not assigned:
        return 0
    return len(_visible(db, access, include_done=False))


def list_assigned(db: Session, access: Access, *, include_done: bool) -> list[dict[str, Any]]:
    return [
        {
            "task_key": task.task_key,
            "page_id": page.id,
            "page_title": page.title,
            "page_icon": page.icon,
            "text": task.text,
            "checked": task.checked,
            "due": task.due,
            "can_toggle": access.can_edit(page.id) and not page.locked,
        }
        for task, page in _visible(db, access, include_done=include_done)
    ]


def set_checked(db: Session, access: Access, page_id: int, task_key: str, checked: bool) -> Page:
    """Tick a to-do item from outside the editor (the "My tasks" list)."""
    page = access.require_page(page_id, ROLE_EDITOR)
    if page.locked:
        raise Locked()
    content = copy.deepcopy(page.content)
    if not set_task_checked(content, task_key, checked):
        raise NotFound("This task no longer exists on the page")
    if content != page.content:
        page.content = content
        page.revision += 1
        page.updated_at = utcnow()
        page.updated_by = access.user.id
        db.flush()
        versions.record_version(db, page, access.user)
        search.index_page(db, page)
        sync_page(db, page)
    return page

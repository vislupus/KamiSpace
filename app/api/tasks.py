"""To-do items assigned to the signed-in user."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.deps import Db, UserAccess
from app.schemas import TaskToggleIn
from app.services import tasks

router = APIRouter(tags=["tasks"])


@router.get("/tasks")
def my_tasks(access: UserAccess, db: Db, done: bool = False) -> list[dict[str, Any]]:
    return tasks.list_assigned(db, access, include_done=done)


@router.put("/pages/{page_id}/tasks/{task_key}")
def toggle_task(
    page_id: int, task_key: str, body: TaskToggleIn, access: UserAccess, db: Db
) -> dict[str, Any]:
    page = tasks.set_checked(db, access, page_id, task_key, body.checked)
    db.commit()
    return {"revision": page.revision, "open_tasks": tasks.count_open(db, access)}

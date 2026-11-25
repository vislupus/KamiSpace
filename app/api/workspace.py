"""Workspace-wide data for the signed-in user: bootstrap, search, people."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.deps import CurrentSession, Db, UserAccess
from app.services import auth, files, pages, search, sharing, tasks, workspaces

router = APIRouter(tags=["workspace"])


@router.get("/bootstrap")
def bootstrap(session: CurrentSession, access: UserAccess, db: Db) -> JSONResponse:
    """Everything the application shell needs, in one round trip."""
    settings = get_settings()
    return JSONResponse(
        {
            "user": auth.serialize_user(session.user, private=True),
            "csrf_token": session.csrf_token,
            "workspaces": workspaces.list_for_user(db, access),
            "pages": pages.list_tree(db, access),
            "favorites": pages.list_favorites(db, access),
            "recents": pages.list_recents(db, access),
            "users": sharing.user_directory(db),
            "open_tasks": tasks.count_open(db, access),
            "limits": {
                "max_upload_bytes": settings.max_upload_bytes,
                "upload_extensions": sorted(files.ALLOWED_TYPES),
                "remote_fetch": settings.allow_remote_fetch,
            },
        }
    )


@router.get("/tree")
def tree(access: UserAccess, db: Db) -> JSONResponse:
    # One entry per page: plain data, sent without being walked through again.
    return JSONResponse(
        {
            "workspaces": workspaces.list_for_user(db, access),
            "pages": pages.list_tree(db, access),
            "favorites": pages.list_favorites(db, access),
            "recents": pages.list_recents(db, access),
            "users": sharing.user_directory(db),
            "open_tasks": tasks.count_open(db, access),
        }
    )


@router.get("/search")
def search_pages(
    access: UserAccess, db: Db, q: str = Query(default="", max_length=200)
) -> dict[str, Any]:
    return {"query": q, "results": search.search(db, access, q)}


@router.get("/users")
def user_directory(
    access: UserAccess, db: Db, q: str = Query(default="", max_length=100)
) -> list[dict[str, Any]]:
    return sharing.user_directory(db, q)

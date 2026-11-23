"""Databases: schema, views and rows."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.deps import Db, UserAccess
from app.schemas import DatabaseCreateIn, DatabaseUpdateIn, RowCreateIn, RowUpdateIn
from app.services import databases, pages

router = APIRouter(prefix="/databases", tags=["databases"])


@router.post("", status_code=201)
def create_database(body: DatabaseCreateIn, access: UserAccess, db: Db) -> dict[str, Any]:
    page = databases.create_database(
        db,
        access,
        workspace_id=body.workspace_id,
        parent_id=body.parent_id,
        title=body.title,
        view=body.view,
    )
    db.commit()
    return {**pages.serialize_meta(page, access.page_role(page.id)), "kind": page.kind}


@router.get("/{page_id}")
def get_database(page_id: int, access: UserAccess, db: Db) -> dict[str, Any]:
    return databases.detail(db, access, databases.require_database(access, page_id))


@router.patch("/{page_id}")
def update_database(
    page_id: int, body: DatabaseUpdateIn, access: UserAccess, db: Db
) -> dict[str, Any]:
    page = databases.update_schema(
        db, access, page_id, properties=body.properties, views=body.views
    )
    db.commit()
    return databases.detail(db, access, page)


@router.post("/{page_id}/properties/{prop_id}/duplicate", status_code=201)
def duplicate_property(page_id: int, prop_id: str, access: UserAccess, db: Db) -> dict[str, Any]:
    page = databases.duplicate_property(db, access, page_id, prop_id)
    db.commit()
    return databases.detail(db, access, page)


@router.post("/{page_id}/rows", status_code=201)
def create_row(page_id: int, body: RowCreateIn, access: UserAccess, db: Db) -> dict[str, Any]:
    row = databases.create_row(
        db,
        access,
        page_id,
        title=body.title,
        props=body.props,
        before_id=body.before_id,
        after_id=body.after_id,
    )
    db.commit()
    return databases.serialize_row(row, access.page_role(row.id))


@router.patch("/{page_id}/rows/{row_id}")
def update_row(
    page_id: int, row_id: int, body: RowUpdateIn, access: UserAccess, db: Db
) -> dict[str, Any]:
    row = databases.update_row(
        db, access, page_id, row_id, fields=body.model_dump(exclude_unset=True)
    )
    db.commit()
    return databases.serialize_row(row, access.page_role(row.id))

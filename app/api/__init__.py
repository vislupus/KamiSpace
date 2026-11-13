from fastapi import APIRouter

from app.api import (
    account,
    admin,
    auth,
    files,
    pages,
    sharing,
    trash,
    versions,
    workspace,
    workspaces,
)

api_router = APIRouter(prefix="/api")
for module in (
    auth,
    account,
    workspace,
    pages,
    versions,
    sharing,
    trash,
    files,
    workspaces,
    admin,
):
    api_router.include_router(module.router)

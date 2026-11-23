from fastapi import APIRouter

from app.api import (
    account,
    admin,
    auth,
    calendar,
    databases,
    files,
    pages,
    remote,
    sharing,
    tasks,
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
    remote,
    tasks,
    databases,
    calendar,
    workspaces,
    admin,
):
    api_router.include_router(module.router)

"""HTML entry points. The workspace itself is a small single-page app."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates

from app import __version__
from app.config import BASE_DIR, get_settings
from app.deps import get_optional_session
from app.models import UserSession

router = APIRouter(include_in_schema=False)
templates = Jinja2Templates(directory=BASE_DIR / "app" / "templates")

DIST_DIR = BASE_DIR / "static" / "dist"
OptionalSession = Annotated[UserSession | None, Depends(get_optional_session)]


@lru_cache
def _load_manifest() -> dict[str, Any]:
    manifest_path = DIST_DIR / ".vite" / "manifest.json"
    if not manifest_path.is_file():
        return {}
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def asset_tags(entry: str) -> dict[str, list[str]]:
    """Script and stylesheet URLs for a Vite entry point."""
    if not get_settings().is_production:
        _load_manifest.cache_clear()  # pick up rebuilds while developing
    manifest = _load_manifest()
    chunk = manifest.get(entry)
    if chunk is None:
        return {"scripts": [], "styles": [], "missing": [entry]}
    styles = [f"/static/dist/{css}" for css in chunk.get("css", [])]
    return {"scripts": [f"/static/dist/{chunk['file']}"], "styles": styles, "missing": []}


def _render(request: Request, template: str, entry: str, **context: Any) -> Response:
    return templates.TemplateResponse(
        request,
        template,
        {"assets": asset_tags(entry), "version": __version__, **context},
        headers={"Cache-Control": "no-store"},
    )


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request, session: OptionalSession) -> Response:
    if session is not None:
        return RedirectResponse("/", status_code=303)
    return _render(request, "auth.html", "src/auth.js", mode="login", title="Sign in")


@router.get("/register", response_class=HTMLResponse)
def register_page(request: Request, session: OptionalSession) -> Response:
    if session is not None:
        return RedirectResponse("/", status_code=303)
    return _render(request, "auth.html", "src/auth.js", mode="register", title="Create account")


@router.get("/", response_class=HTMLResponse)
@router.get("/p/{page_id}", response_class=HTMLResponse)
@router.get("/trash", response_class=HTMLResponse)
def app_shell(request: Request, session: OptionalSession) -> Response:
    if session is None:
        target = request.url.path
        suffix = f"?next={target}" if target != "/" else ""
        return RedirectResponse(f"/login{suffix}", status_code=303)
    return _render(request, "app.html", "src/main.js", title="MindDock")


@router.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}

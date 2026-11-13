"""Application factory."""

from __future__ import annotations

import logging
import tempfile
from logging.handlers import RotatingFileHandler
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import __version__
from app.api import api_router
from app.config import BASE_DIR, Settings, get_settings
from app.deps import SAFE_METHODS
from app.errors import AppError
from app.web import router as web_router

logger = logging.getLogger("minddock")

CONTENT_SECURITY_POLICY = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self'",
        # The editor sets inline styles (column widths, popover positions).
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ]
)


def configure_logging(settings: Settings) -> None:
    root = logging.getLogger()
    if any(getattr(h, "_minddock", False) for h in root.handlers):
        return
    settings.logs_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        settings.logs_dir / "minddock.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    handler._minddock = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(settings.log_level.upper())


def _same_origin(request: Request) -> bool:
    """Reject cross-site state-changing requests (defence in depth for CSRF)."""
    origin = request.headers.get("origin")
    if origin is None:
        return True
    host = request.headers.get("host", "")
    return origin != "null" and urlsplit(origin).netloc.lower() == host.lower()


def _error(status_code: int, code: str, message: str, **extra: object) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, **extra}}, status_code)


def create_app() -> FastAPI:
    settings = get_settings()
    settings.ensure_directories()
    configure_logging(settings)
    # Spooled uploads and every other tempfile stay inside the project.
    tempfile.tempdir = str(settings.temp_dir)

    app = FastAPI(
        title="MindDock",
        version=__version__,
        docs_url=None if settings.is_production else "/api/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/api/openapi.json",
    )

    if settings.allowed_host_list:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_host_list)

    @app.middleware("http")
    async def security_middleware(request: Request, call_next) -> Response:
        if request.method not in SAFE_METHODS:
            if not _same_origin(request):
                return _error(403, "forbidden", "Cross-site request blocked")
            length = request.headers.get("content-length")
            # Uploads are also measured while streaming; this is the early exit.
            if length and length.isdigit() and int(length) > settings.max_upload_bytes + 1_048_576:
                return _error(413, "too_large", "Request body is too large")

        response = await call_next(request)

        headers = response.headers
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("Referrer-Policy", "same-origin")
        headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        is_docs = request.url.path.startswith("/api/docs")
        if not is_docs:
            headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        if request.url.scheme == "https":
            headers.setdefault("Strict-Transport-Security", "max-age=31536000")
        path = request.url.path
        if path.startswith("/api/"):
            headers.setdefault("Cache-Control", "no-store")
        elif path.startswith("/static/dist/assets/") and response.status_code == 200:
            # Bundled assets carry a content hash in their file name.
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

    @app.exception_handler(AppError)
    async def handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
        headers = {}
        if "retry_after" in exc.extra:
            headers["Retry-After"] = str(exc.extra["retry_after"])
        response = _error(exc.status_code, exc.code, exc.message, **exc.extra)
        response.headers.update(headers)
        return response

    @app.exception_handler(RequestValidationError)
    async def handle_validation(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        location = ".".join(str(part) for part in first.get("loc", []) if part != "body")
        message = first.get("msg", "Invalid request")
        return _error(422, "invalid", f"{location}: {message}" if location else message)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http(request: Request, exc: StarletteHTTPException) -> Response:
        if request.url.path.startswith("/api/") or exc.status_code != 404:
            return _error(exc.status_code, "http_error", str(exc.detail))
        return _error(404, "not_found", "Not found")

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return _error(500, "server_error", "Something went wrong on the server")

    app.include_router(api_router)
    app.include_router(web_router)

    static_dir = BASE_DIR / "static"
    static_dir.mkdir(exist_ok=True)
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    return app


app = create_app()

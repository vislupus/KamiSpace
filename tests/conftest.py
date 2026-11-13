"""Shared fixtures.

Each test gets a fresh data directory (database, uploads, backups…) created
from a template database that was migrated once per test session.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import reset_engine, session_scope

PASSWORD = "correct horse battery"

# Smallest valid PNG (1x1 transparent pixel).
PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000002000001e221bc330000000049454e44ae426082"
)


def _use_data_dir(monkeypatch: pytest.MonkeyPatch, data_dir: Path) -> None:
    monkeypatch.setenv("MINDDOCK_DATA_DIR", str(data_dir))
    monkeypatch.setenv("MINDDOCK_ENV", "development")
    reset_engine()
    get_settings.cache_clear()


@pytest.fixture(scope="session")
def template_data_dir(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    from app.cli import run_migrations

    data_dir = tmp_path_factory.mktemp("template-data")
    with pytest.MonkeyPatch.context() as monkeypatch:
        _use_data_dir(monkeypatch, data_dir)
        run_migrations()
        reset_engine()
    get_settings.cache_clear()
    yield data_dir


@pytest.fixture
def data_dir(
    tmp_path: Path, template_data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Path]:
    target = tmp_path / "data"
    target.mkdir()
    shutil.copy(template_data_dir / "database.sqlite3", target / "database.sqlite3")
    _use_data_dir(monkeypatch, target)
    yield target
    reset_engine()
    get_settings.cache_clear()


@pytest.fixture
def app(data_dir: Path):
    from app.main import create_app

    return create_app()


class ApiClient:
    """A browser-like client: keeps cookies and sends the CSRF header."""

    def __init__(self, app) -> None:
        self.http = TestClient(app, raise_server_exceptions=True)
        self.csrf: str | None = None
        self.user: dict[str, Any] | None = None

    def _headers(self, headers: dict[str, str] | None) -> dict[str, str]:
        merged = dict(headers or {})
        if self.csrf and "x-csrf-token" not in {k.lower() for k in merged}:
            merged["X-CSRF-Token"] = self.csrf
        return merged

    def request(self, method: str, url: str, **kwargs: Any):
        kwargs["headers"] = self._headers(kwargs.get("headers"))
        return self.http.request(method, url, **kwargs)

    def get(self, url: str, **kwargs: Any):
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any):
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any):
        return self.request("PUT", url, **kwargs)

    def patch(self, url: str, **kwargs: Any):
        return self.request("PATCH", url, **kwargs)

    def delete(self, url: str, **kwargs: Any):
        return self.request("DELETE", url, **kwargs)

    def login(self, identifier: str, password: str = PASSWORD):
        response = self.http.post(
            "/api/auth/login", json={"identifier": identifier, "password": password}
        )
        if response.status_code == 200:
            body = response.json()
            self.csrf = body["csrf_token"]
            self.user = body["user"]
        return response

    # -- conveniences used all over the tests ------------------------------

    @property
    def user_id(self) -> int:
        assert self.user is not None
        return self.user["id"]

    def bootstrap(self) -> dict[str, Any]:
        response = self.get("/api/bootstrap")
        assert response.status_code == 200, response.text
        return response.json()

    def personal_workspace_id(self) -> int:
        return next(w["id"] for w in self.bootstrap()["workspaces"] if w["kind"] == "personal")

    def create_page(self, title: str = "Page", **fields: Any) -> dict[str, Any]:
        if "workspace_id" not in fields and "parent_id" not in fields:
            fields["workspace_id"] = self.personal_workspace_id()
        response = self.post("/api/pages", json={"title": title, **fields})
        assert response.status_code == 201, response.text
        return response.json()

    def save(self, page: dict[str, Any], text: str, **extra: Any):
        return self.put(
            f"/api/pages/{page['id']}/content",
            json={"content": doc(text), "base_revision": page["revision"], **extra},
        )

    def upload(self, page_id: int, name: str = "pixel.png", data: bytes = PNG_BYTES):
        return self.post(f"/api/pages/{page_id}/files", files={"file": (name, data)})


def doc(*paragraphs: str) -> dict[str, Any]:
    return {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}
            if text
            else {"type": "paragraph"}
            for text in paragraphs
        ],
    }


def make_user(username: str, *, is_admin: bool = False) -> int:
    from app.services import auth

    with session_scope() as db:
        user = auth.create_user(
            db,
            username=username,
            email=f"{username}@example.com",
            password=PASSWORD,
            display_name=username.title(),
            is_admin=is_admin,
        )
        return user.id


@pytest.fixture
def client_factory(app):
    def factory(username: str | None = None, *, is_admin: bool = False) -> ApiClient:
        client = ApiClient(app)
        if username is not None:
            make_user(username, is_admin=is_admin)
            assert client.login(username).status_code == 200
        return client

    return factory


@pytest.fixture
def anon(client_factory) -> ApiClient:
    return client_factory()


@pytest.fixture
def admin(client_factory) -> ApiClient:
    return client_factory("admin", is_admin=True)


@pytest.fixture
def alice(client_factory) -> ApiClient:
    return client_factory("alice")


@pytest.fixture
def bob(client_factory) -> ApiClient:
    return client_factory("bob")


@pytest.fixture
def carol(client_factory) -> ApiClient:
    return client_factory("carol")

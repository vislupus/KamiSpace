"""Administration endpoints and backups."""

from __future__ import annotations

import io
import sqlite3
import zipfile

from sqlalchemy import select

from app.cli import main as cli_main
from app.config import get_settings
from app.db import reset_engine, session_scope
from app.models import AuditEvent
from app.services import backups
from tests.conftest import PASSWORD, PNG_BYTES, ApiClient, doc


def test_admin_endpoints_require_admin(alice):
    for method, url in [
        ("GET", "/api/admin/users"),
        ("POST", "/api/admin/users"),
        ("PATCH", "/api/admin/users/1"),
        ("POST", "/api/admin/users/1/password"),
        ("GET", "/api/admin/invites"),
        ("POST", "/api/admin/invites"),
        ("GET", "/api/admin/settings"),
        ("PUT", "/api/admin/settings"),
        ("GET", "/api/admin/workspaces"),
        ("GET", "/api/admin/backups"),
        ("POST", "/api/admin/backups"),
        ("GET", "/api/admin/backups/minddock-backup-20260101-000000.zip"),
        ("GET", "/api/admin/audit"),
    ]:
        body = {} if method in ("POST", "PATCH", "PUT") else None
        assert alice.request(method, url, json=body).status_code == 403, (method, url)


def test_admin_creates_users(admin, client_factory):
    response = admin.post(
        "/api/admin/users",
        json={
            "username": "Dana",
            "email": "Dana@Example.com",
            "display_name": "Dana Scully",
            "password": PASSWORD,
        },
    )
    assert response.status_code == 201
    created = response.json()
    assert (created["username"], created["email"]) == ("dana", "dana@example.com")
    assert created["is_admin"] is False

    dana = client_factory()
    assert dana.login("dana").status_code == 200
    assert [w["kind"] for w in dana.bootstrap()["workspaces"]] == ["personal"]

    duplicate = admin.post(
        "/api/admin/users",
        json={"username": "dana", "email": "other@example.com", "password": PASSWORD},
    )
    assert duplicate.status_code == 409
    weak = admin.post(
        "/api/admin/users",
        json={"username": "weak", "email": "weak@example.com", "password": "123"},
    )
    assert weak.status_code == 422
    bad_name = admin.post(
        "/api/admin/users",
        json={"username": "no spaces", "email": "x@example.com", "password": PASSWORD},
    )
    assert bad_name.status_code == 422


def test_admin_resets_password_and_signs_user_out(admin, alice, client_factory):
    response = admin.post(
        f"/api/admin/users/{alice.user_id}/password", json={"password": "a brand new password"}
    )
    assert response.status_code == 200
    assert alice.get("/api/bootstrap").status_code == 401
    assert client_factory().login("alice", "a brand new password").status_code == 200


def test_last_admin_cannot_be_demoted_or_deactivated(admin, alice):
    url = f"/api/admin/users/{admin.user_id}"
    assert admin.patch(url, json={"is_admin": False}).status_code == 409
    assert admin.patch(url, json={"is_active": False}).status_code == 409
    # With a second administrator it becomes possible.
    assert (
        admin.patch(f"/api/admin/users/{alice.user_id}", json={"is_admin": True}).status_code == 200
    )
    assert admin.patch(url, json={"is_admin": False}).status_code == 200
    assert admin.get("/api/admin/users").status_code == 403


def test_user_list_never_contains_password_hashes(admin, alice):
    response = admin.get("/api/admin/users")
    assert {u["username"] for u in response.json()} == {"admin", "alice"}
    assert "argon2" not in response.text and "password" not in response.text


def test_admin_workspace_overview_has_no_content(admin, alice):
    workspace = admin.post("/api/workspaces", json={"name": "Ops"}).json()
    overview = admin.get("/api/admin/workspaces").json()
    assert overview == [
        {"id": workspace["id"], "name": "Ops", "kind": "team", "role": "owner", "member_count": 1}
    ]
    assert all(w["kind"] == "team" for w in overview)  # personal workspaces are not listed


def test_sensitive_actions_are_audited(admin, alice):
    page = alice.create_page("Doc")
    alice.put(f"/api/pages/{page['id']}/shares/{admin.user_id}", json={"role": "viewer"})
    admin.post("/api/workspaces", json={"name": "Ops"})
    actions = [event["action"] for event in admin.get("/api/admin/audit").json()]
    for expected in ("auth.login", "page.shared", "workspace.created"):
        assert expected in actions
    with session_scope() as db:
        details = db.execute(select(AuditEvent.detail)).scalars().all()
    assert PASSWORD not in str(details)


# -- backups -----------------------------------------------------------------


def test_backup_contains_database_and_uploads(admin, alice):
    page = alice.create_page("Backed up")
    alice.save(page, "precious words")
    attachment = alice.upload(page["id"]).json()

    created = admin.post("/api/admin/backups")
    assert created.status_code == 201
    name = created.json()["name"]
    assert [b["name"] for b in admin.get("/api/admin/backups").json()] == [name]
    assert (get_settings().backups_dir / name).is_file()

    download = admin.get(f"/api/admin/backups/{name}")
    assert download.status_code == 200
    assert "attachment" in download.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
        names = set(archive.namelist())
        assert {"database.sqlite3", "manifest.json"} <= names
        stored = f"uploads/{attachment['id'][:2]}/{attachment['id']}"
        assert archive.read(stored) == PNG_BYTES
        database = archive.read("database.sqlite3")

    snapshot = get_settings().temp_dir / "check.sqlite3"
    snapshot.write_bytes(database)
    connection = sqlite3.connect(snapshot)
    try:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("SELECT title FROM pages").fetchall() == [("Backed up",)]
    finally:
        connection.close()

    assert admin.delete(f"/api/admin/backups/{name}").status_code == 200
    assert admin.get("/api/admin/backups").json() == []


def test_backup_names_cannot_escape_the_backup_directory(admin):
    for name in ("..%2Fdatabase.sqlite3", "database.sqlite3", "minddock-backup-x.zip"):
        assert admin.get(f"/api/admin/backups/{name}").status_code == 404
        assert admin.delete(f"/api/admin/backups/{name}").status_code == 404


def test_restore_round_trip(app, admin, alice):
    page = alice.create_page("Before backup")
    alice.save(page, "original text")
    attachment = alice.upload(page["id"]).json()
    archive = backups.create_backup()

    # Diverge from the backup: change text, add a page, lose the file.
    alice.save({"id": page["id"], "revision": 2}, "changed after backup")
    alice.create_page("Created after backup")
    for path in get_settings().uploads_dir.rglob("*"):
        if path.is_file():
            path.unlink()

    reset_engine()
    assert cli_main(["restore", str(archive), "--yes"]) == 0

    restored = ApiClient(app)
    assert restored.login("alice").status_code == 200
    pages = restored.bootstrap()["pages"]
    assert [p["title"] for p in pages] == ["Before backup"]
    assert restored.get(f"/api/pages/{page['id']}").json()["content"] == doc("original text")
    assert restored.get(attachment["url"]).content == PNG_BYTES
    assert [r["title"] for r in restored.get("/api/search?q=original").json()["results"]] == [
        "Before backup"
    ]
    # The replaced data was kept, not deleted.
    kept = list(get_settings().backups_dir.glob("pre-restore-*/database.sqlite3"))
    assert len(kept) == 1


def test_restore_ignores_unexpected_archive_members(data_dir, admin):
    archive = backups.create_backup()
    with zipfile.ZipFile(archive, "a") as bundle:
        bundle.writestr("../../evil.txt", "escaped")
        bundle.writestr("uploads/../../evil2.txt", "escaped")
        bundle.writestr("uploads/zz/not-a-valid-name", "ignored")
    reset_engine()
    backups.restore_backup(archive)
    assert not (data_dir.parent / "evil.txt").exists()
    assert not (data_dir.parent.parent / "evil.txt").exists()
    assert not list(data_dir.rglob("evil*"))
    assert [p for p in get_settings().uploads_dir.rglob("*") if p.is_file()] == []


def test_restore_rejects_foreign_archives(data_dir):
    bogus = data_dir / "bogus.zip"
    with zipfile.ZipFile(bogus, "w") as bundle:
        bundle.writestr("hello.txt", "hi")
    assert cli_main(["restore", str(bogus), "--yes"]) == 1
    assert get_settings().database_path.is_file()


def test_cli_creates_admin_and_resets_password(data_dir, app):
    args = ["--username", "root", "--email", "root@example.com", "--password", PASSWORD]
    assert cli_main(["create-admin", *args]) == 0
    assert cli_main(["create-admin", *args]) == 1  # already exists
    client = ApiClient(app)
    assert client.login("root").json()["user"]["is_admin"] is True
    assert cli_main(["reset-password", "root", "--password", "a different password"]) == 0
    assert ApiClient(app).login("root", "a different password").status_code == 200

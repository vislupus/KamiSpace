"""Uploads, downloads and attachment life cycle."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import get_settings
from tests.conftest import PNG_BYTES

PDF_BYTES = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def stored_files() -> list[Path]:
    return [p for p in get_settings().uploads_dir.rglob("*") if p.is_file()]


def image_doc(attachment_id: str) -> dict:
    return {
        "type": "doc",
        "content": [{"type": "image", "attrs": {"attachmentId": attachment_id}}],
    }


def test_upload_and_download_image(alice):
    page = alice.create_page("Gallery")
    uploaded = alice.upload(page["id"], "My Photo.PNG")
    assert uploaded.status_code == 201
    meta = uploaded.json()
    assert meta["kind"] == "image"
    assert meta["mime"] == "image/png"
    assert meta["size"] == len(PNG_BYTES)
    assert meta["name"] == "My Photo.PNG"

    response = alice.get(meta["url"])
    assert response.status_code == 200
    assert response.content == PNG_BYTES
    assert response.headers["content-type"] == "image/png"
    assert response.headers["content-disposition"].startswith("inline")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]


def test_files_are_stored_under_generated_names_inside_uploads(alice):
    page = alice.create_page("Gallery")
    meta = alice.upload(page["id"], "../../../etc/passwd.png").json()
    assert meta["name"] == "passwd.png"
    files = stored_files()
    assert len(files) == 1
    assert files[0].name == meta["id"]
    assert get_settings().uploads_dir.resolve() in files[0].resolve().parents


def test_pdf_is_inline_and_other_files_download(alice):
    page = alice.create_page("Docs")
    pdf = alice.upload(page["id"], "paper.pdf", PDF_BYTES).json()
    text = alice.upload(page["id"], "notes.md", b"# hello\n").json()
    assert pdf["kind"] == "pdf" and text["kind"] == "file"

    pdf_response = alice.get(pdf["url"])
    assert pdf_response.headers["content-type"] == "application/pdf"
    assert pdf_response.headers["content-disposition"].startswith("inline")
    forced = alice.get(pdf["url"] + "?download=1")
    assert forced.headers["content-disposition"].startswith("attachment")

    text_response = alice.get(text["url"])
    assert text_response.headers["content-disposition"].startswith("attachment")
    assert "filename*=UTF-8''notes.md" in text_response.headers["content-disposition"]


@pytest.mark.parametrize(
    ("name", "data"),
    [
        ("script.html", b"<script>alert(1)</script>"),
        ("vector.svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
        ("tool.exe", b"MZ\x90\x00"),
        ("noextension", b"data"),
        ("fake.png", b"<html><script>alert(1)</script></html>"),
        ("fake.pdf", PNG_BYTES),
        ("binary.txt", b"abc\x00def"),
        ("empty.png", b""),
    ],
)
def test_disallowed_or_mismatched_files_are_rejected(alice, name, data):
    page = alice.create_page("Uploads")
    response = alice.upload(page["id"], name, data)
    assert response.status_code == 422
    assert stored_files() == []
    assert list(get_settings().temp_dir.glob("upload-*")) == []


def test_upload_size_limit(alice, monkeypatch):
    monkeypatch.setenv("MINDDOCK_MAX_UPLOAD_MB", "1")
    get_settings.cache_clear()
    page = alice.create_page("Uploads")
    too_big = PNG_BYTES + b"\x00" * (1024 * 1024)
    response = alice.upload(page["id"], "big.png", too_big)
    assert response.status_code == 413
    assert stored_files() == []


def test_private_files_are_not_downloadable_by_others(alice, bob, anon):
    page = alice.create_page("Private")
    url = alice.upload(page["id"]).json()["url"]
    assert bob.get(url).status_code == 404
    assert anon.get(url).status_code == 401
    # The uploads directory is not exposed as static files either.
    name = stored_files()[0]
    assert anon.http.get(f"/static/uploads/{name.parent.name}/{name.name}").status_code == 404
    assert anon.http.get(f"/data/uploads/{name.parent.name}/{name.name}").status_code == 404


def test_unknown_and_malformed_file_ids(alice):
    assert alice.get("/api/files/" + "0" * 32).status_code == 404
    assert alice.get("/api/files/..%2F..%2Fdatabase.sqlite3").status_code == 404


def test_shared_viewers_can_download(alice, bob):
    page = alice.create_page("Shared")
    url = alice.upload(page["id"]).json()["url"]
    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "viewer"})
    assert bob.get(url).content == PNG_BYTES
    alice.delete(f"/api/pages/{page['id']}/shares/{bob.user_id}")
    assert bob.get(url).status_code == 404


def test_cannot_borrow_someone_elses_attachment(alice, bob):
    secret_page = alice.create_page("Private")
    attachment_id = alice.upload(secret_page["id"]).json()["id"]

    own = bob.create_page("Mine")
    saved = bob.put(
        f"/api/pages/{own['id']}/content",
        json={"content": image_doc(attachment_id), "base_revision": 1},
    )
    assert saved.status_code == 200  # the node is kept, but grants nothing
    assert bob.get(f"/api/files/{attachment_id}").status_code == 404
    cover = bob.patch(f"/api/pages/{own['id']}", json={"cover_attachment_id": attachment_id})
    assert cover.status_code == 422


def test_cover_image(alice):
    page = alice.create_page("With cover")
    attachment_id = alice.upload(page["id"]).json()["id"]
    response = alice.patch(f"/api/pages/{page['id']}", json={"cover_attachment_id": attachment_id})
    assert response.json()["cover_attachment_id"] == attachment_id
    assert alice.get(f"/api/pages/{page['id']}").json()["cover_attachment_id"] == attachment_id
    cleared = alice.patch(f"/api/pages/{page['id']}", json={"cover_attachment_id": None})
    assert cleared.json()["cover_attachment_id"] is None


def test_files_survive_the_recycle_bin_and_go_with_permanent_deletion(alice):
    page = alice.create_page("Temp")
    url = alice.upload(page["id"]).json()["url"]
    alice.delete(f"/api/pages/{page['id']}")
    assert len(stored_files()) == 1
    assert alice.get(url).status_code == 200  # still viewable from the bin

    alice.post(f"/api/trash/{page['id']}/restore")
    assert alice.get(url).status_code == 200

    alice.delete(f"/api/pages/{page['id']}")
    assert alice.delete(f"/api/trash/{page['id']}").status_code == 200
    assert stored_files() == []
    assert alice.get(url).status_code == 404


def test_file_removed_from_content_stays_for_version_history(alice):
    page = alice.create_page("Doc")
    attachment_id = alice.upload(page["id"]).json()["id"]
    first = alice.put(
        f"/api/pages/{page['id']}/content",
        json={"content": image_doc(attachment_id), "base_revision": 1},
    ).json()
    alice.save({"id": page["id"], "revision": first["revision"]}, "image removed")
    assert alice.get(f"/api/files/{attachment_id}").status_code == 200
    assert len(stored_files()) == 1


def test_file_shared_by_a_duplicate_survives_deleting_the_original(alice):
    page = alice.create_page("Original")
    attachment_id = alice.upload(page["id"]).json()["id"]
    alice.put(
        f"/api/pages/{page['id']}/content",
        json={"content": image_doc(attachment_id), "base_revision": 1},
    )
    copy = alice.post(f"/api/pages/{page['id']}/duplicate").json()

    alice.delete(f"/api/pages/{page['id']}")
    alice.delete(f"/api/trash/{page['id']}")
    assert len(stored_files()) == 1
    assert alice.get(f"/api/files/{attachment_id}").status_code == 200

    alice.delete(f"/api/pages/{copy['id']}")
    alice.delete(f"/api/trash/{copy['id']}")
    assert stored_files() == []

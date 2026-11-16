"""Page appearance, locking, cover position, sub-page links, tasks, media, remote fetch."""

from __future__ import annotations

import socket

import pytest

from app.config import get_settings
from app.errors import ValidationFailed
from app.services import remote
from tests.conftest import PNG_BYTES, doc


def task_doc(*items: tuple[str, str, int | None, bool]) -> dict:
    return {
        "type": "doc",
        "content": [
            {
                "type": "taskList",
                "content": [
                    {
                        "type": "taskItem",
                        "attrs": {
                            "checked": checked,
                            "taskId": key,
                            "assignee": assignee,
                            "due": None,
                        },
                        "content": [
                            {"type": "paragraph", "content": [{"type": "text", "text": text}]}
                        ],
                    }
                    for key, text, assignee, checked in items
                ],
            }
        ],
    }


# -- appearance, cover, lock --------------------------------------------------


def test_appearance_and_cover_position_are_saved(alice):
    page = alice.create_page("Styled")
    assert (page["font"], page["small_text"], page["full_width"], page["cover_position"]) == (
        "default",
        False,
        False,
        50,
    )
    response = alice.patch(
        f"/api/pages/{page['id']}",
        json={"font": "serif", "small_text": True, "full_width": True, "cover_position": 12},
    )
    assert response.status_code == 200
    stored = alice.get(f"/api/pages/{page['id']}").json()
    assert (stored["font"], stored["small_text"], stored["full_width"]) == ("serif", True, True)
    assert stored["cover_position"] == 12
    assert alice.patch(f"/api/pages/{page['id']}", json={"font": "comic"}).status_code == 422
    assert alice.patch(f"/api/pages/{page['id']}", json={"cover_position": 140}).status_code == 422


def test_locked_page_rejects_every_change_until_unlocked(alice):
    page = alice.create_page("Contract")
    saved = alice.save(page, "final text").json()
    assert alice.patch(f"/api/pages/{page['id']}", json={"locked": True}).json()["locked"] is True

    blocked = alice.put(
        f"/api/pages/{page['id']}/content",
        json={"content": doc("tampered"), "base_revision": saved["revision"]},
    )
    assert blocked.status_code == 423
    assert blocked.json()["error"]["code"] == "locked"
    assert alice.patch(f"/api/pages/{page['id']}", json={"title": "Renamed"}).status_code == 423
    assert alice.patch(f"/api/pages/{page['id']}", json={"font": "mono"}).status_code == 423
    version = alice.get(f"/api/pages/{page['id']}/versions").json()[0]
    restore = alice.post(f"/api/pages/{page['id']}/versions/{version['id']}/restore")
    assert restore.status_code == 423
    assert alice.get(f"/api/pages/{page['id']}").json()["content"] == doc("final text")

    assert alice.patch(f"/api/pages/{page['id']}", json={"locked": False}).status_code == 200
    again = alice.put(
        f"/api/pages/{page['id']}/content",
        json={"content": doc("edited"), "base_revision": saved["revision"]},
    )
    assert again.status_code == 200


def test_viewers_cannot_lock_or_unlock(alice, bob):
    page = alice.create_page("Shared")
    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "viewer"})
    assert bob.patch(f"/api/pages/{page['id']}", json={"locked": True}).status_code == 403


# -- sub-page links -----------------------------------------------------------


def test_new_sub_page_is_linked_at_the_end_of_its_parent(alice):
    parent = alice.create_page("Handbook")
    alice.save(parent, "intro")
    child = alice.create_page("Chapter 1", parent_id=parent["id"])
    second = alice.create_page("Chapter 2", parent_id=parent["id"])

    stored = alice.get(f"/api/pages/{parent['id']}").json()
    assert stored["content"]["content"] == [
        {"type": "paragraph", "content": [{"type": "text", "text": "intro"}]},
        {"type": "pageLink", "attrs": {"pageId": child["id"]}},
        {"type": "pageLink", "attrs": {"pageId": second["id"]}},
        {"type": "paragraph"},
    ]
    assert stored["revision"] == 4  # one save + two links


def test_sub_page_link_can_be_left_to_the_editor(alice):
    parent = alice.create_page("Handbook")
    alice.post(
        "/api/pages", json={"title": "Inline", "parent_id": parent["id"], "link_in_parent": False}
    )
    stored = alice.get(f"/api/pages/{parent['id']}").json()
    assert stored["content"]["content"] == [{"type": "paragraph"}]
    assert stored["revision"] == 1


def test_locked_parent_is_not_modified_by_new_sub_pages(alice):
    parent = alice.create_page("Frozen")
    alice.patch(f"/api/pages/{parent['id']}", json={"locked": True})
    alice.create_page("Child", parent_id=parent["id"])
    assert alice.get(f"/api/pages/{parent['id']}").json()["content"]["content"] == [
        {"type": "paragraph"}
    ]


# -- tasks --------------------------------------------------------------------


def test_assigned_tasks_show_up_in_my_tasks(alice, bob):
    page = alice.create_page("Sprint")
    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "editor"})
    content = task_doc(
        ("t-write", "Write the report", bob.user_id, False),
        ("t-review", "Review it", alice.user_id, False),
        ("t-done", "Already done", bob.user_id, True),
        ("t-free", "Nobody's job", None, False),
    )
    saved = alice.put(
        f"/api/pages/{page['id']}/content", json={"content": content, "base_revision": 1}
    )
    assert saved.status_code == 200

    mine = bob.get("/api/tasks").json()
    assert [(t["task_key"], t["text"], t["checked"]) for t in mine] == [
        ("t-write", "Write the report", False)
    ]
    assert mine[0]["page_title"] == "Sprint" and mine[0]["can_toggle"] is True
    assert {t["task_key"] for t in bob.get("/api/tasks?done=true").json()} == {"t-write", "t-done"}
    assert bob.bootstrap()["open_tasks"] == 1
    assert [t["task_key"] for t in alice.get("/api/tasks").json()] == ["t-review"]


def test_ticking_a_task_from_the_list_updates_the_page(alice, bob):
    page = alice.create_page("Sprint")
    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "editor"})
    alice.put(
        f"/api/pages/{page['id']}/content",
        json={"content": task_doc(("task-1", "Ship it", bob.user_id, False)), "base_revision": 1},
    )
    done = bob.put(f"/api/pages/{page['id']}/tasks/task-1", json={"checked": True})
    assert done.status_code == 200
    assert done.json() == {"revision": 3, "open_tasks": 0}
    stored = alice.get(f"/api/pages/{page['id']}").json()
    assert stored["content"]["content"][0]["content"][0]["attrs"]["checked"] is True
    assert bob.get("/api/tasks").json() == []
    assert (
        bob.put(f"/api/pages/{page['id']}/tasks/missing", json={"checked": True}).status_code == 404
    )


def test_tasks_respect_permissions_trash_and_lock(alice, bob, carol):
    page = alice.create_page("Private plan")
    alice.put(
        f"/api/pages/{page['id']}/content",
        json={"content": task_doc(("task-1", "Secret task", bob.user_id, False)), "base_revision": 1},
    )
    # Assigned, but the page was never shared with bob: nothing leaks.
    assert bob.get("/api/tasks").json() == []
    assert bob.bootstrap()["open_tasks"] == 0
    assert bob.put(f"/api/pages/{page['id']}/tasks/task-1", json={"checked": True}).status_code == 404

    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "viewer"})
    listed = bob.get("/api/tasks").json()
    assert [t["can_toggle"] for t in listed] == [False]  # viewers see, but cannot tick
    assert bob.put(f"/api/pages/{page['id']}/tasks/task-1", json={"checked": True}).status_code == 403
    assert carol.get("/api/tasks").json() == []

    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "editor"})
    alice.patch(f"/api/pages/{page['id']}", json={"locked": True})
    assert bob.put(f"/api/pages/{page['id']}/tasks/task-1", json={"checked": True}).status_code == 423
    alice.patch(f"/api/pages/{page['id']}", json={"locked": False})

    alice.delete(f"/api/pages/{page['id']}")
    assert bob.get("/api/tasks").json() == []
    alice.post(f"/api/trash/{page['id']}/restore")
    assert len(bob.get("/api/tasks").json()) == 1


def test_removing_a_task_from_the_page_removes_it_from_the_list(alice):
    page = alice.create_page("Todo")
    saved = alice.put(
        f"/api/pages/{page['id']}/content",
        json={"content": task_doc(("task-1", "Temporary", alice.user_id, False)), "base_revision": 1},
    ).json()
    assert len(alice.get("/api/tasks").json()) == 1
    alice.save({"id": page["id"], "revision": saved["revision"]}, "no tasks any more")
    assert alice.get("/api/tasks").json() == []


def test_library_data_includes_modification_time(alice):
    alice.create_page("Listed")
    page = alice.bootstrap()["pages"][0]
    assert page["updated_at"].startswith("20")
    assert alice.bootstrap()["users"] == [{"id": alice.user_id, "username": "alice"}]


# -- media --------------------------------------------------------------------

MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 64
MP3 = b"ID3\x03\x00" + b"\x00" * 64
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 32
OGG = b"OggS" + b"\x00" * 64


@pytest.mark.parametrize(
    ("name", "data", "kind", "mime"),
    [
        ("clip.mp4", MP4, "video", "video/mp4"),
        ("clip.webm", WEBM, "video", "video/webm"),
        ("song.mp3", MP3, "audio", "audio/mpeg"),
        ("voice.wav", WAV, "audio", "audio/wav"),
        ("voice.ogg", OGG, "audio", "audio/ogg"),
    ],
)
def test_video_and_audio_uploads_play_inline(alice, name, data, kind, mime):
    page = alice.create_page("Media")
    uploaded = alice.upload(page["id"], name, data)
    assert uploaded.status_code == 201
    meta = uploaded.json()
    assert (meta["kind"], meta["mime"]) == (kind, mime)
    response = alice.get(meta["url"])
    assert response.headers["content-disposition"].startswith("inline")
    assert response.headers["content-type"] == mime
    # Seeking needs byte ranges.
    partial = alice.get(meta["url"], headers={"Range": "bytes=0-9"})
    assert partial.status_code == 206
    assert len(partial.content) == 10


def test_media_must_match_its_type(alice):
    page = alice.create_page("Media")
    assert alice.upload(page["id"], "fake.mp4", PNG_BYTES).status_code == 422
    assert alice.upload(page["id"], "fake.mp3", b"<html>").status_code == 422


# -- fetching web addresses ----------------------------------------------------


def resolver(*addresses: str):
    def fake(host, port, *args, **kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port)) for address in addresses
        ]

    return fake


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.5", "192.168.1.10", "172.16.4.4", "169.254.169.254", "0.0.0.0", "::1"],
)
def test_private_and_local_addresses_are_refused(monkeypatch, address):
    monkeypatch.setattr(socket, "getaddrinfo", resolver(address))
    with pytest.raises(ValidationFailed):
        remote.public_address("intranet.example", 80)


def test_a_host_with_any_private_address_is_refused(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", resolver("93.184.216.34", "10.0.0.1"))
    with pytest.raises(ValidationFailed):
        remote.public_address("rebind.example", 443)
    monkeypatch.setattr(socket, "getaddrinfo", resolver("93.184.216.34"))
    assert remote.public_address("example.com", 443) == "93.184.216.34"


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://x",
        "http://user:pw@example.com/",
        "http:///x",
    ],
)
def test_only_plain_web_addresses_are_fetched(url):
    with pytest.raises(ValidationFailed):
        remote.split_target(url)


def test_redirects_are_checked_like_the_first_address(data_dir, monkeypatch):
    calls: list[str] = []

    def fake_request(url, accept, limit):
        calls.append(url)
        remote.split_target(url)
        if "start" in url:
            return 302, {"location": "http://169.254.169.254/latest/meta-data"}, b""
        remote.public_address("169.254.169.254", 80)  # what the real request does first
        return 200, {}, b"secret"

    monkeypatch.setattr(remote, "_request", fake_request)
    with pytest.raises(ValidationFailed):
        remote.fetch("https://example.com/start", accept="*/*", limit=100)
    assert calls == ["https://example.com/start", "http://169.254.169.254/latest/meta-data"]


def test_bookmark_metadata_is_read_from_the_page(data_dir, monkeypatch, alice):
    html = (
        "<html><head><title> Plain   title </title>"
        '<meta property="og:title" content="Open Graph title">'
        '<meta name="description" content="A short   description."></head>'
        "<body><script>alert(1)</script></body></html>"
    )
    monkeypatch.setattr(
        remote,
        "_request",
        lambda url, accept, limit: (200, {"content-type": "text/html"}, html.encode()),
    )
    response = alice.post("/api/bookmarks", json={"url": "https://example.com/article"})
    assert response.status_code == 200
    assert response.json() == {
        "url": "https://example.com/article",
        "title": "Open Graph title",
        "description": "A short description.",
    }


def test_remote_images_are_stored_as_attachments(data_dir, monkeypatch, alice, bob):
    monkeypatch.setattr(remote, "_request", lambda url, accept, limit: (200, {}, PNG_BYTES))
    page = alice.create_page("Clippings")
    imported = alice.post(
        f"/api/pages/{page['id']}/files/remote", json={"url": "https://example.com/pics/cat.jpeg"}
    )
    assert imported.status_code == 201
    meta = imported.json()
    assert (meta["kind"], meta["name"]) == ("image", "cat.png")  # named after the real content
    assert alice.get(meta["url"]).content == PNG_BYTES
    denied = bob.post(
        f"/api/pages/{page['id']}/files/remote", json={"url": "https://example.com/x.png"}
    )
    assert denied.status_code == 404

    monkeypatch.setattr(
        remote, "_request", lambda url, accept, limit: (200, {}, b"<html>not an image")
    )
    rejected = alice.post(
        f"/api/pages/{page['id']}/files/remote", json={"url": "https://example.com/x"}
    )
    assert rejected.status_code == 422


def test_remote_fetching_can_be_switched_off(data_dir, monkeypatch, alice):
    monkeypatch.setenv("KAMISPACE_ALLOW_REMOTE_FETCH", "false")
    get_settings.cache_clear()
    response = alice.post("/api/bookmarks", json={"url": "https://example.com"})
    assert response.status_code == 403
    assert alice.bootstrap()["limits"]["remote_fetch"] is False


def test_settings_written_for_the_old_name_still_apply(monkeypatch, tmp_path):
    legacy = "MIND" + "DOCK_MAX_UPLOAD_MB"
    monkeypatch.setenv(legacy, "7")
    monkeypatch.delenv("KAMISPACE_MAX_UPLOAD_MB", raising=False)
    get_settings.cache_clear()
    assert get_settings().max_upload_mb == 7
    get_settings.cache_clear()

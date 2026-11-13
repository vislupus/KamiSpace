"""Version history, restore and optimistic concurrency."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import update

from app.db import session_scope, utcnow
from app.models import PageVersion
from tests.conftest import doc


def versions_of(client, page_id: int) -> list[dict]:
    response = client.get(f"/api/pages/{page_id}/versions")
    assert response.status_code == 200
    return response.json()


def age_versions(minutes: int) -> None:
    """Pretend all existing versions were created some time ago."""
    with session_scope() as db:
        db.execute(update(PageVersion).values(created_at=utcnow() - timedelta(minutes=minutes)))


def save(client, page_id: int, text: str, base: int, **extra):
    return client.put(
        f"/api/pages/{page_id}/content",
        json={"content": doc(text), "base_revision": base, **extra},
    )


def test_autosaves_are_folded_into_one_version(alice):
    page = alice.create_page("Notes")
    revision = page["revision"]
    for text in ("h", "he", "hello"):
        revision = save(alice, page["id"], text, revision).json()["revision"]
    history = versions_of(alice, page["id"])
    assert len(history) == 1
    assert history[0]["number"] == 1
    assert history[0]["author_name"] == "Alice"
    detail = alice.get(f"/api/pages/{page['id']}/versions/{history[0]['id']}").json()
    assert detail["content"] == doc("hello")


def test_new_version_after_the_interval(alice):
    page = alice.create_page("Notes")
    first = save(alice, page["id"], "morning", 1).json()
    age_versions(minutes=60)
    save(alice, page["id"], "afternoon", first["revision"])
    history = versions_of(alice, page["id"])
    assert [v["number"] for v in history] == [2, 1]
    older = alice.get(f"/api/pages/{page['id']}/versions/{history[1]['id']}").json()
    assert older["content"] == doc("morning")


def test_a_different_author_starts_a_new_version(alice, bob):
    page = alice.create_page("Shared")
    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "editor"})
    first = save(alice, page["id"], "by alice", 1).json()
    save(bob, page["id"], "by bob", first["revision"])
    history = versions_of(alice, page["id"])
    assert [(v["number"], v["author_name"]) for v in history] == [(2, "Bob"), (1, "Alice")]


def test_manual_snapshot_with_description(alice):
    page = alice.create_page("Spec")
    revision = save(alice, page["id"], "draft", 1).json()["revision"]
    created = alice.post(f"/api/pages/{page['id']}/versions", json={"description": "Before review"})
    assert created.status_code == 201
    assert created.json()["kind"] == "manual"
    save(alice, page["id"], "after review", revision)
    history = versions_of(alice, page["id"])
    assert [(v["number"], v["kind"], v["description"]) for v in history] == [
        (3, "auto", None),
        (2, "manual", "Before review"),
        (1, "auto", None),
    ]
    snapshot = alice.get(f"/api/pages/{page['id']}/versions/{history[1]['id']}").json()
    assert snapshot["content"] == doc("draft")


def test_restore_creates_a_new_version_and_keeps_history(alice):
    page = alice.create_page("Essay")
    first = save(alice, page["id"], "first draft", 1).json()
    age_versions(minutes=60)
    save(alice, page["id"], "ruined", first["revision"])
    original = versions_of(alice, page["id"])[-1]

    restored = alice.post(f"/api/pages/{page['id']}/versions/{original['id']}/restore")
    assert restored.status_code == 200
    body = restored.json()
    assert body["content"] == doc("first draft")
    assert body["revision"] == 4

    history = versions_of(alice, page["id"])
    assert [(v["number"], v["kind"]) for v in history] == [
        (3, "restore"),
        (2, "auto"),
        (1, "auto"),
    ]
    assert history[0]["description"] == "Restored from version 1"
    ruined = alice.get(f"/api/pages/{page['id']}/versions/{history[1]['id']}").json()
    assert ruined["content"] == doc("ruined")


def test_restore_also_restores_the_title(alice):
    page = alice.create_page("Original title")
    save(alice, page["id"], "text", 1)
    age_versions(minutes=60)
    alice.patch(f"/api/pages/{page['id']}", json={"title": "Changed title"})
    history = versions_of(alice, page["id"])
    assert [v["title"] for v in history] == ["Changed title", "Original title"]
    alice.post(f"/api/pages/{page['id']}/versions/{history[-1]['id']}/restore")
    assert alice.get(f"/api/pages/{page['id']}").json()["title"] == "Original title"


def test_viewers_can_read_history_but_not_restore(alice, bob):
    page = alice.create_page("Doc")
    save(alice, page["id"], "v1", 1)
    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "viewer"})
    version = versions_of(bob, page["id"])[0]
    assert bob.get(f"/api/pages/{page['id']}/versions/{version['id']}").status_code == 200
    restore = bob.post(f"/api/pages/{page['id']}/versions/{version['id']}/restore")
    assert restore.status_code == 403
    assert bob.post(f"/api/pages/{page['id']}/versions", json={}).status_code == 403


def test_versions_are_scoped_to_their_page(alice, bob):
    secret = alice.create_page("Secret")
    save(alice, secret["id"], "classified", 1)
    secret_version = versions_of(alice, secret["id"])[0]
    own = bob.create_page("Bob's")
    # A version id from another page must not be reachable through a page bob owns.
    assert bob.get(f"/api/pages/{own['id']}/versions/{secret_version['id']}").status_code == 404
    restore = bob.post(f"/api/pages/{own['id']}/versions/{secret_version['id']}/restore")
    assert restore.status_code == 404


def test_stale_save_is_rejected_with_conflict(alice, client_factory):
    page = alice.create_page("Shared doc")
    other_tab = client_factory()
    other_tab.login("alice")

    assert save(alice, page["id"], "from tab one", 1).status_code == 200
    conflict = save(other_tab, page["id"], "from tab two", 1)
    assert conflict.status_code == 409
    error = conflict.json()["error"]
    assert error["code"] == "conflict"
    assert error["current_revision"] == 2
    assert error["updated_by_name"] == "Alice"
    # Nothing was overwritten.
    assert alice.get(f"/api/pages/{page['id']}").json()["content"] == doc("from tab one")


def test_concurrent_editors_conflict(alice, bob):
    page = alice.create_page("Shared doc")
    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "editor"})
    assert save(bob, page["id"], "bob was first", 1).status_code == 200
    conflict = save(alice, page["id"], "alice is late", 1)
    assert conflict.status_code == 409
    assert conflict.json()["error"]["updated_by_name"] == "Bob"


def test_forced_overwrite_keeps_the_other_version_in_history(alice, client_factory):
    page = alice.create_page("Doc")
    other_tab = client_factory()
    other_tab.login("alice")
    save(alice, page["id"], "theirs", 1)

    forced = save(other_tab, page["id"], "mine", 1, force=True)
    assert forced.status_code == 200
    assert forced.json()["revision"] == 3
    assert alice.get(f"/api/pages/{page['id']}").json()["content"] == doc("mine")

    history = versions_of(alice, page["id"])
    assert len(history) == 2  # same author, but not folded: nothing is lost
    theirs = alice.get(f"/api/pages/{page['id']}/versions/{history[1]['id']}").json()
    assert theirs["content"] == doc("theirs")


def test_forced_overwrite_is_never_folded_even_with_a_current_base(alice, client_factory):
    """The client may resolve a conflict by re-sending with the latest revision."""
    page = alice.create_page("Doc")
    other_tab = client_factory()
    other_tab.login("alice")
    theirs = save(alice, page["id"], "theirs", 1).json()

    forced = save(other_tab, page["id"], "mine", theirs["revision"], force=True)
    assert forced.status_code == 200
    history = versions_of(alice, page["id"])
    assert len(history) == 2
    kept = alice.get(f"/api/pages/{page['id']}/versions/{history[1]['id']}").json()
    assert kept["content"] == doc("theirs")


def test_restore_bumps_revision_so_open_editors_conflict(alice):
    page = alice.create_page("Doc")
    first = save(alice, page["id"], "one", 1).json()
    version = versions_of(alice, page["id"])[0]
    alice.post(f"/api/pages/{page['id']}/versions/{version['id']}/restore")
    assert save(alice, page["id"], "typed meanwhile", first["revision"]).status_code == 409

"""Pages, hierarchy, recycle bin, favourites, quick capture."""

from __future__ import annotations

from tests.conftest import doc


def tree(client) -> dict[int, dict]:
    return {p["id"]: p for p in client.bootstrap()["pages"]}


def test_create_and_read_page(alice):
    page = alice.create_page("Ideas", icon="💡")
    assert page["title"] == "Ideas"
    assert page["icon"] == "💡"
    assert page["role"] == "owner"
    assert page["revision"] == 1
    assert page["content"] == {"type": "doc", "content": [{"type": "paragraph"}]}
    assert page["owner_name"] == "Alice"
    fetched = alice.get(f"/api/pages/{page['id']}").json()
    assert fetched["title"] == "Ideas"
    assert fetched["breadcrumbs"] == []


def test_create_requires_a_location(alice):
    assert alice.post("/api/pages", json={"title": "x"}).status_code == 422


def test_unknown_fields_are_rejected(alice):
    response = alice.post(
        "/api/pages", json={"title": "x", "workspace_id": 1, "owner_id": 99, "role": "owner"}
    )
    assert response.status_code == 422


def test_nested_pages_and_breadcrumbs(alice):
    root = alice.create_page("Team")
    docs = alice.create_page("Documentation", parent_id=root["id"])
    backend = alice.create_page("Backend", parent_id=docs["id"])
    assert backend["workspace_id"] == root["workspace_id"]
    assert [b["title"] for b in backend["breadcrumbs"]] == ["Team", "Documentation"]
    pages = tree(alice)
    assert pages[backend["id"]]["parent_id"] == docs["id"]
    assert pages[docs["id"]]["parent_id"] == root["id"]
    assert pages[root["id"]]["parent_id"] is None


def test_rename_and_icon(alice):
    page = alice.create_page("Old")
    response = alice.patch(
        f"/api/pages/{page['id']}", json={"title": "  New   name ", "icon": "🚀"}
    )
    assert response.status_code == 200
    assert response.json()["title"] == "New name"
    assert alice.patch(f"/api/pages/{page['id']}", json={"icon": None}).json()["icon"] is None
    assert alice.get(f"/api/pages/{page['id']}").json()["title"] == "New name"


def test_save_content_increments_revision(alice):
    page = alice.create_page("Notes")
    response = alice.save(page, "hello world")
    assert response.status_code == 200
    assert response.json()["revision"] == 2
    fetched = alice.get(f"/api/pages/{page['id']}").json()
    assert fetched["content"] == doc("hello world")
    assert fetched["updated_by_name"] == "Alice"


def test_saving_identical_content_is_a_no_op(alice):
    page = alice.create_page("Notes")
    first = alice.save(page, "same").json()
    again = alice.put(
        f"/api/pages/{page['id']}/content",
        json={"content": doc("same"), "base_revision": first["revision"]},
    ).json()
    assert again["revision"] == first["revision"]


def test_new_pages_are_appended_in_order(alice):
    ids = [alice.create_page(name)["id"] for name in ("a", "b", "c")]
    ordered = sorted(tree(alice).values(), key=lambda p: p["position"])
    assert [p["id"] for p in ordered] == ids


def test_reorder_with_before_and_after(alice):
    a, b, c = (alice.create_page(name) for name in ("a", "b", "c"))

    def order() -> list[str]:
        return [p["title"] for p in sorted(tree(alice).values(), key=lambda p: p["position"])]

    alice.post(f"/api/pages/{c['id']}/move", json={"parent_id": None, "before_id": a["id"]})
    assert order() == ["c", "a", "b"]
    alice.post(f"/api/pages/{c['id']}/move", json={"parent_id": None, "after_id": a["id"]})
    assert order() == ["a", "c", "b"]
    alice.post(f"/api/pages/{a['id']}/move", json={"parent_id": None})
    assert order() == ["c", "b", "a"]


def test_move_page_under_another(alice):
    a = alice.create_page("a")
    b = alice.create_page("b")
    child = alice.create_page("child", parent_id=a["id"])
    response = alice.post(f"/api/pages/{child['id']}/move", json={"parent_id": b["id"]})
    assert response.status_code == 200
    assert tree(alice)[child["id"]]["parent_id"] == b["id"]
    crumbs = alice.get(f"/api/pages/{child['id']}").json()["breadcrumbs"]
    assert [c["title"] for c in crumbs] == ["b"]


def test_page_cannot_be_moved_into_its_own_subtree(alice):
    a = alice.create_page("a")
    b = alice.create_page("b", parent_id=a["id"])
    c = alice.create_page("c", parent_id=b["id"])
    for target in (a, b, c):
        response = alice.post(f"/api/pages/{a['id']}/move", json={"parent_id": target["id"]})
        assert response.status_code == 422


def test_duplicate_copies_subtree(alice):
    root = alice.create_page("Guide")
    alice.save(root, "root text")
    child = alice.create_page("Chapter", parent_id=root["id"])
    alice.save(child, "chapter text")

    copy = alice.post(f"/api/pages/{root['id']}/duplicate").json()
    assert copy["title"] == "Guide (copy)"
    pages = tree(alice)
    copied_children = [p for p in pages.values() if p["parent_id"] == copy["id"]]
    assert [p["title"] for p in copied_children] == ["Chapter"]
    assert copied_children[0]["id"] != child["id"]
    assert alice.get(f"/api/pages/{copy['id']}").json()["content"] == doc("root text")
    # The copy sits right after the original.
    ordered = sorted(
        (p for p in pages.values() if p["parent_id"] is None), key=lambda p: p["position"]
    )
    assert [p["title"] for p in ordered] == ["Guide", "Guide (copy)"]


def test_trash_hides_subtree_and_restore_brings_it_back(alice):
    root = alice.create_page("Project")
    child = alice.create_page("Spec", parent_id=root["id"])
    assert alice.delete(f"/api/pages/{root['id']}").status_code == 200

    assert tree(alice) == {}
    assert (
        alice.put(
            f"/api/pages/{child['id']}/content", json={"content": doc("x"), "base_revision": 1}
        ).status_code
        == 404
    )

    trash = alice.get("/api/trash").json()
    assert [(t["title"], t["nested_count"]) for t in trash] == [("Project", 1)]
    # A trashed page can still be opened read-only (to check before restoring).
    assert alice.get(f"/api/pages/{root['id']}").json()["deleted_at"] is not None

    assert alice.post(f"/api/trash/{root['id']}/restore").status_code == 200
    assert set(tree(alice)) == {root["id"], child["id"]}
    assert alice.get("/api/trash").json() == []


def test_restore_child_whose_parent_is_still_in_trash(alice):
    root = alice.create_page("Parent")
    child = alice.create_page("Child", parent_id=root["id"])
    alice.delete(f"/api/pages/{child['id']}")
    alice.delete(f"/api/pages/{root['id']}")
    assert {t["title"] for t in alice.get("/api/trash").json()} == {"Parent", "Child"}

    assert alice.post(f"/api/trash/{child['id']}/restore").status_code == 200
    pages = tree(alice)
    assert pages[child["id"]]["parent_id"] is None  # moved to the workspace root
    assert root["id"] not in pages


def test_permanent_delete_requires_trash_first(alice):
    page = alice.create_page("Keep")
    assert alice.delete(f"/api/trash/{page['id']}").status_code == 409
    alice.delete(f"/api/pages/{page['id']}")
    assert alice.delete(f"/api/trash/{page['id']}").status_code == 200
    assert alice.get(f"/api/pages/{page['id']}").status_code == 404
    assert alice.get("/api/trash").json() == []


def test_empty_trash(alice):
    for name in ("a", "b"):
        alice.delete(f"/api/pages/{alice.create_page(name)['id']}")
    keep = alice.create_page("keep")
    assert alice.delete("/api/trash").json() == {"purged": 2}
    assert set(tree(alice)) == {keep["id"]}


def test_favorites(alice):
    page = alice.create_page("Fav")
    assert alice.put(f"/api/pages/{page['id']}/favorite").status_code == 200
    assert alice.bootstrap()["favorites"] == [page["id"]]
    assert alice.get(f"/api/pages/{page['id']}").json()["is_favorite"] is True
    alice.delete(f"/api/pages/{page['id']}")
    assert alice.bootstrap()["favorites"] == []  # hidden while in the bin
    alice.post(f"/api/trash/{page['id']}/restore")
    assert alice.delete(f"/api/pages/{page['id']}/favorite").status_code == 200
    assert alice.bootstrap()["favorites"] == []


def test_recent_pages_are_most_recent_first(alice):
    a = alice.create_page("a")
    b = alice.create_page("b")
    alice.get(f"/api/pages/{a['id']}")
    alice.get(f"/api/pages/{b['id']}")
    alice.get(f"/api/pages/{a['id']}")
    assert alice.bootstrap()["recents"][:2] == [a["id"], b["id"]]


def test_quick_capture_goes_to_personal_inbox(alice):
    first = alice.post("/api/capture", json={"text": "Call the plumber\nbefore Friday"}).json()
    second = alice.post("/api/capture", json={"text": "Second thought"}).json()
    pages = tree(alice)
    inbox = next(p for p in pages.values() if p["title"] == "Inbox")
    assert pages[first["id"]]["parent_id"] == inbox["id"] == pages[second["id"]]["parent_id"]
    assert first["title"] == "Call the plumber"
    content = alice.get(f"/api/pages/{first['id']}").json()["content"]
    assert content == doc("Call the plumber", "before Friday")


def test_quick_capture_recreates_a_deleted_inbox(alice):
    alice.post("/api/capture", json={"text": "one"})
    inbox = next(p for p in tree(alice).values() if p["title"] == "Inbox")
    alice.delete(f"/api/pages/{inbox['id']}")
    alice.post("/api/capture", json={"text": "two"})
    titles = sorted(p["title"] for p in tree(alice).values())
    assert titles == ["Inbox", "two"]

"""Access control: private pages, sharing, inheritance, workspaces."""

from __future__ import annotations

import pytest

from tests.conftest import doc


def visible_ids(client) -> set[int]:
    return {p["id"] for p in client.bootstrap()["pages"]}


def share(owner, page_id: int, user, role: str = "viewer"):
    response = owner.put(f"/api/pages/{page_id}/shares/{user.user_id}", json={"role": role})
    assert response.status_code == 200, response.text
    return response


@pytest.fixture
def team(admin, alice, bob):
    """A team workspace: admin owns it, alice edits, bob views."""
    workspace = admin.post("/api/workspaces", json={"name": "Engineering"}).json()
    for member, role in ((alice, "editor"), (bob, "viewer")):
        response = admin.put(
            f"/api/workspaces/{workspace['id']}/members/{member.user_id}", json={"role": role}
        )
        assert response.status_code == 200
    return workspace


# -- private by default -------------------------------------------------------


def test_pages_are_private_by_default(alice, bob):
    page = alice.create_page("Diary")
    alice.save(page, "secret")
    page_id = page["id"]

    assert bob.get(f"/api/pages/{page_id}").status_code == 404
    assert bob.patch(f"/api/pages/{page_id}", json={"title": "x"}).status_code == 404
    assert (
        bob.put(
            f"/api/pages/{page_id}/content", json={"content": doc("x"), "base_revision": 2}
        ).status_code
        == 404
    )
    assert bob.delete(f"/api/pages/{page_id}").status_code == 404
    assert bob.post(f"/api/pages/{page_id}/duplicate").status_code == 404
    assert bob.post(f"/api/pages/{page_id}/move", json={"parent_id": None}).status_code == 404
    assert bob.get(f"/api/pages/{page_id}/versions").status_code == 404
    assert bob.get(f"/api/pages/{page_id}/shares").status_code == 404
    assert bob.put(f"/api/pages/{page_id}/favorite").status_code == 404
    assert bob.post("/api/pages", json={"title": "x", "parent_id": page_id}).status_code == 404
    assert page_id not in visible_ids(bob)


def test_administrators_cannot_read_private_pages(admin, alice):
    page = alice.create_page("Private")
    assert admin.get(f"/api/pages/{page['id']}").status_code == 404
    assert page["id"] not in visible_ids(admin)
    assert admin.get("/api/search?q=Private").json()["results"] == []


def test_cannot_create_pages_in_someone_elses_workspace(alice, bob):
    response = bob.post(
        "/api/pages", json={"title": "x", "workspace_id": alice.personal_workspace_id()}
    )
    assert response.status_code == 404


# -- sharing with specific users ---------------------------------------------


def test_viewer_can_read_but_not_change(alice, bob):
    page = alice.create_page("Handbook")
    alice.save(page, "welcome")
    share(alice, page["id"], bob, "viewer")

    fetched = bob.get(f"/api/pages/{page['id']}")
    assert fetched.status_code == 200
    body = fetched.json()
    assert (body["role"], body["can_edit"], body["can_manage"]) == ("viewer", False, False)
    assert body["workspace_name"] is None  # not a member of alice's workspace

    page_id = page["id"]
    assert (
        bob.put(
            f"/api/pages/{page_id}/content", json={"content": doc("x"), "base_revision": 2}
        ).status_code
        == 403
    )
    assert bob.patch(f"/api/pages/{page_id}", json={"title": "x"}).status_code == 403
    assert bob.delete(f"/api/pages/{page_id}").status_code == 403
    assert bob.post("/api/pages", json={"title": "x", "parent_id": page_id}).status_code == 403
    assert bob.upload(page_id).status_code == 403
    assert bob.get(f"/api/pages/{page_id}/versions").status_code == 200


def test_editor_can_change_but_not_manage(alice, bob, carol):
    page = alice.create_page("Plan")
    share(alice, page["id"], bob, "editor")
    page_id = page["id"]

    assert (
        bob.put(
            f"/api/pages/{page_id}/content", json={"content": doc("from bob"), "base_revision": 1}
        ).status_code
        == 200
    )
    assert bob.patch(f"/api/pages/{page_id}", json={"title": "Plan B"}).status_code == 200
    assert bob.post("/api/pages", json={"title": "sub", "parent_id": page_id}).status_code == 201
    assert bob.upload(page_id).status_code == 201

    # Sharing and permanent deletion stay with the owner.
    assert (
        bob.put(f"/api/pages/{page_id}/shares/{carol.user_id}", json={"role": "viewer"}).status_code
        == 403
    )
    assert bob.delete(f"/api/pages/{page_id}/shares/{bob.user_id}").status_code == 403
    assert bob.delete(f"/api/pages/{page_id}").status_code == 200  # recycle bin is allowed
    assert bob.delete(f"/api/trash/{page_id}").status_code == 403
    assert alice.post(f"/api/trash/{page_id}/restore").status_code == 200


def test_share_role_must_be_viewer_or_editor(alice, bob):
    page = alice.create_page("Plan")
    response = alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "owner"})
    assert response.status_code == 422


def test_permissions_are_inherited_by_nested_pages(alice, bob):
    root = alice.create_page("Docs")
    child = alice.create_page("API", parent_id=root["id"])
    grandchild = alice.create_page("Auth", parent_id=child["id"])
    sibling = alice.create_page("Unrelated")
    share(alice, child["id"], bob, "editor")

    assert bob.get(f"/api/pages/{root['id']}").status_code == 404
    assert bob.get(f"/api/pages/{sibling['id']}").status_code == 404
    assert bob.get(f"/api/pages/{child['id']}").json()["role"] == "editor"
    nested = bob.get(f"/api/pages/{grandchild['id']}").json()
    assert nested["role"] == "editor"
    # Breadcrumbs stop at what bob may see.
    assert [b["title"] for b in nested["breadcrumbs"]] == ["API"]

    pages = {p["id"]: p for p in bob.bootstrap()["pages"]}
    assert set(pages) == {child["id"], grandchild["id"]}
    assert pages[child["id"]]["shared"] is True
    assert pages[child["id"]]["parent_id"] is None  # hidden parent is not revealed
    assert pages[grandchild["id"]]["parent_id"] == child["id"]


def test_strongest_grant_wins_along_the_chain(alice, bob):
    root = alice.create_page("Docs")
    child = alice.create_page("API", parent_id=root["id"])
    share(alice, root["id"], bob, "editor")
    share(alice, child["id"], bob, "viewer")
    assert bob.get(f"/api/pages/{child['id']}").json()["role"] == "editor"


def test_pages_created_by_a_guest_belong_to_the_shared_tree(alice, bob):
    root = alice.create_page("Docs")
    share(alice, root["id"], bob, "editor")
    created = bob.post("/api/pages", json={"title": "Bob's page", "parent_id": root["id"]}).json()
    assert created["role"] == "editor"  # guests never become owners
    assert alice.get(f"/api/pages/{created['id']}").json()["role"] == "owner"


def test_revoking_a_share_removes_access(alice, bob):
    root = alice.create_page("Docs")
    child = alice.create_page("API", parent_id=root["id"])
    share(alice, root["id"], bob, "editor")
    assert bob.get(f"/api/pages/{child['id']}").status_code == 200
    assert alice.delete(f"/api/pages/{root['id']}/shares/{bob.user_id}").status_code == 200
    assert bob.get(f"/api/pages/{root['id']}").status_code == 404
    assert bob.get(f"/api/pages/{child['id']}").status_code == 404
    assert visible_ids(bob) == set()


def test_share_listing_shows_direct_and_inherited_access(alice, bob, carol):
    root = alice.create_page("Docs")
    child = alice.create_page("API", parent_id=root["id"])
    share(alice, root["id"], bob, "viewer")
    listing = share(alice, child["id"], carol, "editor").json()
    assert [(s["username"], s["role"]) for s in listing["direct"]] == [("carol", "editor")]
    assert [(s["username"], s["from_title"]) for s in listing["inherited"]] == [("bob", "Docs")]
    assert listing["can_manage"] is True
    assert bob.get(f"/api/pages/{child['id']}/shares").json()["can_manage"] is False


def test_guest_cannot_move_shared_page_out_of_its_tree(alice, bob):
    root = alice.create_page("Docs")
    child = alice.create_page("API", parent_id=root["id"])
    share(alice, root["id"], bob, "editor")
    own = bob.create_page("Mine")
    steal = bob.post(f"/api/pages/{child['id']}/move", json={"parent_id": own["id"]})
    assert steal.status_code == 403
    to_root = bob.post(
        f"/api/pages/{child['id']}/move",
        json={"parent_id": None, "workspace_id": bob.personal_workspace_id()},
    )
    assert to_root.status_code == 403


def test_viewer_duplicate_lands_in_own_workspace(alice, bob):
    page = alice.create_page("Template")
    alice.save(page, "reusable")
    share(alice, page["id"], bob, "viewer")
    copy = bob.post(f"/api/pages/{page['id']}/duplicate").json()
    assert copy["workspace_id"] == bob.personal_workspace_id()
    assert copy["role"] == "owner"
    assert copy["id"] not in visible_ids(alice)


def test_user_directory_lists_only_public_fields(alice, bob):
    people = alice.get("/api/users?q=bo").json()
    assert people == [{"id": bob.user_id, "username": "bob", "display_name": "Bob"}]
    # Email addresses are neither returned nor searchable; wildcards are literal.
    assert alice.get("/api/users?q=example.com").json() == []
    assert alice.get("/api/users", params={"q": "%"}).json() == []
    assert alice.get("/api/users", params={"q": "b_b"}).json() == []


# -- team workspaces ---------------------------------------------------------


def test_only_admins_create_workspaces(alice):
    assert alice.post("/api/workspaces", json={"name": "Nope"}).status_code == 403


def test_workspace_roles(admin, alice, bob, carol, team):
    workspace_id = team["id"]
    page = alice.post("/api/pages", json={"title": "Runbook", "workspace_id": workspace_id}).json()
    page_id = page["id"]
    assert page["role"] == "owner"  # a member owns the pages they create

    assert bob.get(f"/api/pages/{page_id}").json()["role"] == "viewer"
    assert (
        bob.put(
            f"/api/pages/{page_id}/content", json={"content": doc("x"), "base_revision": 1}
        ).status_code
        == 403
    )
    assert (
        bob.post("/api/pages", json={"title": "x", "workspace_id": workspace_id}).status_code == 403
    )

    assert admin.get(f"/api/pages/{page_id}").json()["role"] == "owner"
    assert carol.get(f"/api/pages/{page_id}").status_code == 404
    assert page_id in visible_ids(bob)
    assert page_id not in visible_ids(carol)


def test_editor_edits_team_pages_but_only_owner_manages(admin, alice, bob, team):
    page = admin.post("/api/pages", json={"title": "Policy", "workspace_id": team["id"]}).json()
    page_id = page["id"]
    assert alice.get(f"/api/pages/{page_id}").json()["role"] == "editor"
    assert (
        alice.put(
            f"/api/pages/{page_id}/content", json={"content": doc("x"), "base_revision": 1}
        ).status_code
        == 200
    )
    assert (
        alice.put(f"/api/pages/{page_id}/shares/{bob.user_id}", json={"role": "editor"}).status_code
        == 403
    )


def test_removed_member_loses_access_even_to_pages_they_created(admin, alice, team):
    page = alice.post("/api/pages", json={"title": "Mine", "workspace_id": team["id"]}).json()
    response = admin.delete(f"/api/workspaces/{team['id']}/members/{alice.user_id}")
    assert response.status_code == 200
    assert alice.get(f"/api/pages/{page['id']}").status_code == 404
    assert admin.get(f"/api/pages/{page['id']}").status_code == 200


def test_workspace_membership_management_is_restricted(alice, bob, carol, team):
    url = f"/api/workspaces/{team['id']}/members/{carol.user_id}"
    assert alice.put(url, json={"role": "viewer"}).status_code == 404  # editors cannot manage
    assert carol.put(url, json={"role": "owner"}).status_code == 404  # outsiders see nothing
    assert carol.get(f"/api/workspaces/{team['id']}/members").status_code == 404
    assert bob.get(f"/api/workspaces/{team['id']}/members").status_code == 200


def test_workspace_keeps_at_least_one_owner(admin, team):
    url = f"/api/workspaces/{team['id']}/members/{admin.user_id}"
    assert admin.put(url, json={"role": "editor"}).status_code == 409
    assert admin.delete(url).status_code == 409


def test_personal_workspaces_cannot_be_shared_or_deleted(admin, alice, bob):
    workspace_id = alice.personal_workspace_id()
    url = f"/api/workspaces/{workspace_id}"
    assert admin.put(f"{url}/members/{admin.user_id}", json={"role": "owner"}).status_code == 404
    assert alice.put(f"{url}/members/{bob.user_id}", json={"role": "viewer"}).status_code == 409
    assert alice.delete(url).status_code == 409


def test_moving_between_workspaces_requires_ownership(admin, alice, team):
    owned = alice.create_page("Draft")
    alice.create_page("Section", parent_id=owned["id"])
    moved = alice.post(
        f"/api/pages/{owned['id']}/move", json={"parent_id": None, "workspace_id": team["id"]}
    )
    assert moved.status_code == 200
    in_team = [p for p in admin.bootstrap()["pages"] if p["workspace_id"] == team["id"]]
    assert sorted(p["title"] for p in in_team) == ["Draft", "Section"]

    policy = admin.post("/api/pages", json={"title": "Policy", "workspace_id": team["id"]}).json()
    takeover = alice.post(
        f"/api/pages/{policy['id']}/move",
        json={"parent_id": None, "workspace_id": alice.personal_workspace_id()},
    )
    assert takeover.status_code == 403


def test_deleting_a_workspace_removes_its_pages(admin, alice, team):
    page = alice.post("/api/pages", json={"title": "Gone", "workspace_id": team["id"]}).json()
    assert alice.delete(f"/api/workspaces/{team['id']}").status_code == 404
    assert admin.delete(f"/api/workspaces/{team['id']}").status_code == 200
    assert alice.get(f"/api/pages/{page['id']}").status_code == 404
    assert [w["kind"] for w in alice.bootstrap()["workspaces"]] == ["personal"]


def test_trash_only_lists_pages_the_user_can_edit(alice, bob):
    private = alice.create_page("Private")
    shared = alice.create_page("Shared")
    share(alice, shared["id"], bob, "editor")
    alice.delete(f"/api/pages/{private['id']}")
    alice.delete(f"/api/pages/{shared['id']}")
    assert [t["title"] for t in bob.get("/api/trash").json()] == ["Shared"]
    assert bob.post(f"/api/trash/{private['id']}/restore").status_code == 404
    assert bob.delete(f"/api/trash/{private['id']}").status_code == 404

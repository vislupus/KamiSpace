"""Full-text search and its permission filter."""

from __future__ import annotations

from app.services.search import MARK_END, MARK_START


def search(client, query: str) -> list[dict]:
    response = client.get("/api/search", params={"q": query})
    assert response.status_code == 200, response.text
    return response.json()["results"]


def titles(client, query: str) -> list[str]:
    return [r["title"] for r in search(client, query)]


def test_search_titles_and_content(alice):
    recipe = alice.create_page("Pancake recipe")
    alice.save(recipe, "Mix flour, eggs and buttermilk until smooth")
    alice.create_page("Meeting notes")

    assert titles(alice, "pancake") == ["Pancake recipe"]
    assert titles(alice, "buttermilk") == ["Pancake recipe"]
    assert titles(alice, "butter") == ["Pancake recipe"]  # prefix match
    assert titles(alice, "flour eggs") == ["Pancake recipe"]
    assert titles(alice, "nonexistent") == []


def test_results_include_highlighted_snippet(alice):
    page = alice.create_page("Notes")
    alice.save(page, "The quick brown fox jumps over the lazy dog")
    result = search(alice, "fox")[0]
    assert f"{MARK_START}fox{MARK_END}" in result["snippet"]
    assert "<" not in result["snippet"]


def test_title_matches_rank_above_body_matches(alice):
    body = alice.create_page("Something else")
    alice.save(body, "a note that mentions kubernetes once")
    alice.create_page("Kubernetes")
    assert titles(alice, "kubernetes") == ["Kubernetes", "Something else"]


def test_search_follows_edits_renames_and_trash(alice):
    page = alice.create_page("Draft")
    saved = alice.save(page, "alpha").json()
    assert titles(alice, "alpha") == ["Draft"]

    alice.save({"id": page["id"], "revision": saved["revision"]}, "beta")
    assert titles(alice, "alpha") == []
    assert titles(alice, "beta") == ["Draft"]

    alice.patch(f"/api/pages/{page['id']}", json={"title": "Final"})
    assert titles(alice, "draft") == []
    assert titles(alice, "final") == ["Final"]

    alice.delete(f"/api/pages/{page['id']}")
    assert titles(alice, "final") == []
    alice.post(f"/api/trash/{page['id']}/restore")
    assert titles(alice, "final") == ["Final"]


def test_search_by_hierarchy(alice):
    parent = alice.create_page("Deployment")
    child = alice.create_page("Checklist", parent_id=parent["id"])
    results = search(alice, "deployment checklist")
    assert [r["id"] for r in results] == [child["id"]]
    assert results[0]["path"] == ["Deployment"]

    alice.patch(f"/api/pages/{parent['id']}", json={"title": "Release"})
    assert titles(alice, "deployment checklist") == []
    assert titles(alice, "release checklist") == ["Checklist"]


def test_search_never_returns_inaccessible_pages(alice, bob, admin):
    page = alice.create_page("Salary review")
    alice.save(page, "confidential numbers")
    for outsider in (bob, admin):
        assert search(outsider, "salary") == []
        assert search(outsider, "confidential") == []

    alice.put(f"/api/pages/{page['id']}/shares/{bob.user_id}", json={"role": "viewer"})
    assert titles(bob, "confidential") == ["Salary review"]
    alice.delete(f"/api/pages/{page['id']}/shares/{bob.user_id}")
    assert search(bob, "confidential") == []


def test_shared_subtree_does_not_leak_ancestor_titles(alice, bob):
    hidden = alice.create_page("Acquisition of Initech")
    shared = alice.create_page("Meeting agenda", parent_id=hidden["id"])
    alice.put(f"/api/pages/{shared['id']}/shares/{bob.user_id}", json={"role": "viewer"})

    # Bob finds the page by its own words…
    result = search(bob, "agenda")[0]
    assert result["title"] == "Meeting agenda"
    assert result["path"] == []
    # …but cannot probe the titles of ancestors he may not see.
    assert search(bob, "initech") == []
    assert search(bob, "acquisition agenda") == []
    # The owner still can.
    assert titles(alice, "initech agenda") == ["Meeting agenda"]


def test_search_handles_special_characters(alice):
    page = alice.create_page("C++ notes")
    alice.save(page, 'He said "hello" — AND then left (quietly) *')
    for query in ['"', "AND", "OR NOT", "(", "*", "hello*", 'a"b', "title:hello", "-", "NEAR(", ""]:
        search(alice, query)  # must not raise
    assert titles(alice, '"hello"') == ["C++ notes"]
    assert titles(alice, "AND") == ["C++ notes"]


def test_search_is_unicode_aware(alice):
    page = alice.create_page("Бележки")
    alice.save(page, "Кафе и crème brûlée")
    assert titles(alice, "бележки") == ["Бележки"]
    assert titles(alice, "КАФЕ") == ["Бележки"]
    assert titles(alice, "creme brulee") == ["Бележки"]

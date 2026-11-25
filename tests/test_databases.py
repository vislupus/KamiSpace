"""Databases: schema allow-list, rows as pages, permissions."""

from __future__ import annotations

from app.services.databases import clean_props, default_schema, sanitize_schema


def make_database(client, title="Projects", view="table", parent_id=None):
    body = {"title": title, "view": view}
    if parent_id is None:
        body["workspace_id"] = client.personal_workspace_id()
    else:
        body["parent_id"] = parent_id
    response = client.post("/api/databases", json=body)
    assert response.status_code == 201, response.text
    return client.get(f"/api/databases/{response.json()['id']}").json()


def prop(database, name):
    return next(p for p in database["properties"] if p["name"] == name)


def test_a_new_database_has_a_title_status_and_two_views(alice):
    database = make_database(alice, view="board")
    assert [p["type"] for p in database["properties"]] == ["title", "status", "person", "date"]
    assert [v["type"] for v in database["views"]] == ["board", "table"]
    assert database["views"][0]["groupBy"] == prop(database, "Status")["id"]
    assert [o["name"] for o in prop(database, "Status")["options"]] == [
        "Not started",
        "In progress",
        "Done",
    ]
    assert database["rows"] == [] and database["can_edit"] is True
    # It is a page: listed in the tree, with its kind.
    tree = {p["id"]: p for p in alice.get("/api/tree").json()["pages"]}
    assert tree[database["id"]]["kind"] == "database"
    assert alice.get(f"/api/pages/{database['id']}").json()["kind"] == "database"
    # An ordinary page is not a database.
    page = alice.create_page("Plain")
    assert alice.get(f"/api/databases/{page['id']}").status_code == 404


def test_rows_are_sub_pages_with_checked_property_values(alice, bob):
    database = make_database(alice)
    status, person, date = (prop(database, n) for n in ("Status", "Assignee", "Date"))
    done = status["options"][2]["id"]
    created = alice.post(
        f"/api/databases/{database['id']}/rows",
        json={
            "title": "  Write   the spec ",
            "props": {
                status["id"]: done,
                person["id"]: [bob.user_id, 99999, bob.user_id],
                date["id"]: {"start": "2026-11-20", "end": "2026-11-25"},
                "unknown": "dropped",
                "title": "not a value",
            },
        },
    )
    assert created.status_code == 201
    row = created.json()
    assert row["title"] == "Write the spec"
    assert row["props"] == {
        status["id"]: done,
        person["id"]: [bob.user_id],
        date["id"]: {"start": "2026-11-20", "end": "2026-11-25"},
    }

    # Partial update: only the listed properties change; null clears one.
    updated = alice.patch(
        f"/api/databases/{database['id']}/rows/{row['id']}",
        json={"props": {status["id"]: "no-such-option", date["id"]: None}, "title": "Spec"},
    ).json()
    assert updated["title"] == "Spec"
    assert updated["props"] == {person["id"]: [bob.user_id]}

    # A row is a page of its own: it can be opened, and knows its database.
    page = alice.get(f"/api/pages/{row['id']}").json()
    assert page["title"] == "Spec"
    assert page["row"]["database_id"] == database["id"]
    assert page["row"]["props"] == {person["id"]: [bob.user_id]}
    assert [p["name"] for p in page["row"]["properties"]] == ["Name", "Status", "Assignee", "Date"]
    # Rows are marked in the tree (the sidebar leaves them out) and are not
    # linked into the database page's own content.
    tree = {p["id"]: p for p in alice.get("/api/tree").json()["pages"]}
    assert tree[row["id"]]["is_row"] is True and tree[database["id"]]["is_row"] is False
    assert alice.get(f"/api/pages/{database['id']}").json()["content"]["content"] == [
        {"type": "paragraph"}
    ]
    # Found by search like any page.
    assert [hit["id"] for hit in alice.get("/api/search?q=Spec").json()["results"]] == [row["id"]]


def test_rows_keep_their_order_and_can_be_moved(alice):
    database = make_database(alice)
    url = f"/api/databases/{database['id']}/rows"
    first, second, third = (alice.post(url, json={"title": t}).json() for t in "abc")

    def order():
        return [r["title"] for r in alice.get(f"/api/databases/{database['id']}").json()["rows"]]

    assert order() == ["a", "b", "c"]
    alice.patch(f"{url}/{third['id']}", json={"before_id": first["id"]})
    assert order() == ["c", "a", "b"]
    alice.patch(f"{url}/{third['id']}", json={"after_id": second["id"]})
    assert order() == ["a", "b", "c"]
    top = alice.post(url, json={"title": "top", "before_id": first["id"]}).json()
    assert order() == ["top", "a", "b", "c"]
    # A deleted row goes to the recycle bin and leaves the database.
    assert alice.delete(f"/api/pages/{top['id']}").status_code == 200
    assert order() == ["a", "b", "c"]
    alice.post(f"/api/trash/{top['id']}/restore")
    assert "top" in order()


def test_changing_the_schema_drops_values_that_no_longer_fit(alice):
    database = make_database(alice)
    status = prop(database, "Status")
    keep, drop = status["options"][0]["id"], status["options"][1]["id"]
    url = f"/api/databases/{database['id']}"
    rows = [
        alice.post(f"{url}/rows", json={"title": t, "props": {status["id"]: o}}).json()
        for t, o in (("kept", keep), ("dropped", drop))
    ]
    properties = [p for p in database["properties"] if p["name"] != "Date"]
    properties[1] = {**status, "options": [o for o in status["options"] if o["id"] != drop]}
    properties.append({"id": "pnum", "name": "Estimate", "type": "number", "format": "bar"})
    properties.append({"id": "bad id!", "name": "x", "type": "text"})
    properties.append({"id": "pwhat", "name": "x", "type": "rollup"})
    properties.append({"id": "title2", "name": "Second title", "type": "title"})
    updated = alice.patch(url, json={"properties": properties})
    assert updated.status_code == 200
    body = updated.json()
    assert [(p["name"], p["type"]) for p in body["properties"]] == [
        ("Name", "title"),
        ("Status", "status"),
        ("Assignee", "person"),
        ("Estimate", "number"),
    ]
    assert body["properties"][3]["format"] == "bar"
    values = {r["title"]: r["props"] for r in body["rows"]}
    assert values == {"kept": {status["id"]: keep}, "dropped": {}}
    assert len(rows) == 2

    number = alice.patch(f"{url}/rows/{rows[0]['id']}", json={"props": {"pnum": "12,5"}}).json()
    assert number["props"]["pnum"] == 12.5
    assert alice.patch(f"{url}/rows/{rows[0]['id']}", json={"props": {"pnum": "abc"}}).json()[
        "props"
    ] == {status["id"]: keep}


def test_views_are_checked_against_the_properties(alice):
    database = make_database(alice)
    status, date = prop(database, "Status"), prop(database, "Date")
    views = [
        {
            "id": "v1",
            "name": "  By   status ",
            "type": "board",
            "groupBy": date["id"],  # a date cannot group a board
            "hidden": ["title", date["id"], "ghost"],
            "sort": [{"property": date["id"], "direction": "desc"}, {"property": "ghost"}],
            "filter": [
                {"property": status["id"], "op": "is", "value": "x" * 500},
                {"property": status["id"], "op": "drop table", "value": 1},
            ],
        },
        {"id": "v2", "name": "", "type": "timeline"},
        {
            "id": "v3",
            "type": "table",
            "widths": {date["id"]: 5000, "ghost": 100},
            "calc": {date["id"]: "count", status["id"]: "explode"},
        },
    ]
    body = alice.patch(f"/api/databases/{database['id']}", json={"views": views}).json()
    board, table = body["views"]
    assert board["name"] == "By status" and board["groupBy"] == status["id"]
    assert board["hidden"] == [date["id"]]
    assert board["sort"] == [{"property": date["id"], "direction": "desc"}]
    assert board["filter"] == [{"property": status["id"], "op": "is", "value": "x" * 200}]
    assert table["type"] == "table" and table["name"] == "Table"
    assert table["widths"] == {date["id"]: 900} and table["calc"] == {date["id"]: "count"}
    # A database always keeps at least one view.
    assert (
        len(alice.patch(f"/api/databases/{database['id']}", json={"views": []}).json()["views"])
        == 1
    )


def test_database_permissions_follow_the_page(alice, bob, carol):
    database = make_database(alice)
    url = f"/api/databases/{database['id']}"
    row = alice.post(f"{url}/rows", json={"title": "Private row"}).json()
    # Not shared: the database does not exist for bob.
    assert bob.get(url).status_code == 404
    assert bob.post(f"{url}/rows", json={"title": "x"}).status_code == 404
    assert bob.get(f"/api/pages/{row['id']}").status_code == 404

    alice.put(f"/api/pages/{database['id']}/shares/{bob.user_id}", json={"role": "viewer"})
    seen = bob.get(url).json()
    assert seen["can_edit"] is False and [r["title"] for r in seen["rows"]] == ["Private row"]
    assert bob.post(f"{url}/rows", json={"title": "x"}).status_code == 403
    assert bob.patch(url, json={"views": []}).status_code == 403
    assert bob.patch(f"{url}/rows/{row['id']}", json={"title": "hacked"}).status_code == 403
    assert bob.get(f"/api/pages/{row['id']}").status_code == 200  # rows inherit access

    alice.put(f"/api/pages/{database['id']}/shares/{bob.user_id}", json={"role": "editor"})
    assert bob.post(f"{url}/rows", json={"title": "From bob"}).status_code == 201
    assert bob.patch(f"{url}/rows/{row['id']}", json={"title": "Edited"}).status_code == 200
    assert carol.get(url).status_code == 404
    # A row of one database cannot be edited through another.
    other = make_database(alice, "Other")
    assert (
        alice.patch(
            f"/api/databases/{other['id']}/rows/{row['id']}", json={"title": "x"}
        ).status_code
        == 404
    )
    # Locked: nothing changes until it is unlocked.
    alice.patch(f"/api/pages/{database['id']}", json={"locked": True})
    assert bob.post(f"{url}/rows", json={"title": "x"}).status_code == 423
    assert bob.patch(f"{url}/rows/{row['id']}", json={"title": "x"}).status_code == 423
    assert bob.patch(url, json={"views": []}).status_code == 423


def test_an_inline_database_is_a_block_and_survives_duplication(alice):
    host = alice.create_page("Host")
    database = make_database(alice, "Inline", parent_id=host["id"])
    status = prop(database, "Status")
    alice.post(
        f"/api/databases/{database['id']}/rows",
        json={"title": "Row", "props": {status["id"]: status["options"][0]["id"]}},
    )
    # No automatic link: the page shows the database through a block.
    stored = alice.get(f"/api/pages/{host['id']}").json()
    assert stored["content"]["content"] == [{"type": "paragraph"}]
    content = {
        "type": "doc",
        "content": [
            {"type": "database", "attrs": {"pageId": database["id"], "src": "https://x.example"}},
            {"type": "database", "attrs": {"pageId": "7"}},
        ],
    }
    saved = alice.put(
        f"/api/pages/{host['id']}/content",
        json={"content": content, "base_revision": stored["revision"]},
    )
    assert saved.status_code == 200
    blocks = alice.get(f"/api/pages/{host['id']}").json()["content"]["content"]
    assert blocks[0] == {"type": "database", "attrs": {"pageId": database["id"]}}
    assert [b["type"] for b in blocks] == ["database", "paragraph"]

    copy = alice.post(f"/api/pages/{host['id']}/duplicate").json()
    copied_blocks = alice.get(f"/api/pages/{copy['id']}").json()["content"]["content"]
    copied_id = copied_blocks[0]["attrs"]["pageId"]
    assert copied_id != database["id"]
    copied = alice.get(f"/api/databases/{copied_id}").json()
    assert [p["name"] for p in copied["properties"]] == [p["name"] for p in database["properties"]]
    assert [(r["title"], r["props"]) for r in copied["rows"]] == [
        ("Row", {status["id"]: status["options"][0]["id"]})
    ]


def test_schema_and_value_cleaning_units():
    schema = default_schema()
    assert sanitize_schema(schema) == schema
    assert sanitize_schema("nonsense")["properties"] == [
        {"id": "title", "name": "Name", "type": "title"}
    ]
    extra = sanitize_schema(
        {
            "properties": [
                *schema["properties"],
                {
                    "id": "ptags",
                    "name": "Tags",
                    "type": "multi_select",
                    "options": [
                        {"id": "a", "name": "A", "color": "red"},
                        {"id": "a", "name": "duplicate"},
                        {"id": "b", "name": "B", "color": "neon"},
                    ],
                },
                {"id": "purl", "name": "Link", "type": "url"},
                {"id": "pdone", "name": "Done", "type": "checkbox"},
                {"id": "ptext", "name": "Notes", "type": "text"},
            ],
            "views": schema["views"],
        }
    )
    tags = next(p for p in extra["properties"] if p["id"] == "ptags")
    assert tags["options"] == [
        {"id": "a", "name": "A", "color": "red"},
        {"id": "b", "name": "B", "color": "default"},
    ]
    cleaned = clean_props(
        extra,
        {
            "ptags": ["b", "zzz", "a", "b"],
            "purl": "javascript:alert(1)",
            "pdone": "yes",
            "ptext": "x" * 5000,
        },
        users=set(),
    )
    assert cleaned == {"ptags": ["b", "a"], "ptext": "x" * 2000}
    assert clean_props(extra, {"purl": " https://example.com ", "pdone": True}, set()) == {
        "purl": "https://example.com",
        "pdone": True,
    }


def test_status_options_have_a_stage_and_views_remember_wrapped_columns(alice):
    database = make_database(alice)
    status = prop(database, "Status")
    assert [(o["name"], o["group"]) for o in status["options"]] == [
        ("Not started", "todo"),
        ("In progress", "in_progress"),
        ("Done", "complete"),
    ]
    properties = [
        p
        if p["id"] != status["id"]
        else {
            **status,
            "options": [
                {**status["options"][0], "group": "complete"},
                {"id": "onew", "name": "Blocked", "color": "red", "group": "nonsense"},
                {"id": "oplain", "name": "Later"},
            ],
        }
        for p in database["properties"]
    ]
    properties.append(
        {
            "id": "ptag",
            "name": "Tag",
            "type": "select",
            "options": [
                {"id": "a", "name": "A", "color": "red", "group": "complete"},
            ],
        }
    )
    date = prop(database, "Date")
    views = [{**database["views"][0], "wrap": [date["id"], "ghost", date["id"]]}]
    body = alice.patch(
        f"/api/databases/{database['id']}", json={"properties": properties, "views": views}
    ).json()
    assert [(o["name"], o["group"]) for o in prop(body, "Status")["options"]] == [
        ("Not started", "complete"),
        ("Blocked", "todo"),
        ("Later", "todo"),
    ]
    # Only a status has stages.
    assert prop(body, "Tag")["options"] == [{"id": "a", "name": "A", "color": "red"}]
    assert body["views"][0]["wrap"] == [date["id"]]


def test_a_property_can_be_duplicated_with_its_values(alice, bob):
    database = make_database(alice)
    status = prop(database, "Status")
    url = f"/api/databases/{database['id']}"
    done = status["options"][2]["id"]
    first = alice.post(f"{url}/rows", json={"title": "a", "props": {status["id"]: done}}).json()
    alice.post(f"{url}/rows", json={"title": "b"})
    views = [{**database["views"][0], "order": ["title", status["id"]]}]
    alice.patch(url, json={"views": views})

    response = alice.post(f"{url}/properties/{status['id']}/duplicate")
    assert response.status_code == 201
    body = response.json()
    names = [p["name"] for p in body["properties"]]
    assert names == ["Name", "Status", "Status 1", "Assignee", "Date"]
    copy = prop(body, "Status 1")
    assert copy["id"] != status["id"] and copy["type"] == "status"
    assert [o["id"] for o in copy["options"]] == [o["id"] for o in status["options"]]
    values = {r["title"]: r["props"] for r in body["rows"]}
    assert values == {"a": {status["id"]: done, copy["id"]: done}, "b": {}}
    assert body["views"][0]["order"] == ["title", status["id"], copy["id"]]
    assert first["id"] in [r["id"] for r in body["rows"]]

    # A second copy gets the next free name; the title cannot be copied.
    again = alice.post(f"{url}/properties/{status['id']}/duplicate").json()
    assert "Status 2" in [p["name"] for p in again["properties"]]
    assert alice.post(f"{url}/properties/title/duplicate").status_code == 404
    assert alice.post(f"{url}/properties/ghost/duplicate").status_code == 404
    alice.put(f"/api/pages/{database['id']}/shares/{bob.user_id}", json={"role": "viewer"})
    assert bob.post(f"{url}/properties/{status['id']}/duplicate").status_code == 403


def test_a_status_without_a_stage_gets_one_from_its_name():
    cleaned = sanitize_schema(
        {
            "properties": [
                {"id": "title", "name": "Name", "type": "title"},
                {
                    "id": "ps",
                    "name": "Status",
                    "type": "status",
                    "options": [
                        {"id": "a", "name": "Not started"},
                        {"id": "b", "name": "In progress"},
                        {"id": "c", "name": "Done"},
                        {"id": "d", "name": "Готово"},
                        {"id": "e", "name": "Backlog"},
                    ],
                },
            ],
            "views": [],
        }
    )
    assert [o["group"] for o in cleaned["properties"][1]["options"]] == [
        "todo",
        "in_progress",
        "complete",
        "complete",
        "todo",
    ]

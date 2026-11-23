"""The calendar feed and dates with a time."""

from __future__ import annotations

from tests.test_databases import make_database, prop
from tests.test_features import task_doc


def add_row(client, database, title, value, **extra):
    date = prop(database, "Date")
    response = client.post(
        f"/api/databases/{database['id']}/rows",
        json={"title": title, "props": {date["id"]: value, **extra}},
    )
    assert response.status_code == 201, response.text
    return response.json()


def feed(client, start, end):
    response = client.get(f"/api/calendar?start={start}&end={end}")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_date_can_carry_a_time_and_must_exist(alice):
    database = make_database(alice)
    date = prop(database, "Date")
    cases = [
        ({"start": "2026-11-23T14:30", "end": "2026-11-23T16:00"}, None),
        ({"start": "2026-11-23T23:30", "end": "2026-11-24T01:00"}, None),  # across midnight
        ("2024-02-29", {"start": "2024-02-29"}),  # a leap day
        ({"start": "2026-02-29"}, "gone"),  # not a leap year
        ({"start": "2026-11-31"}, "gone"),
        ({"start": "2026-11-23T24:00"}, "gone"),
        ({"start": "2026-11-23T9:05"}, "gone"),
        ({"start": "23.11.2026"}, "gone"),
        # An end of another kind, or not after the start, is dropped.
        ({"start": "2026-11-23", "end": "2026-11-24T10:00"}, {"start": "2026-11-23"}),
        ({"start": "2026-11-23T10:00", "end": "2026-11-23T10:00"}, {"start": "2026-11-23T10:00"}),
        ({"start": "2026-12-31", "end": "2027-01-02"}, None),  # across New Year
    ]
    for value, expected in cases:
        row = add_row(alice, database, "x", value)
        if expected == "gone":
            assert date["id"] not in row["props"], value
        else:
            assert row["props"][date["id"]] == (expected or value), value


def test_the_calendar_lists_dated_rows_that_touch_the_range(alice):
    database = make_database(alice, "Events")
    status = prop(database, "Status")
    add_row(alice, database, "Before", "2026-10-31")
    add_row(alice, database, "First day", "2026-11-01")
    add_row(
        alice,
        database,
        "Meeting",
        {"start": "2026-11-23T14:30", "end": "2026-11-23T16:00"},
        **{status["id"]: status["options"][1]["id"]},
    )
    add_row(alice, database, "Spans in", {"start": "2026-10-28", "end": "2026-11-02"})
    add_row(alice, database, "Spans out", {"start": "2026-11-29", "end": "2026-12-05"})
    add_row(alice, database, "Late on the last day", "2026-11-30T23:59")
    add_row(alice, database, "After", "2026-12-01")
    alice.post(f"/api/databases/{database['id']}/rows", json={"title": "No date"})

    data = feed(alice, "2026-11-01", "2026-11-30")
    assert [item["title"] for item in data["items"]] == [
        "Spans in",
        "First day",
        "Meeting",
        "Spans out",
        "Late on the last day",
    ]
    meeting = data["items"][2]
    assert meeting["kind"] == "row" and meeting["database_title"] == "Events"
    assert (meeting["start"], meeting["end"]) == ("2026-11-23T14:30", "2026-11-23T16:00")
    assert meeting["color"] == "blue" and meeting["can_edit"] is True
    assert data["databases"] == [
        {
            "id": database["id"],
            "title": "Events",
            "icon": None,
            "can_edit": True,
            "date_properties": [{"id": prop(database, "Date")["id"], "name": "Date"}],
        }
    ]
    # A week that crosses New Year.
    add_row(alice, database, "New Year", {"start": "2026-12-31", "end": "2027-01-01"})
    assert [i["title"] for i in feed(alice, "2026-12-28", "2027-01-03")["items"]] == ["New Year"]
    assert feed(alice, "2027-01-01", "2027-01-01")["items"][0]["title"] == "New Year"

    # A trashed row disappears.
    gone = add_row(alice, database, "Cancelled", "2026-11-10")
    alice.delete(f"/api/pages/{gone['id']}")
    assert "Cancelled" not in [i["title"] for i in feed(alice, "2026-11-01", "2026-11-30")["items"]]


def test_the_calendar_only_shows_what_the_user_may_see(alice, bob, carol):
    shared = make_database(alice, "Team")
    private = make_database(alice, "Private")
    add_row(alice, shared, "Team event", "2026-11-23")
    add_row(alice, private, "Secret event", "2026-11-23")
    assert feed(bob, "2026-11-01", "2026-11-30") == {
        "start": "2026-11-01",
        "end": "2026-11-30",
        "items": [],
        "databases": [],
    }
    alice.put(f"/api/pages/{shared['id']}/shares/{bob.user_id}", json={"role": "viewer"})
    data = feed(bob, "2026-11-01", "2026-11-30")
    assert [(i["title"], i["can_edit"]) for i in data["items"]] == [("Team event", False)]
    assert [(d["title"], d["can_edit"]) for d in data["databases"]] == [("Team", False)]
    assert feed(carol, "2026-11-01", "2026-11-30")["items"] == []


def test_due_tasks_show_up_for_the_person_they_are_assigned_to(alice, bob):
    page = alice.create_page("Plan")
    content = task_doc(("task-due-1", "Send the files", bob.user_id, False))
    content["content"][0]["content"][0]["attrs"]["due"] = "2026-11-25"
    alice.put(f"/api/pages/{page['id']}/content", json={"content": content, "base_revision": 1})
    item = feed(bob, "2026-11-23", "2026-11-29")["items"][0]
    assert (item["kind"], item["title"], item["start"]) == ("task", "Send the files", "2026-11-25")
    # The page is not shared with bob: the task is all he gets.
    assert item["id"] is None and item["page_title"] is None
    assert feed(alice, "2026-11-23", "2026-11-29")["items"] == []
    assert feed(bob, "2026-11-26", "2026-11-29")["items"] == []


def test_the_range_is_checked(alice):
    assert alice.get("/api/calendar?start=2026-11-31&end=2026-12-01").status_code == 422
    assert alice.get("/api/calendar?start=2026-12-01&end=2026-11-01").status_code == 422
    assert alice.get("/api/calendar?start=2020-01-01&end=2026-01-01").status_code == 422
    assert alice.get("/api/calendar?start=2026-01-01").status_code == 422
    assert alice.get("/api/calendar?start=2024-02-29&end=2024-02-29").status_code == 200

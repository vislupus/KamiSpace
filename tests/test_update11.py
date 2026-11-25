"""Formulas, colours, linked databases, and what makes the server ready for many people."""

from __future__ import annotations

import logging
import multiprocessing
from pathlib import Path

from sqlalchemy import event

from app.db import get_engine
from app.logfile import SharedRotatingFileHandler
from app.services.databases import MAX_FORMULA, sanitize_schema
from tests.test_calendar import add_row, feed
from tests.test_databases import make_database, prop


class QueryCounter:
    """Counts the statements sent to the database inside a ``with`` block."""

    def __enter__(self):
        self.count = 0
        self._engine = get_engine()
        event.listen(self._engine, "before_cursor_execute", self._on_execute)
        return self

    def _on_execute(self, *_args) -> None:
        self.count += 1

    def __exit__(self, *_exc) -> None:
        event.remove(self._engine, "before_cursor_execute", self._on_execute)


# -- formulas -------------------------------------------------------------------------


def test_a_formula_is_part_of_the_schema_and_never_a_stored_value(alice):
    database = make_database(alice)
    url = f"/api/databases/{database['id']}"
    formula = {
        "id": "pdays",
        "name": "Days",
        "type": "formula",
        "expression": '  days(prop("Date"))  ',
        "format": "bar",
        "options": [{"id": "o1", "name": "ignored"}],
    }
    saved = alice.patch(url, json={"properties": [*database["properties"], formula]}).json()
    assert prop(saved, "Days") == {
        "id": "pdays",
        "name": "Days",
        "type": "formula",
        "format": "bar",
        "expression": 'days(prop("Date"))',
    }

    # A value sent for a formula is not kept, on a new row or on an existing one.
    row = alice.post(f"{url}/rows", json={"title": "Trip", "props": {"pdays": 99}}).json()
    assert row["props"] == {}
    row = alice.patch(f"{url}/rows/{row['id']}", json={"props": {"pdays": 5}}).json()
    assert row["props"] == {}

    # The text is only stored: it is cut to size and anything but text is dropped.
    cleaned = sanitize_schema(
        {
            "properties": [
                {"id": "a", "name": "A", "type": "formula", "expression": "x" * (MAX_FORMULA + 50)},
                {"id": "b", "name": "B", "type": "formula", "expression": {"$where": "1"}},
                {"id": "c", "name": "C", "type": "formula", "format": "nonsense"},
            ]
        }
    )
    by_id = {p["id"]: p for p in cleaned["properties"]}
    assert len(by_id["a"]["expression"]) == MAX_FORMULA
    assert by_id["b"]["expression"] == "" and by_id["c"] == {
        "id": "c",
        "name": "C",
        "type": "formula",
        "format": "number",
        "expression": "",
    }


def test_a_property_turned_into_a_formula_loses_its_stored_values(alice):
    database = make_database(alice)
    url = f"/api/databases/{database['id']}"
    number = {"id": "pnum", "name": "Hours", "type": "number"}
    alice.patch(url, json={"properties": [*database["properties"], number]})
    row = alice.post(f"{url}/rows", json={"title": "Job", "props": {"pnum": 8}}).json()
    assert row["props"] == {"pnum": 8}
    formula = {"id": "pnum", "name": "Hours", "type": "formula", "expression": "1 + 1"}
    saved = alice.patch(url, json={"properties": [*database["properties"], formula]}).json()
    assert saved["rows"][0]["props"] == {}


# -- colours --------------------------------------------------------------------------


def test_a_row_has_a_colour_of_its_own_beside_its_values(alice, bob):
    database = make_database(alice)
    url = f"/api/databases/{database['id']}"
    status = prop(database, "Status")
    done = status["options"][2]["id"]
    row = alice.post(
        f"{url}/rows", json={"title": "Painted", "color": "red", "props": {status["id"]: done}}
    ).json()
    assert row["color"] == "red" and row["props"] == {status["id"]: done}

    # Values change without touching the colour, and the other way round.
    row = alice.patch(f"{url}/rows/{row['id']}", json={"props": {status["id"]: None}}).json()
    assert row["color"] == "red" and row["props"] == {}
    row = alice.patch(f"{url}/rows/{row['id']}", json={"color": "green"}).json()
    assert row["color"] == "green"
    row = alice.patch(f"{url}/rows/{row['id']}", json={"title": "Renamed"}).json()
    assert row["color"] == "green" and row["title"] == "Renamed"

    # It survives a change of the schema and shows on the row's own page.
    kept = [p for p in database["properties"] if p["type"] != "person"]
    saved = alice.patch(url, json={"properties": kept}).json()
    assert saved["rows"][0]["color"] == "green"
    page = alice.get(f"/api/pages/{row['id']}").json()
    assert page["row"]["color"] == "green" and "$color" not in page["row"]["props"]

    # The key it is kept under cannot be reached as a property.
    row = alice.patch(f"{url}/rows/{row['id']}", json={"props": {"$color": "blue"}}).json()
    assert row["color"] == "green" and row["props"] == {}

    # Anything that is not a colour of the palette, or null, removes it.
    for value in ("#ff0000", "default", "javascript:1", None):
        alice.patch(f"{url}/rows/{row['id']}", json={"color": "pink"})
        row = alice.patch(f"{url}/rows/{row['id']}", json={"color": value}).json()
        assert row["color"] is None, value

    # Someone who can only read cannot paint.
    alice.put(f"/api/pages/{database['id']}/shares/{bob.user_id}", json={"role": "viewer"})
    assert bob.patch(f"{url}/rows/{row['id']}", json={"color": "red"}).status_code == 403


def test_a_database_has_a_colour_for_the_calendar(alice):
    database = make_database(alice, "Events")
    url = f"/api/databases/{database['id']}"
    assert database["color"] is None
    painted = add_row(alice, database, "Painted", "2026-11-24")
    plain = add_row(alice, database, "Plain", "2026-11-25")
    alice.patch(f"{url}/rows/{painted['id']}", json={"color": "red"})

    data = feed(alice, "2026-11-01", "2026-11-30")
    assert [(i["title"], i["color"], i["own_color"]) for i in data["items"]] == [
        ("Painted", "red", "red"),
        ("Plain", None, None),
    ]
    assert data["databases"][0]["color"] is None

    saved = alice.patch(url, json={"color": "green"}).json()
    assert saved["color"] == "green"
    data = feed(alice, "2026-11-01", "2026-11-30")
    assert [(i["title"], i["color"], i["own_color"]) for i in data["items"]] == [
        ("Painted", "red", "red"),
        ("Plain", "green", None),
    ]
    assert data["databases"][0]["color"] == "green"

    # Saving views or properties leaves the colour alone; null removes it.
    saved = alice.patch(url, json={"views": saved["views"]}).json()
    assert saved["color"] == "green"
    saved = alice.patch(url, json={"properties": saved["properties"]}).json()
    assert saved["color"] == "green"
    assert alice.patch(url, json={"color": "no such colour"}).json()["color"] is None
    alice.patch(url, json={"color": "blue"})
    assert alice.patch(url, json={"color": None}).json()["color"] is None
    assert plain["color"] is None


# -- linked databases and databases as pages ----------------------------------------------


def test_a_database_block_may_show_a_database_from_elsewhere(alice, bob):
    database = make_database(alice, "Inventory")
    host = alice.create_page("Elsewhere")
    content = {
        "type": "doc",
        "content": [
            {"type": "database", "attrs": {"pageId": database["id"]}},
            {"type": "pageLink", "attrs": {"pageId": database["id"]}},
        ],
    }
    saved = alice.put(
        f"/api/pages/{host['id']}/content",
        json={"content": content, "base_revision": host["revision"]},
    )
    assert saved.status_code == 200, saved.text
    stored = alice.get(f"/api/pages/{host['id']}").json()["content"]["content"]
    assert [node["attrs"]["pageId"] for node in stored[:2]] == [database["id"], database["id"]]
    # The database stays where it is, and the view gives nobody access to it.
    assert alice.get(f"/api/databases/{database['id']}").json()["parent_id"] is None
    alice.put(f"/api/pages/{host['id']}/shares/{bob.user_id}", json={"role": "editor"})
    assert bob.get(f"/api/pages/{host['id']}").status_code == 200
    assert bob.get(f"/api/databases/{database['id']}").status_code == 404


# -- built for many rows and many people ---------------------------------------------------


def test_reading_a_database_does_not_cost_a_query_per_row(alice):
    database = make_database(alice, "Big")
    url = f"/api/databases/{database['id']}"
    for index in range(5):
        add_row(alice, database, f"Row {index}", f"2026-11-{index + 1:02d}")
    with QueryCounter() as few:
        assert len(alice.get(url).json()["rows"]) == 5
    with QueryCounter() as few_calendar:
        assert len(feed(alice, "2026-11-01", "2026-11-30")["items"]) == 5
    for index in range(5, 60):
        add_row(alice, database, f"Row {index}", f"2026-11-{index % 28 + 1:02d}")
    with QueryCounter() as many:
        assert len(alice.get(url).json()["rows"]) == 60
    with QueryCounter() as many_calendar:
        assert len(feed(alice, "2026-11-01", "2026-11-30")["items"]) == 60
    assert many.count == few.count
    assert many_calendar.count == few_calendar.count
    assert many.count < 15 and many_calendar.count < 15


def test_saving_a_view_does_not_send_every_row_back(alice):
    database = make_database(alice)
    url = f"/api/databases/{database['id']}"
    add_row(alice, database, "Row", "2026-11-23")
    views = alice.patch(url, json={"views": database["views"]}).json()
    assert "rows" not in views and views["views"] == database["views"]
    # A change of the properties can change rows, so they come back.
    properties = alice.patch(url, json={"properties": database["properties"]}).json()
    assert [row["title"] for row in properties["rows"]] == ["Row"]


def test_large_answers_are_compressed_but_not_the_ones_with_secrets_or_files(alice):
    database = make_database(alice, "Compressed")
    for index in range(40):
        add_row(alice, database, f"A row with a fairly long name {index}", "2026-11-23")
    gzip = {"Accept-Encoding": "gzip"}
    table = alice.get(f"/api/databases/{database['id']}", headers=gzip)
    assert table.headers.get("content-encoding") == "gzip"
    assert len(table.json()["rows"]) == 40
    assert "Accept-Encoding" in table.headers.get("vary", "")
    # A client that does not ask for it gets the plain answer.
    plain = alice.get(f"/api/databases/{database['id']}", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.json() == table.json()

    # The CSRF token travels next to page titles other people can choose.
    bootstrap = alice.get("/api/bootstrap", headers=gzip)
    assert "content-encoding" not in bootstrap.headers and bootstrap.json()["csrf_token"]
    # Uploaded files are sent as they are (players ask for parts of them).
    page = alice.create_page("With a file")
    text = ("a line of text\n" * 400).encode()
    upload = alice.upload(page["id"], name="notes.txt", data=text)
    assert upload.status_code == 201, upload.text
    download = alice.get(f"/api/files/{upload.json()['id']}", headers=gzip)
    assert download.status_code == 200 and "content-encoding" not in download.headers
    assert download.content == text


def test_the_number_of_workers_comes_from_the_settings_or_the_command_line(monkeypatch, data_dir):
    import uvicorn

    from app import cli
    from app.config import get_settings

    calls: list[dict] = []
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: calls.append(kwargs))
    parser = cli.build_parser()

    cli.cmd_run(parser.parse_args(["run"]))
    assert calls[-1]["workers"] is None  # a single process, as before

    cli.cmd_run(parser.parse_args(["run", "--workers", "3"]))
    assert calls[-1]["workers"] == 3

    monkeypatch.setenv("KAMISPACE_WORKERS", "4")
    get_settings.cache_clear()
    cli.cmd_run(parser.parse_args(["run"]))
    assert calls[-1]["workers"] == 4
    # Reloading on code changes is for development: one process.
    cli.cmd_run(parser.parse_args(["run", "--reload"]))
    assert calls[-1]["workers"] is None and calls[-1]["reload"] is True


def _write_lines(path: str, name: str, count: int) -> None:
    handler = SharedRotatingFileHandler(path, maxBytes=20_000, backupCount=50, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger(f"shared-log-test-{name}")
    logger.propagate = False
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    for index in range(count):
        logger.info("%s line %05d %s", name, index, "x" * 60)
    handler.close()


def test_several_processes_share_one_rotating_log_file_without_losing_lines(tmp_path: Path):
    path = tmp_path / "kamispace.log"
    count = 400
    context = multiprocessing.get_context("spawn")
    workers = [
        context.Process(target=_write_lines, args=(str(path), f"worker{n}", count))
        for n in range(4)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=60)
        assert worker.exitcode == 0
    files = [path, *tmp_path.glob("kamispace.log.[0-9]*")]
    assert len(files) > 3, "the file should have been rotated several times"
    lines = [line for file in files for line in file.read_text(encoding="utf-8").splitlines()]
    # Every line of every process is there exactly once, and none is torn.
    expected = {f"worker{n} line {i:05d} {'x' * 60}" for n in range(4) for i in range(count)}
    assert len(lines) == len(expected) and set(lines) == expected
    assert all(file.stat().st_size <= 20_000 + 200 for file in files)

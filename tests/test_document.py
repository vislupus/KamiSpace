"""Server-side validation of editor documents (stored XSS defence)."""

from __future__ import annotations

import pytest

from app.errors import ValidationFailed
from app.services.document import (
    extract_attachment_ids,
    extract_text,
    is_safe_url,
    sanitize_document,
)


def text_node(text: str, *marks: dict) -> dict:
    node = {"type": "text", "text": text}
    if marks:
        node["marks"] = list(marks)
    return node


def para(*children: dict) -> dict:
    return {"type": "paragraph", "content": list(children)}


def wrap(*blocks: dict) -> dict:
    return {"type": "doc", "content": list(blocks)}


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        " javascript:alert(1)",
        "java\tscript:alert(1)",
        "java\nscript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "//evil.example/x",
        "",
        None,
        42,
    ],
)
def test_unsafe_urls_are_rejected(url):
    assert not is_safe_url(url)


@pytest.mark.parametrize(
    "url", ["https://example.com/a?b=c#d", "http://localhost:8000", "mailto:a@b.c", "/p/12", "#top"]
)
def test_safe_urls_are_accepted(url):
    assert is_safe_url(url)


def test_dangerous_links_lose_the_mark_but_keep_the_text():
    link = {"type": "link", "attrs": {"href": "javascript:alert(1)", "onclick": "x()"}}
    cleaned = sanitize_document(wrap(para(text_node("click", link, {"type": "bold"}))))
    assert cleaned["content"][0]["content"] == [text_node("click", {"type": "bold"})]


def test_link_attributes_are_reduced_to_href():
    link = {
        "type": "link",
        "attrs": {"href": "https://example.com", "target": "_top", "class": "x", "onclick": "y"},
    }
    cleaned = sanitize_document(wrap(para(text_node("ok", link))))
    assert cleaned["content"][0]["content"][0]["marks"] == [
        {"type": "link", "attrs": {"href": "https://example.com"}}
    ]


def test_unknown_nodes_marks_and_attributes_are_dropped():
    dirty = wrap(
        {"type": "script", "content": [text_node("alert(1)")]},
        {"type": "iframe", "attrs": {"src": "https://evil.example"}},
        {
            "type": "paragraph",
            "attrs": {"style": "background:url(javascript:x)", "onmouseover": "x()"},
            "content": [text_node("kept", {"type": "html", "attrs": {"raw": "<b>"}})],
        },
        {"type": "heading", "attrs": {"level": 9, "id": "x"}, "content": [text_node("Title")]},
    )
    cleaned = sanitize_document(dirty)
    assert cleaned == wrap(
        para(text_node("kept")),
        {"type": "heading", "attrs": {"level": 3}, "content": [text_node("Title")]},
        {"type": "paragraph"},
    )


def test_image_and_attachment_ids_must_be_well_formed():
    good = "ab" * 16
    dirty = wrap(
        {"type": "image", "attrs": {"attachmentId": good, "src": "https://tracker.example/p.gif"}},
        {"type": "image", "attrs": {"attachmentId": "../../etc/passwd"}},
        {"type": "image", "attrs": {"src": "https://tracker.example/p.gif"}},
        {"type": "attachment", "attrs": {"attachmentId": good, "name": "a.pdf", "size": 10}},
        {"type": "attachment", "attrs": {"attachmentId": "nope"}},
    )
    cleaned = sanitize_document(dirty)
    assert [n["type"] for n in cleaned["content"]] == ["image", "attachment", "paragraph"]
    assert "src" not in cleaned["content"][0]["attrs"]
    assert extract_attachment_ids(cleaned) == {good}


def test_image_layout_attributes_are_limited_to_known_values():
    good = "cd" * 16
    cleaned = sanitize_document(
        wrap(
            {
                "type": "image",
                "attrs": {
                    "attachmentId": good,
                    "width": 40,
                    "align": "left",
                    "caption": "Figure 1",
                },
            },
            {
                "type": "image",
                "attrs": {
                    "attachmentId": good,
                    "width": 5000,
                    "align": "float: right; position: fixed",
                    "caption": "x" * 2000,
                },
            },
            {"type": "image", "attrs": {"attachmentId": good}},
        )
    )
    first, second, third = (node["attrs"] for node in cleaned["content"][:3])
    assert (first["width"], first["align"], first["caption"]) == (40, "left", "Figure 1")
    assert second["align"] == "center"
    assert 10 <= second["width"] <= 100
    assert len(second["caption"]) == 500
    assert (third["width"], third["align"], third["caption"]) == (None, "center", None)
    # Captions are searchable text.
    assert "Figure 1" in extract_text(cleaned)


def test_an_empty_toggle_body_is_kept():
    document = wrap(
        {
            "type": "details",
            "attrs": {"open": True, "level": 0},
            "content": [
                {"type": "detailsSummary", "content": [text_node("Empty")]},
                {"type": "detailsContent"},
            ],
        }
    )
    cleaned = sanitize_document(document)
    toggle = cleaned["content"][0]
    assert toggle["type"] == "details"
    assert [child["type"] for child in toggle["content"]] == ["detailsSummary", "detailsContent"]
    assert not toggle["content"][1].get("content")


def test_structure_is_preserved_for_supported_blocks():
    document = wrap(
        {"type": "heading", "attrs": {"level": 2}, "content": [text_node("Plan")]},
        {
            "type": "taskList",
            "content": [
                {
                    "type": "taskItem",
                    "attrs": {"checked": True, "taskId": "task-one", "assignee": 3, "due": None},
                    "content": [para(text_node("a"))],
                },
                {
                    "type": "taskItem",
                    "attrs": {
                        "checked": False,
                        "taskId": "task-two",
                        "assignee": None,
                        "due": "2026-12-01",
                    },
                    "content": [para(text_node("b"))],
                },
            ],
        },
        {"type": "codeBlock", "attrs": {"language": "python"}, "content": [text_node("x = 1")]},
        {
            "type": "callout",
            "attrs": {"variant": "warning", "emoji": None},
            "content": [para(text_node("careful"))],
        },
        {"type": "horizontalRule"},
        {
            "type": "table",
            "content": [
                {
                    "type": "tableRow",
                    "content": [
                        {
                            "type": "tableHeader",
                            "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                            "content": [para(text_node("h"))],
                        }
                    ],
                }
            ],
        },
    )
    cleaned = sanitize_document(document)
    # Everything survives untouched; a trailing paragraph follows the table.
    assert cleaned["content"][:-1] == document["content"]
    assert cleaned["content"][-1] == {"type": "paragraph"}
    assert sanitize_document(cleaned) == cleaned


def test_empty_or_invalid_documents():
    assert sanitize_document({"type": "doc"}) == wrap({"type": "paragraph"})
    assert sanitize_document(wrap(text_node("stray"))) == wrap({"type": "paragraph"})
    for bad in (None, [], "doc", {"type": "paragraph"}):
        with pytest.raises(ValidationFailed):
            sanitize_document(bad)


def test_excessive_nesting_is_rejected():
    node: dict = para(text_node("deep"))
    for _ in range(60):
        node = {"type": "blockquote", "content": [node]}
    with pytest.raises(ValidationFailed):
        sanitize_document(wrap(node))


def test_extract_text():
    document = wrap(
        {"type": "heading", "attrs": {"level": 1}, "content": [text_node("Title")]},
        para(text_node("Hello "), text_node("world", {"type": "bold"})),
        {
            "type": "bulletList",
            "content": [{"type": "listItem", "content": [para(text_node("item"))]}],
        },
        {"type": "attachment", "attrs": {"attachmentId": "ab" * 16, "name": "report.pdf"}},
    )
    assert extract_text(document) == "Title\nHello world\nitem\nreport.pdf"


def test_api_stores_only_sanitised_content(alice):
    page = alice.create_page("XSS")
    link = {"type": "link", "attrs": {"href": "javascript:alert(document.cookie)"}}
    dirty = wrap(para(text_node("x", link)), {"type": "script", "content": [text_node("boom")]})
    response = alice.put(
        f"/api/pages/{page['id']}/content", json={"content": dirty, "base_revision": 1}
    )
    assert response.status_code == 200
    stored = alice.get(f"/api/pages/{page['id']}").json()["content"]
    assert stored == wrap(para(text_node("x")))
    assert "javascript" not in str(stored)


def test_rich_blocks_and_marks_survive_sanitising():
    document = wrap(
        {
            "type": "details",
            "attrs": {"open": True, "level": 2},
            "content": [
                {"type": "detailsSummary", "content": [text_node("Toggle heading")]},
                {"type": "detailsContent", "content": [para(text_node("hidden"))]},
            ],
        },
        {
            "type": "columns",
            "content": [
                {"type": "column", "content": [para(text_node("left"))]},
                {"type": "column", "content": [para(text_node("right"))]},
            ],
        },
        {"type": "blockEquation", "attrs": {"latex": "E = mc^2"}},
        para(
            text_node("inline "),
            {"type": "inlineEquation", "attrs": {"latex": "x^2"}},
            {"type": "pageMention", "attrs": {"pageId": 7}},
            text_node("red", {"type": "textColor", "attrs": {"color": "red"}}),
            text_node("marked", {"type": "highlight", "attrs": {"color": "yellow"}}),
        ),
        {"type": "embed", "attrs": {"url": "https://example.com/video", "height": 420}},
        {
            "type": "bookmark",
            "attrs": {"url": "https://example.com", "title": "Example", "description": None},
        },
        {"type": "video", "attrs": {"attachmentId": "ab" * 16, "name": "clip.mp4"}},
        {"type": "audio", "attrs": {"attachmentId": "cd" * 16, "name": None}},
        {"type": "pageLink", "attrs": {"pageId": 12}},
        para(),
    )
    document["content"][-1] = {"type": "paragraph"}
    assert sanitize_document(document) == document
    assert extract_attachment_ids(document) == {"ab" * 16, "cd" * 16}
    assert "E = mc^2" in extract_text(document)
    assert "Toggle heading" in extract_text(document)


def test_unsafe_variants_of_rich_blocks_are_dropped():
    dirty = wrap(
        {"type": "embed", "attrs": {"url": "javascript:alert(1)"}},
        {"type": "embed", "attrs": {"url": "/api/files/x"}},
        {"type": "bookmark", "attrs": {"url": "data:text/html,<script>"}},
        {"type": "pageLink", "attrs": {"pageId": "12; drop"}},
        {"type": "video", "attrs": {"attachmentId": "../../secret"}},
        para(
            text_node("a", {"type": "textColor", "attrs": {"color": "url(javascript:x)"}}),
            text_node("b", {"type": "highlight", "attrs": {"color": "expression(1)"}}),
            {"type": "pageMention", "attrs": {"pageId": -4}},
        ),
    )
    assert sanitize_document(dirty) == wrap(para(text_node("a"), text_node("b")))


def test_task_ids_are_assigned_and_kept_unique():
    def item(task_id):
        attrs = {"checked": False}
        if task_id:
            attrs["taskId"] = task_id
        return {"type": "taskItem", "attrs": attrs, "content": [para(text_node("x"))]}

    document = wrap({"type": "taskList", "content": [item("same-id"), item("same-id"), item(None)]})
    cleaned = sanitize_document(document)
    ids = [node["attrs"]["taskId"] for node in cleaned["content"][0]["content"]]
    assert ids[0] == "same-id"
    assert len(set(ids)) == 3 and all(ids)
    # Sanitising again changes nothing: ids are stable once stored.
    assert sanitize_document(cleaned) == cleaned

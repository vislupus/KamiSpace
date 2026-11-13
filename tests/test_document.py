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


def test_structure_is_preserved_for_supported_blocks():
    document = wrap(
        {"type": "heading", "attrs": {"level": 2}, "content": [text_node("Plan")]},
        {
            "type": "taskList",
            "content": [
                {"type": "taskItem", "attrs": {"checked": True}, "content": [para(text_node("a"))]},
                {
                    "type": "taskItem",
                    "attrs": {"checked": False},
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

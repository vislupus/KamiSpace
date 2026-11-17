"""Validation and inspection of editor documents (ProseMirror/Tiptap JSON).

The server never trusts document JSON coming from a client: unknown node and
mark types are dropped, attributes are reduced to a typed allow-list and link
targets are restricted to safe URL schemes. This is the backend half of the
stored-XSS defence (the editor schema is the other half).
"""

from __future__ import annotations

import copy
import re
import secrets
from collections.abc import Iterator
from typing import Any

from app.errors import ValidationFailed

EMPTY_DOC: dict[str, Any] = {"type": "doc", "content": [{"type": "paragraph"}]}

MAX_DEPTH = 40
MAX_NODES = 60_000

_ATTACHMENT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_LANGUAGE_RE = re.compile(r"^[A-Za-z0-9+#._-]{1,32}$")
_SAFE_URL_RE = re.compile(r"^(https?://|mailto:|tel:|/(?!/)|#)", re.IGNORECASE)
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f\s]+")

_TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,32}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_WEB_URL_RE = re.compile(r"^https?://[^\s<>\"']+$", re.IGNORECASE)

CALLOUT_VARIANTS = {"info", "success", "warning", "danger", "note"}
# Named colours; the stylesheet maps them to values for each theme.
COLORS = {"gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"}

TEXT_MARKS = {"bold", "italic", "strike", "code", "underline", "link", "textColor", "highlight"}
MAX_LATEX = 10_000

BLOCK_NODES = {
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "taskList",
    "taskItem",
    "blockquote",
    "codeBlock",
    "horizontalRule",
    "callout",
    "image",
    "attachment",
    "table",
    "tableRow",
    "tableHeader",
    "tableCell",
    "details",
    "detailsSummary",
    "detailsContent",
    "columns",
    "column",
    "blockEquation",
    "embed",
    "bookmark",
    "video",
    "audio",
    "pageLink",
}
INLINE_ATOMS = {"hardBreak", "inlineEquation", "pageMention"}
INLINE_NODES = {"text"} | INLINE_ATOMS
LEAF_NODES = {
    "horizontalRule",
    "image",
    "attachment",
    "blockEquation",
    "embed",
    "bookmark",
    "video",
    "audio",
    "pageLink",
}
ATTACHMENT_NODES = {"image", "attachment", "video", "audio"}


def is_web_url(url: Any) -> bool:
    """An absolute http(s) address (embeds and bookmarks point at other sites)."""
    return isinstance(url, str) and len(url) <= 2048 and bool(_WEB_URL_RE.match(url))


def new_task_id() -> str:
    return secrets.token_urlsafe(9)


def is_safe_url(url: Any) -> bool:
    if not isinstance(url, str) or len(url) > 2048:
        return False
    # Browsers ignore control characters and whitespace inside the scheme.
    cleaned = _CONTROL_RE.sub("", url)
    return bool(_SAFE_URL_RE.match(cleaned))


def _int(value: Any, default: int, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return default
    return max(low, min(high, int(value)))


def _text(value: Any, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _attachment_id(value: Any) -> str | None:
    if isinstance(value, str) and _ATTACHMENT_ID_RE.match(value):
        return value
    return None


def _clean_attrs(node_type: str, attrs: dict[str, Any]) -> dict[str, Any] | None:
    """Return the allowed attributes, or None when the node must be dropped."""
    if node_type == "heading":
        return {"level": _int(attrs.get("level"), 1, 1, 3)}
    if node_type == "orderedList":
        return {"start": _int(attrs.get("start"), 1, 0, 1_000_000)}
    if node_type == "taskItem":
        task_id = attrs.get("taskId")
        assignee = attrs.get("assignee")
        due = attrs.get("due")
        return {
            "checked": attrs.get("checked") is True,
            "taskId": task_id if isinstance(task_id, str) and _TASK_ID_RE.match(task_id) else None,
            "assignee": assignee
            if isinstance(assignee, int) and not isinstance(assignee, bool) and assignee > 0
            else None,
            "due": due if isinstance(due, str) and _DATE_RE.match(due) else None,
        }
    if node_type == "details":
        return {"open": attrs.get("open") is True, "level": _int(attrs.get("level"), 0, 0, 3)}
    if node_type in ("blockEquation", "inlineEquation"):
        return {"latex": _text(attrs.get("latex"), MAX_LATEX)}
    if node_type == "embed":
        if not is_web_url(attrs.get("url")):
            return None
        return {"url": attrs["url"], "height": _int(attrs.get("height"), 420, 120, 1600)}
    if node_type == "bookmark":
        if not is_web_url(attrs.get("url")):
            return None
        return {
            "url": attrs["url"],
            "title": _text(attrs.get("title"), 300) or None,
            "description": _text(attrs.get("description"), 500) or None,
        }
    if node_type in ("video", "audio"):
        attachment_id = _attachment_id(attrs.get("attachmentId"))
        if attachment_id is None:
            return None
        return {"attachmentId": attachment_id, "name": _text(attrs.get("name"), 255) or None}
    if node_type in ("pageLink", "pageMention"):
        page_id = attrs.get("pageId")
        if not isinstance(page_id, int) or isinstance(page_id, bool) or page_id <= 0:
            return None
        return {"pageId": page_id}
    if node_type == "codeBlock":
        language = attrs.get("language")
        valid = isinstance(language, str) and _LANGUAGE_RE.match(language)
        return {"language": language if valid else None}
    if node_type == "callout":
        variant = attrs.get("variant")
        return {
            "variant": variant if variant in CALLOUT_VARIANTS else "info",
            "emoji": _text(attrs.get("emoji"), 16) or None,
        }
    if node_type == "image":
        attachment_id = _attachment_id(attrs.get("attachmentId"))
        if attachment_id is None:
            return None
        width = attrs.get("width")
        return {
            "attachmentId": attachment_id,
            "alt": _text(attrs.get("alt"), 300) or None,
            "width": _int(width, 100, 10, 100) if width is not None else None,
        }
    if node_type == "attachment":
        attachment_id = _attachment_id(attrs.get("attachmentId"))
        if attachment_id is None:
            return None
        return {
            "attachmentId": attachment_id,
            "name": _text(attrs.get("name"), 255) or "file",
            "size": _int(attrs.get("size"), 0, 0, 2**40),
            "mime": _text(attrs.get("mime"), 120),
            "preview": attrs.get("preview") is True,
        }
    if node_type in ("tableCell", "tableHeader"):
        colwidth = attrs.get("colwidth")
        if isinstance(colwidth, list) and len(colwidth) <= 50:
            colwidth = [_int(w, 0, 0, 4000) for w in colwidth]
        else:
            colwidth = None
        return {
            "colspan": _int(attrs.get("colspan"), 1, 1, 50),
            "rowspan": _int(attrs.get("rowspan"), 1, 1, 200),
            "colwidth": colwidth,
        }
    return {}


def _clean_marks(marks: Any) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    if not isinstance(marks, list):
        return cleaned
    seen: set[str] = set()
    for mark in marks:
        if not isinstance(mark, dict):
            continue
        mark_type = mark.get("type")
        if mark_type not in TEXT_MARKS or mark_type in seen:
            continue
        seen.add(mark_type)
        if mark_type == "link":
            attrs = mark.get("attrs") if isinstance(mark.get("attrs"), dict) else {}
            href = attrs.get("href")
            if not is_safe_url(href):
                continue
            cleaned.append({"type": "link", "attrs": {"href": href.strip()}})
        elif mark_type in ("textColor", "highlight"):
            attrs = mark.get("attrs") if isinstance(mark.get("attrs"), dict) else {}
            if attrs.get("color") in COLORS:
                cleaned.append({"type": mark_type, "attrs": {"color": attrs["color"]}})
        else:
            cleaned.append({"type": mark_type})
    return cleaned


class _Counter:
    def __init__(self) -> None:
        self.nodes = 0


def _clean_node(node: Any, depth: int, counter: _Counter) -> dict[str, Any] | None:
    if not isinstance(node, dict):
        return None
    if depth > MAX_DEPTH:
        raise ValidationFailed("Document is nested too deeply")
    counter.nodes += 1
    if counter.nodes > MAX_NODES:
        raise ValidationFailed("Document has too many blocks")

    node_type = node.get("type")
    if node_type == "text":
        text = node.get("text")
        if not isinstance(text, str) or text == "":
            return None
        result: dict[str, Any] = {"type": "text", "text": text}
        marks = _clean_marks(node.get("marks"))
        if marks:
            result["marks"] = marks
        return result
    if node_type == "hardBreak":
        return {"type": "hardBreak"}
    if node_type in INLINE_ATOMS:
        raw = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        attrs = _clean_attrs(node_type, raw)
        return None if attrs is None else {"type": node_type, "attrs": attrs}
    if node_type not in BLOCK_NODES:
        return None

    raw_attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
    attrs = _clean_attrs(node_type, raw_attrs)
    if attrs is None:
        return None
    result = {"type": node_type}
    if attrs:
        result["attrs"] = attrs
    if node_type not in LEAF_NODES:
        children = node.get("content")
        if isinstance(children, list):
            cleaned = [
                child
                for child in (_clean_node(c, depth + 1, counter) for c in children)
                if child is not None
            ]
            if cleaned:
                result["content"] = cleaned
    return result


def sanitize_document(doc: Any) -> dict[str, Any]:
    """Validate a client supplied document and return a safe copy."""
    if not isinstance(doc, dict) or doc.get("type") != "doc":
        raise ValidationFailed("Document must be a ProseMirror 'doc' node")
    counter = _Counter()
    content = doc.get("content")
    blocks: list[dict[str, Any]] = []
    if isinstance(content, list):
        for child in content:
            cleaned = _clean_node(child, 1, counter)
            if cleaned is not None and cleaned["type"] not in INLINE_NODES:
                blocks.append(cleaned)
    _ensure_task_ids(blocks)
    # The editor always keeps an empty paragraph after a trailing non-text
    # block (so there is somewhere to type). Storing documents in that shape
    # means merely opening a page never produces a change to save.
    if not blocks or blocks[-1]["type"] != "paragraph":
        blocks.append({"type": "paragraph"})
    return {"type": "doc", "content": blocks}


def iter_nodes(node: Any) -> Iterator[dict[str, Any]]:
    if not isinstance(node, dict):
        return
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        children = current.get("content")
        if isinstance(children, list):
            stack.extend(c for c in reversed(children) if isinstance(c, dict))


def extract_attachment_ids(doc: Any) -> set[str]:
    ids: set[str] = set()
    for node in iter_nodes(doc):
        if node.get("type") in ATTACHMENT_NODES:
            attachment_id = _attachment_id((node.get("attrs") or {}).get("attachmentId"))
            if attachment_id:
                ids.add(attachment_id)
    return ids


_TEXT_BLOCKS = {
    "paragraph",
    "heading",
    "codeBlock",
    "tableCell",
    "tableHeader",
    "detailsSummary",
}


def extract_text(doc: Any) -> str:
    """Flatten a document to plain text for full-text indexing and previews."""
    parts: list[str] = []

    def walk(node: Any) -> None:
        if not isinstance(node, dict):
            return
        node_type = node.get("type")
        if node_type == "text":
            parts.append(node.get("text") or "")
            return
        if node_type == "hardBreak":
            parts.append("\n")
            return
        if node_type == "attachment":
            parts.append((node.get("attrs") or {}).get("name") or "")
            parts.append("\n")
            return
        if node_type == "image":
            parts.append((node.get("attrs") or {}).get("alt") or "")
            parts.append("\n")
            return
        if node_type in ("blockEquation", "inlineEquation"):
            parts.append((node.get("attrs") or {}).get("latex") or "")
            parts.append("\n" if node_type == "blockEquation" else " ")
            return
        if node_type in ("bookmark", "embed", "video", "audio"):
            attrs = node.get("attrs") or {}
            parts.append(" ".join(str(attrs.get(k) or "") for k in ("title", "name", "url")))
            parts.append("\n")
            return
        for child in node.get("content") or []:
            walk(child)
        if node_type in _TEXT_BLOCKS:
            parts.append("\n")

    walk(doc)
    text = "".join(parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def text_to_document(text: str) -> dict[str, Any]:
    """Turn plain text (Quick Capture) into a simple document."""
    blocks: list[dict[str, Any]] = []
    for line in text.replace("\r\n", "\n").split("\n"):
        if line.strip():
            blocks.append({"type": "paragraph", "content": [{"type": "text", "text": line}]})
        elif blocks and blocks[-1].get("content"):
            blocks.append({"type": "paragraph"})
    while blocks and not blocks[-1].get("content"):
        blocks.pop()
    return {"type": "doc", "content": blocks or [{"type": "paragraph"}]}


def _ensure_task_ids(blocks: list[dict[str, Any]]) -> None:
    """Every to-do item gets an id that is unique within its page."""
    seen: set[str] = set()
    for node in iter_nodes({"type": "doc", "content": blocks}):
        if node.get("type") != "taskItem":
            continue
        attrs = node.setdefault("attrs", {})
        task_id = attrs.get("taskId")
        if not task_id or task_id in seen:
            task_id = new_task_id()
            attrs["taskId"] = task_id
        seen.add(task_id)


def extract_tasks(doc: Any) -> list[dict[str, Any]]:
    """To-do items of a document, in reading order."""
    tasks: list[dict[str, Any]] = []
    for node in iter_nodes(doc):
        if node.get("type") != "taskItem":
            continue
        attrs = node.get("attrs") or {}
        if not attrs.get("taskId"):
            continue
        # The item's own text: its first paragraph, not nested sub-tasks.
        first = (node.get("content") or [{}])[0]
        tasks.append(
            {
                "task_key": attrs["taskId"],
                "text": extract_text(first).replace("\n", " ")[:500],
                "checked": attrs.get("checked") is True,
                "assignee": attrs.get("assignee"),
                "due": attrs.get("due"),
            }
        )
    return tasks


def set_task_checked(doc: dict[str, Any], task_key: str, checked: bool) -> bool:
    """Tick or untick one to-do item in place; False when it is not in the document."""
    for node in iter_nodes(doc):
        if node.get("type") == "taskItem" and (node.get("attrs") or {}).get("taskId") == task_key:
            node["attrs"]["checked"] = checked
            return True
    return False


def append_page_link(doc: dict[str, Any], page_id: int) -> dict[str, Any]:
    """Add a link to a sub-page at the end of a document (before a trailing blank line)."""
    blocks = list(doc.get("content") or [])
    link = {"type": "pageLink", "attrs": {"pageId": page_id}}
    if blocks and blocks[-1].get("type") == "paragraph" and not blocks[-1].get("content"):
        blocks.insert(len(blocks) - 1, link)
    else:
        blocks.extend([link, {"type": "paragraph"}])
    return {"type": "doc", "content": blocks}


def remap_page_links(doc: dict[str, Any], id_map: dict[int, int]) -> dict[str, Any]:
    """Copy of a document whose page links follow ``id_map`` (old id → new id)."""
    result = copy.deepcopy(doc)
    for node in iter_nodes(result):
        if node.get("type") in ("pageLink", "pageMention"):
            attrs = node.get("attrs") or {}
            if attrs.get("pageId") in id_map:
                attrs["pageId"] = id_map[attrs["pageId"]]
    return result

"""Full-text search backed by SQLite FTS5.

The index stores one row per page (rowid = page id) with its title, the titles
of its ancestors ("path") and the plain text of its content. Search results
are filtered through the permission resolver before anything is returned.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models import Page
from app.services.document import extract_text
from app.services.permissions import Access, PageNode

_TOKEN_RE = re.compile(r"[\w]+", re.UNICODE)

# Private-use markers wrapped around matches by snippet(); the client turns
# them into <mark> elements without ever interpreting the text as HTML.
MARK_START = ""
MARK_END = ""


def _ancestor_titles(db: Session, page: Page) -> list[str]:
    titles: list[str] = []
    seen = {page.id}
    parent_id = page.parent_id
    while parent_id is not None and parent_id not in seen:
        seen.add(parent_id)
        row = db.execute(select(Page.title, Page.parent_id).where(Page.id == parent_id)).first()
        if row is None:
            break
        titles.append(row[0] or "Untitled")
        parent_id = row[1]
    titles.reverse()
    return titles


def index_page(db: Session, page: Page) -> None:
    """(Re)index a single page. Call inside the transaction that changed it."""
    db.execute(text("DELETE FROM pages_fts WHERE rowid = :id"), {"id": page.id})
    if page.deleted_at is not None:
        return
    db.execute(
        text("INSERT INTO pages_fts(rowid, title, path, body) VALUES (:id, :title, :path, :body)"),
        {
            "id": page.id,
            "title": page.title or "",
            "path": " / ".join(_ancestor_titles(db, page)),
            "body": extract_text(page.content),
        },
    )


def index_pages(db: Session, pages: list[Page]) -> None:
    for page in pages:
        index_page(db, page)


def remove_pages(db: Session, page_ids: list[int]) -> None:
    for page_id in page_ids:
        db.execute(text("DELETE FROM pages_fts WHERE rowid = :id"), {"id": page_id})


def build_match_query(query: str) -> str | None:
    """Turn free text into a safe FTS5 expression (AND of prefix terms)."""
    tokens = _TOKEN_RE.findall(query)[:12]
    if not tokens:
        return None
    return " ".join(f'"{token}"*' for token in tokens)


def _matches_own_text(db: Session, page_id: int, match: str) -> bool:
    """True when the page matches on its own title/body, ignoring ancestors."""
    row = db.execute(
        text("SELECT 1 FROM pages_fts WHERE pages_fts MATCH :match AND rowid = :id"),
        {"match": f"{{title body}} : ({match})", "id": page_id},
    ).first()
    return row is not None


def search(db: Session, access: Access, query: str, limit: int = 20) -> list[dict[str, Any]]:
    match = build_match_query(query)
    if match is None:
        return []
    rows = db.execute(
        text(
            """
            SELECT p.id, p.parent_id, p.workspace_id, p.owner_id, p.title, p.icon,
                   snippet(pages_fts, 2, :start, :end, '…', 14) AS snippet
            FROM pages_fts AS f
            JOIN pages AS p ON p.id = f.rowid
            WHERE pages_fts MATCH :match AND p.deleted_at IS NULL
            ORDER BY bm25(pages_fts, 10.0, 3.0, 1.0)
            LIMIT 2000
            """
        ),
        {"match": match, "start": MARK_START, "end": MARK_END},
    ).all()
    results: list[dict[str, Any]] = []
    for row in rows:
        access.prime([PageNode(row.id, row.parent_id, row.workspace_id, row.owner_id)])
        if not access.can_view(row.id):
            continue
        ancestors, hidden = access.ancestors(row.id)
        # A page reached through a share must not reveal (or match on) the
        # titles of ancestors the user cannot open.
        if hidden and not _matches_own_text(db, row.id, match):
            continue
        results.append(
            {
                "id": row.id,
                "title": row.title,
                "icon": row.icon,
                "workspace_id": row.workspace_id,
                "path": [a["title"] or "Untitled" for a in ancestors],
                "snippet": row.snippet,
            }
        )
        if len(results) >= limit:
            break
    return results

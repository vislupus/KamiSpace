"""Page tree, content saving and the recycle bin."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import utcnow
from app.errors import Conflict, Forbidden, NotFound, PayloadTooLarge, ValidationFailed
from app.models import (
    ROLE_EDITOR,
    ROLE_OWNER,
    ROLE_VIEWER,
    WORKSPACE_PERSONAL,
    Attachment,
    Favorite,
    Page,
    PageAttachment,
    PageVisit,
    User,
    Workspace,
)
from app.services import files, search, versions
from app.services.document import (
    EMPTY_DOC,
    extract_attachment_ids,
    extract_text,
    sanitize_document,
    text_to_document,
)
from app.services.permissions import Access, PageNode, role_at_least

MAX_TITLE = 300
MAX_DEPTH = 30


# -- helpers -----------------------------------------------------------------


def clean_title(title: str | None) -> str:
    return " ".join((title or "").split())[:MAX_TITLE]


def clean_icon(icon: str | None) -> str | None:
    icon = (icon or "").strip()
    return icon[:32] or None


def user_names(db: Session, user_ids: set[int | None]) -> dict[int, str]:
    ids = {uid for uid in user_ids if uid is not None}
    if not ids:
        return {}
    rows = db.execute(select(User.id, User.display_name).where(User.id.in_(ids))).all()
    return {uid: name for uid, name in rows}


def subtree_ids(db: Session, page_id: int) -> list[int]:
    """Ids of a page and all its descendants (trashed ones included)."""
    rows = db.execute(
        text(
            """
            WITH RECURSIVE tree(id) AS (
                SELECT id FROM pages WHERE id = :root
                UNION ALL
                SELECT p.id FROM pages p JOIN tree t ON p.parent_id = t.id
            )
            SELECT id FROM tree
            """
        ),
        {"root": page_id},
    ).scalars()
    return list(rows)


def _depth(db: Session, page_id: int | None) -> int:
    depth = 0
    seen: set[int] = set()
    while page_id is not None and page_id not in seen:
        seen.add(page_id)
        depth += 1
        page_id = db.execute(select(Page.parent_id).where(Page.id == page_id)).scalar_one_or_none()
    return depth


def _siblings(db: Session, workspace_id: int, parent_id: int | None) -> list[Page]:
    query = select(Page).where(Page.workspace_id == workspace_id, Page.deleted_at.is_(None))
    if parent_id is None:
        query = query.where(Page.parent_id.is_(None))
    else:
        query = query.where(Page.parent_id == parent_id)
    return list(db.execute(query.order_by(Page.position, Page.id)).scalars())


def _end_position(db: Session, workspace_id: int, parent_id: int | None) -> float:
    query = select(func.max(Page.position)).where(Page.workspace_id == workspace_id)
    if parent_id is None:
        query = query.where(Page.parent_id.is_(None))
    else:
        query = query.where(Page.parent_id == parent_id)
    return (db.execute(query).scalar_one_or_none() or 0.0) + 1.0


def _place(
    db: Session,
    page: Page,
    *,
    before_id: int | None = None,
    after_id: int | None = None,
) -> None:
    """Position ``page`` among its siblings (already assigned parent/workspace)."""
    siblings = [s for s in _siblings(db, page.workspace_id, page.parent_id) if s.id != page.id]
    anchor_id = before_id if before_id is not None else after_id
    index = next((i for i, s in enumerate(siblings) if s.id == anchor_id), None)
    if anchor_id is None or index is None:
        siblings.append(page)
    elif before_id is not None:
        siblings.insert(index, page)
    else:
        siblings.insert(index + 1, page)
    for position, sibling in enumerate(siblings, start=1):
        if sibling.position != float(position):
            sibling.position = float(position)


def serialize_meta(page: Page, role: str | None = None) -> dict[str, Any]:
    return {
        "id": page.id,
        "workspace_id": page.workspace_id,
        "parent_id": page.parent_id,
        "title": page.title,
        "icon": page.icon,
        "position": page.position,
        "role": role,
    }


def _check_destination(
    db: Session, access: Access, workspace_id: int, parent_id: int | None
) -> tuple[int, Page | None]:
    """Validate that the user may put a page at the given location."""
    if parent_id is not None:
        parent = access.require_page(parent_id, ROLE_EDITOR)
        if _depth(db, parent.id) >= MAX_DEPTH:
            raise ValidationFailed("Pages cannot be nested any deeper")
        return parent.workspace_id, parent
    access.require_workspace(workspace_id, ROLE_EDITOR)
    return workspace_id, None


# -- tree --------------------------------------------------------------------


def list_tree(db: Session, access: Access) -> list[dict[str, Any]]:
    """Every page the user can see, as a flat list the client turns into trees."""
    workspace_ids = set(access.memberships)
    if access.grants:
        workspace_ids.update(
            db.execute(
                select(Page.workspace_id).where(Page.id.in_(access.grants.keys())).distinct()
            ).scalars()
        )
    if not workspace_ids:
        return []
    rows = db.execute(
        select(
            Page.id,
            Page.parent_id,
            Page.workspace_id,
            Page.owner_id,
            Page.title,
            Page.icon,
            Page.position,
        )
        .where(Page.workspace_id.in_(workspace_ids), Page.deleted_at.is_(None))
        .order_by(Page.position, Page.id)
    ).all()
    access.prime([PageNode(r.id, r.parent_id, r.workspace_id, r.owner_id) for r in rows])

    visible: dict[int, Any] = {}
    roles: dict[int, str] = {}
    for row in rows:
        role = access.page_role(row.id)
        if role is not None:
            visible[row.id] = row
            roles[row.id] = role

    result = []
    for row in visible.values():
        is_member = row.workspace_id in access.memberships
        parent_visible = row.parent_id is not None and row.parent_id in visible
        result.append(
            {
                "id": row.id,
                "workspace_id": row.workspace_id,
                "parent_id": row.parent_id if (is_member or parent_visible) else None,
                "title": row.title,
                "icon": row.icon,
                "position": row.position,
                "role": roles[row.id],
                # Reached through a share, shown under "Shared with me".
                "shared": not is_member,
            }
        )
    return result


def list_favorites(db: Session, access: Access) -> list[int]:
    rows = db.execute(
        select(Favorite.page_id)
        .join(Page, Page.id == Favorite.page_id)
        .where(Favorite.user_id == access.user.id, Page.deleted_at.is_(None))
        .order_by(Favorite.created_at)
    ).scalars()
    return [page_id for page_id in rows if access.can_view(page_id)]


def list_recents(db: Session, access: Access, limit: int = 12) -> list[int]:
    rows = db.execute(
        select(PageVisit.page_id)
        .join(Page, Page.id == PageVisit.page_id)
        .where(PageVisit.user_id == access.user.id, Page.deleted_at.is_(None))
        .order_by(PageVisit.visited_at.desc())
        .limit(limit * 3)
    ).scalars()
    return [page_id for page_id in rows if access.can_view(page_id)][:limit]


def record_visit(db: Session, user: User, page_id: int) -> None:
    visit = db.get(PageVisit, (user.id, page_id))
    if visit is None:
        db.add(PageVisit(user_id=user.id, page_id=page_id))
    else:
        visit.visited_at = utcnow()


def set_favorite(db: Session, access: Access, page_id: int, favorite: bool) -> None:
    access.require_page(page_id, ROLE_VIEWER)
    existing = db.get(Favorite, (access.user.id, page_id))
    if favorite and existing is None:
        db.add(Favorite(user_id=access.user.id, page_id=page_id))
    elif not favorite and existing is not None:
        db.delete(existing)


# -- create / read / update --------------------------------------------------


def create_page(
    db: Session,
    access: Access,
    *,
    workspace_id: int | None,
    parent_id: int | None = None,
    title: str = "",
    icon: str | None = None,
    content: dict[str, Any] | None = None,
) -> Page:
    user = access.user
    if parent_id is None and workspace_id is None:
        raise ValidationFailed("Either workspace_id or parent_id is required")
    workspace_id, _parent = _check_destination(db, access, workspace_id or 0, parent_id)
    doc = sanitize_document(content) if content else copy.deepcopy(EMPTY_DOC)
    page = Page(
        workspace_id=workspace_id,
        parent_id=parent_id,
        title=clean_title(title),
        icon=clean_icon(icon),
        content=doc,
        revision=1,
        position=_end_position(db, workspace_id, parent_id),
        owner_id=user.id,
        updated_by=user.id,
    )
    db.add(page)
    db.flush()
    files.link_attachments(db, access, page.id, extract_attachment_ids(doc))
    if content:
        versions.record_version(db, page, user)
    search.index_page(db, page)
    return page


def page_detail(db: Session, access: Access, page: Page) -> dict[str, Any]:
    role = access.page_role(page.id)
    ancestors, _hidden = access.ancestors(page.id)
    names = user_names(db, {page.owner_id, page.updated_by})
    workspace = db.get(Workspace, page.workspace_id)
    is_member = page.workspace_id in access.memberships
    favorite = db.get(Favorite, (access.user.id, page.id)) is not None
    return {
        "id": page.id,
        "workspace_id": page.workspace_id,
        "workspace_name": workspace.name if workspace and is_member else None,
        "parent_id": page.parent_id if ancestors else None,
        "title": page.title,
        "icon": page.icon,
        "cover_attachment_id": page.cover_attachment_id,
        "content": page.content,
        "revision": page.revision,
        "role": role,
        "can_edit": role_at_least(role, ROLE_EDITOR),
        "can_manage": role_at_least(role, ROLE_OWNER),
        "is_favorite": favorite,
        "owner_id": page.owner_id,
        "owner_name": names.get(page.owner_id) if page.owner_id else None,
        "updated_by_name": names.get(page.updated_by) if page.updated_by else None,
        "created_at": page.created_at.isoformat(),
        "updated_at": page.updated_at.isoformat(),
        "deleted_at": page.deleted_at.isoformat() if page.deleted_at else None,
        "breadcrumbs": ancestors,
    }


def update_meta(
    db: Session,
    access: Access,
    page_id: int,
    *,
    fields: dict[str, Any],
) -> Page:
    """Update title / icon / cover. ``fields`` only holds what the client sent."""
    page = access.require_page(page_id, ROLE_EDITOR)
    user = access.user
    title_changed = False
    if "title" in fields:
        new_title = clean_title(fields["title"])
        title_changed = new_title != page.title
        page.title = new_title
    if "icon" in fields:
        page.icon = clean_icon(fields["icon"])
    if "cover_attachment_id" in fields:
        cover_id = fields["cover_attachment_id"]
        if cover_id is not None:
            attachment = db.get(Attachment, cover_id)
            if (
                attachment is None
                or attachment.kind != "image"
                or not files.can_read(db, access, cover_id)
            ):
                raise ValidationFailed("Cover must be an uploaded image")
            files.link_attachments(db, access, page.id, {cover_id})
        page.cover_attachment_id = cover_id
    page.updated_at = utcnow()
    page.updated_by = user.id
    if title_changed:
        versions.record_version(db, page, user)
        _reindex_subtree(db, page)
    return page


def _reindex_subtree(db: Session, page: Page) -> None:
    """Titles feed the 'path' column of descendants, so reindex the subtree."""
    ids = subtree_ids(db, page.id)
    pages = db.execute(select(Page).where(Page.id.in_(ids))).scalars().all()
    search.index_pages(db, list(pages))


def save_content(
    db: Session,
    access: Access,
    page_id: int,
    *,
    content: Any,
    base_revision: int,
    force: bool = False,
) -> tuple[Page, int]:
    """Save document content using optimistic concurrency control.

    ``base_revision`` is the revision the client's edits are based on. When it
    is stale the save is rejected with a conflict — unless ``force`` is set, in
    which case the client has explicitly chosen to overwrite; the overwritten
    state stays available in the version history.
    """
    page = access.require_page(page_id, ROLE_EDITOR)
    user = access.user
    doc = sanitize_document(content)
    if len(json.dumps(doc, ensure_ascii=False).encode("utf-8")) > (
        get_settings().max_document_kb * 1024
    ):
        raise PayloadTooLarge("Document is too large")

    stale = base_revision != page.revision
    if stale and not force:
        names = user_names(db, {page.updated_by})
        raise Conflict(
            "This page was changed somewhere else since you loaded it",
            extra={
                "current_revision": page.revision,
                "updated_by_name": names.get(page.updated_by) if page.updated_by else None,
                "updated_at": page.updated_at.isoformat(),
            },
        )

    latest = versions.latest_version(db, page.id)
    if doc == page.content and not stale:
        return page, latest.number if latest else 0

    current_revision = page.revision
    result = db.execute(
        update(Page)
        .where(Page.id == page.id, Page.revision == current_revision)
        .values(
            content=doc,
            revision=current_revision + 1,
            updated_at=utcnow(),
            updated_by=user.id,
        )
    )
    if result.rowcount != 1:
        raise Conflict(
            "This page was changed somewhere else since you loaded it",
            extra={"current_revision": current_revision},
        )
    db.refresh(page)

    files.link_attachments(db, access, page.id, extract_attachment_ids(doc))
    version = versions.record_version(db, page, user, force_new=stale)
    search.index_page(db, page)
    return page, version.number


def restore_version(db: Session, access: Access, page_id: int, version_id: int) -> Page:
    page = access.require_page(page_id, ROLE_EDITOR)
    version = versions.get_version(db, page.id, version_id)
    # Stored snapshots were sanitised when saved; run them through again so a
    # restore can never reintroduce content an older release would have kept.
    page.content = sanitize_document(version.content)
    page.title = version.title
    page.revision += 1
    page.updated_at = utcnow()
    page.updated_by = access.user.id
    db.flush()
    versions.record_version(
        db,
        page,
        access.user,
        kind=versions.KIND_RESTORE,
        description=f"Restored from version {version.number}",
        force_new=True,
    )
    _reindex_subtree(db, page)
    return page


# -- move / duplicate --------------------------------------------------------


def move_page(
    db: Session,
    access: Access,
    page_id: int,
    *,
    parent_id: int | None,
    workspace_id: int | None = None,
    before_id: int | None = None,
    after_id: int | None = None,
) -> Page:
    page = access.require_page(page_id, ROLE_EDITOR)
    target_workspace, parent = _check_destination(
        db, access, workspace_id or page.workspace_id, parent_id
    )
    tree = subtree_ids(db, page.id)
    if parent is not None and parent.id in tree:
        raise ValidationFailed("A page cannot be moved inside itself")

    location_changes = parent_id != page.parent_id or target_workspace != page.workspace_id
    if location_changes:
        # Changing a page's place in the hierarchy changes who inherits access
        # to it, so the user needs more than edit rights on a shared page.
        if target_workspace != page.workspace_id and not access.can_manage(page.id):
            raise Forbidden("Only the page owner can move a page to another workspace")
        if access.workspace_role(page.workspace_id) is None and not access.can_manage(page.id):
            raise Forbidden("Only the page owner can move a shared page")
        if parent is not None and _depth(db, parent.id) + _height(db, page.id) > MAX_DEPTH:
            raise ValidationFailed("Pages cannot be nested any deeper")

    if target_workspace != page.workspace_id:
        db.execute(update(Page).where(Page.id.in_(tree)).values(workspace_id=target_workspace))
        db.refresh(page)
    page.parent_id = parent_id
    db.flush()
    _place(db, page, before_id=before_id, after_id=after_id)
    db.flush()
    if location_changes:
        db.expire_all()
        page = db.get(Page, page_id)
        assert page is not None
        _reindex_subtree(db, page)
    return page


def _height(db: Session, page_id: int) -> int:
    row = db.execute(
        text(
            """
            WITH RECURSIVE tree(id, depth) AS (
                SELECT id, 1 FROM pages WHERE id = :root
                UNION ALL
                SELECT p.id, t.depth + 1 FROM pages p JOIN tree t ON p.parent_id = t.id
            )
            SELECT MAX(depth) FROM tree
            """
        ),
        {"root": page_id},
    ).scalar_one_or_none()
    return row or 1


def personal_workspace_id(db: Session, user: User) -> int:
    workspace_id = db.execute(
        select(Workspace.id).where(
            Workspace.kind == WORKSPACE_PERSONAL, Workspace.owner_id == user.id
        )
    ).scalar_one_or_none()
    if workspace_id is None:
        raise NotFound("Personal workspace not found")
    return workspace_id


def duplicate_page(db: Session, access: Access, page_id: int) -> Page:
    """Copy a page and its sub-pages. The copy belongs to the current user.

    The copy is placed next to the original when the user may create pages
    there, otherwise at the top of their personal workspace.
    """
    source = access.require_page(page_id, ROLE_VIEWER)
    user = access.user

    can_place_beside = (
        access.can_edit(source.parent_id)
        if source.parent_id is not None
        else role_at_least(access.workspace_role(source.workspace_id), ROLE_EDITOR)
    )
    if can_place_beside:
        workspace_id, parent_id = source.workspace_id, source.parent_id
    else:
        workspace_id, parent_id = personal_workspace_id(db, user), None

    def copy_one(original: Page, new_parent_id: int | None, title: str, position: float) -> Page:
        clone = Page(
            workspace_id=workspace_id,
            parent_id=new_parent_id,
            title=title,
            icon=original.icon,
            cover_attachment_id=original.cover_attachment_id,
            content=copy.deepcopy(original.content),
            revision=1,
            position=position,
            owner_id=user.id,
            updated_by=user.id,
        )
        db.add(clone)
        db.flush()
        attachment_ids = extract_attachment_ids(clone.content)
        if clone.cover_attachment_id:
            attachment_ids.add(clone.cover_attachment_id)
        files.link_attachments(db, access, clone.id, attachment_ids)
        versions.record_version(db, clone, user)
        return clone

    title = clean_title(f"{source.title or 'Untitled'} (copy)")
    root = copy_one(source, parent_id, title, 0.0)
    if can_place_beside:
        _place(db, root, after_id=source.id)
    else:
        root.position = _end_position(db, workspace_id, None)

    created = [root]
    queue: list[tuple[int, int]] = [(source.id, root.id)]
    while queue:
        original_id, clone_id = queue.pop(0)
        children = db.execute(
            select(Page)
            .where(Page.parent_id == original_id, Page.deleted_at.is_(None))
            .order_by(Page.position, Page.id)
        ).scalars()
        for child in children:
            if child.id in {c.id for c in created} or not access.can_view(child.id):
                continue
            clone = copy_one(child, clone_id, child.title, child.position)
            created.append(clone)
            queue.append((child.id, clone.id))
            if len(created) > 2000:
                raise ValidationFailed("This page has too many sub-pages to duplicate at once")
    db.flush()
    search.index_pages(db, created)
    return root


# -- recycle bin -------------------------------------------------------------


def trash_page(db: Session, access: Access, page_id: int) -> list[int]:
    page = access.require_page(page_id, ROLE_EDITOR)
    ids = subtree_ids(db, page.id)
    now = utcnow()
    result = db.execute(
        update(Page)
        .where(Page.id.in_(ids), Page.deleted_at.is_(None))
        .values(deleted_at=now, deleted_by=access.user.id, trashed_with=page.id)
        .returning(Page.id)
    )
    trashed = list(result.scalars())
    search.remove_pages(db, trashed)
    db.expire_all()
    return trashed


def list_trash(db: Session, access: Access) -> list[dict[str, Any]]:
    rows = (
        db.execute(
            select(Page)
            .where(Page.deleted_at.is_not(None), Page.trashed_with == Page.id)
            .order_by(Page.deleted_at.desc())
        )
        .scalars()
        .all()
    )
    visible = [page for page in rows if access.can_edit(page.id)]
    names = user_names(db, {page.deleted_by for page in visible})
    workspaces = {
        ws.id: ws.name
        for ws in db.execute(
            select(Workspace).where(Workspace.id.in_({p.workspace_id for p in visible}))
        ).scalars()
    }
    items = []
    for page in visible:
        nested = db.execute(
            select(func.count()).select_from(Page).where(Page.trashed_with == page.id)
        ).scalar_one()
        items.append(
            {
                "id": page.id,
                "title": page.title,
                "icon": page.icon,
                "workspace_id": page.workspace_id,
                "workspace_name": workspaces.get(page.workspace_id)
                if page.workspace_id in access.memberships
                else None,
                "deleted_at": page.deleted_at.isoformat() if page.deleted_at else None,
                "deleted_by_name": names.get(page.deleted_by) if page.deleted_by else None,
                "nested_count": max(nested - 1, 0),
                "can_purge": access.can_manage(page.id),
            }
        )
    return items


def restore_page(db: Session, access: Access, page_id: int) -> Page:
    page = access.require_page(page_id, ROLE_EDITOR, allow_deleted=True)
    if page.deleted_at is None:
        return page
    if page.trashed_with != page.id:
        raise Conflict("This page was deleted together with its parent. Restore the parent page.")

    if page.parent_id is not None:
        parent = db.get(Page, page.parent_id)
        if parent is None or parent.deleted_at is not None:
            # The original location is gone: fall back to the workspace root.
            if not role_at_least(access.workspace_role(page.workspace_id), ROLE_EDITOR):
                raise Conflict("The parent page is in the recycle bin. Restore it first.")
            page.parent_id = None
            page.position = _end_position(db, page.workspace_id, None)

    db.flush()
    db.execute(
        update(Page)
        .where(Page.trashed_with == page.id)
        .values(deleted_at=None, deleted_by=None, trashed_with=None)
    )
    db.expire_all()
    page = db.get(Page, page_id)
    assert page is not None
    _reindex_subtree(db, page)
    return page


def purge_page(db: Session, access: Access, page_id: int) -> list[Path]:
    """Permanently delete a trashed page and everything below it.

    Returns attachment files that became unreferenced; the caller unlinks them
    after the transaction has committed.
    """
    page = access.require_page(page_id, ROLE_OWNER, allow_deleted=True)
    if page.deleted_at is None:
        raise Conflict("Move the page to the recycle bin before deleting it permanently")
    return purge_pages(db, [page.id])


def purge_pages(db: Session, root_ids: list[int]) -> list[Path]:
    """Unconditionally remove pages (no permission checks — callers do those)."""
    all_ids: list[int] = []
    for root_id in root_ids:
        all_ids.extend(subtree_ids(db, root_id))
    if not all_ids:
        return []
    candidates = files.referenced_by_pages(db, all_ids)
    search.remove_pages(db, all_ids)
    db.execute(delete(PageAttachment).where(PageAttachment.page_id.in_(all_ids)))
    # Children go with their parents through ON DELETE CASCADE.
    db.execute(delete(Page).where(Page.id.in_(root_ids)))
    db.expire_all()
    return files.delete_unreferenced(db, candidates)


def empty_trash(db: Session, access: Access) -> tuple[int, list[Path]]:
    roots = db.execute(
        select(Page.id).where(Page.deleted_at.is_not(None), Page.trashed_with == Page.id)
    ).scalars()
    purgeable = [page_id for page_id in roots if access.can_manage(page_id)]
    paths: list[Path] = []
    for page_id in purgeable:
        if db.get(Page, page_id) is not None:
            paths.extend(purge_pages(db, [page_id]))
    return len(purgeable), paths


# -- quick capture -----------------------------------------------------------


def capture(db: Session, access: Access, text_value: str) -> Page:
    """Save a quick note as a new page under the user's personal Inbox."""
    user = access.user
    text_value = text_value.strip()
    if not text_value:
        raise ValidationFailed("Nothing to capture")
    inbox = db.get(Page, user.inbox_page_id) if user.inbox_page_id else None
    if inbox is None or inbox.deleted_at is not None or not access.can_edit(inbox.id):
        inbox = create_page(
            db,
            access,
            workspace_id=personal_workspace_id(db, user),
            title="Inbox",
            icon="📥",
        )
        user.inbox_page_id = inbox.id
    first_line = next((line.strip() for line in text_value.splitlines() if line.strip()), "")
    title = first_line if len(first_line) <= 80 else first_line[:77].rstrip() + "…"
    return create_page(
        db,
        access,
        workspace_id=inbox.workspace_id,
        parent_id=inbox.id,
        title=title,
        content=text_to_document(text_value),
    )


def preview_text(page: Page, limit: int = 160) -> str:
    return extract_text(page.content)[:limit]

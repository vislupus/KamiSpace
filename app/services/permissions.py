"""Access control.

The effective role of a user on a page is the strongest of:

* their membership role in the page's workspace (a member who created the
  page is its owner),
* an explicit grant on the page itself or on any of its ancestors
  (permission inheritance for nested pages).

Application administrators get no implicit access to content. Every API that
touches pages, versions, attachments or search results goes through this
module.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import Forbidden, NotFound
from app.models import (
    ROLE_EDITOR,
    ROLE_OWNER,
    ROLE_VIEWER,
    Page,
    PagePermission,
    User,
    WorkspaceMember,
)

ROLE_RANK = {ROLE_VIEWER: 1, ROLE_EDITOR: 2, ROLE_OWNER: 3}


def strongest(*roles: str | None) -> str | None:
    best: str | None = None
    for role in roles:
        if role and (best is None or ROLE_RANK[role] > ROLE_RANK[best]):
            best = role
    return best


def role_at_least(role: str | None, required: str) -> bool:
    return role is not None and ROLE_RANK[role] >= ROLE_RANK[required]


@dataclass(frozen=True, slots=True)
class PageNode:
    id: int
    parent_id: int | None
    workspace_id: int
    owner_id: int | None


class Access:
    """Per-request permission resolver for a single user (with memoisation)."""

    def __init__(self, db: Session, user: User) -> None:
        self.db = db
        self.user = user
        self._memberships: dict[int, str] | None = None
        self._grants: dict[int, str] | None = None
        self._nodes: dict[int, PageNode | None] = {}
        self._roles: dict[int, str | None] = {}

    # -- raw data -----------------------------------------------------------

    @property
    def memberships(self) -> dict[int, str]:
        if self._memberships is None:
            rows = self.db.execute(
                select(WorkspaceMember.workspace_id, WorkspaceMember.role).where(
                    WorkspaceMember.user_id == self.user.id
                )
            ).all()
            self._memberships = {ws_id: role for ws_id, role in rows}
        return self._memberships

    @property
    def grants(self) -> dict[int, str]:
        if self._grants is None:
            rows = self.db.execute(
                select(PagePermission.page_id, PagePermission.role).where(
                    PagePermission.user_id == self.user.id
                )
            ).all()
            self._grants = {page_id: role for page_id, role in rows}
        return self._grants

    def prime(self, nodes: list[PageNode]) -> None:
        """Preload tree structure to resolve many pages without extra queries."""
        for node in nodes:
            self._nodes[node.id] = node

    def _node(self, page_id: int) -> PageNode | None:
        if page_id not in self._nodes:
            row = self.db.execute(
                select(Page.id, Page.parent_id, Page.workspace_id, Page.owner_id).where(
                    Page.id == page_id
                )
            ).first()
            self._nodes[page_id] = PageNode(*row) if row else None
        return self._nodes[page_id]

    # -- resolution ---------------------------------------------------------

    def workspace_role(self, workspace_id: int) -> str | None:
        return self.memberships.get(workspace_id)

    def page_role(self, page_id: int) -> str | None:
        if page_id in self._roles:
            return self._roles[page_id]
        node = self._node(page_id)
        if node is None:
            self._roles[page_id] = None
            return None

        role = self.memberships.get(node.workspace_id)
        if role is not None and node.owner_id == self.user.id:
            role = ROLE_OWNER

        # Walk up the tree collecting inherited grants.
        seen: set[int] = set()
        current: PageNode | None = node
        while current is not None and current.id not in seen:
            seen.add(current.id)
            role = strongest(role, self.grants.get(current.id))
            if role == ROLE_OWNER or current.parent_id is None:
                break
            current = self._node(current.parent_id)

        self._roles[page_id] = role
        return role

    def can_view(self, page_id: int) -> bool:
        return role_at_least(self.page_role(page_id), ROLE_VIEWER)

    def can_edit(self, page_id: int) -> bool:
        return role_at_least(self.page_role(page_id), ROLE_EDITOR)

    def can_manage(self, page_id: int) -> bool:
        return role_at_least(self.page_role(page_id), ROLE_OWNER)

    def ancestors(self, page_id: int) -> tuple[list[dict[str, object]], bool]:
        """Ancestors of a page (root first) that the user may see.

        The second value tells whether any ancestor was hidden, i.e. the page
        is reached through a share rather than through its workspace.
        """
        chain: list[dict[str, object]] = []
        hidden = False
        seen = {page_id}
        node = self._node(page_id)
        parent_id = node.parent_id if node else None
        while parent_id is not None and parent_id not in seen:
            seen.add(parent_id)
            row = self.db.execute(
                select(Page.id, Page.title, Page.icon, Page.parent_id).where(Page.id == parent_id)
            ).first()
            if row is None:
                break
            if self.can_view(row.id):
                chain.append({"id": row.id, "title": row.title, "icon": row.icon})
            else:
                hidden = True
            parent_id = row.parent_id
        chain.reverse()
        return chain, hidden

    # -- enforcement --------------------------------------------------------

    def require_page(
        self, page_id: int, required: str = ROLE_VIEWER, *, allow_deleted: bool = False
    ) -> Page:
        """Load a page or raise. Pages the user cannot see look like 404s."""
        page = self.db.get(Page, page_id)
        if page is None:
            raise NotFound("Page not found")
        role = self.page_role(page.id)
        if role is None:
            raise NotFound("Page not found")
        if page.deleted_at is not None and not allow_deleted:
            raise NotFound("Page is in the recycle bin")
        if not role_at_least(role, required):
            raise Forbidden(f"This action requires {required} access to the page")
        return page

    def require_workspace(self, workspace_id: int, required: str = ROLE_VIEWER) -> str:
        role = self.workspace_role(workspace_id)
        if role is None:
            raise NotFound("Workspace not found")
        if not role_at_least(role, required):
            raise Forbidden(f"This action requires {required} access to the workspace")
        return role

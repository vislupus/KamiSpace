"""SQLAlchemy models.

Document content is stored as ProseMirror/Tiptap JSON. Binary files stay on
disk; only their metadata and relationships live in SQLite.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base, UTCDateTime, utcnow

ROLE_VIEWER = "viewer"
ROLE_EDITOR = "editor"
ROLE_OWNER = "owner"
ROLES = (ROLE_VIEWER, ROLE_EDITOR, ROLE_OWNER)

WORKSPACE_PERSONAL = "personal"
WORKSPACE_TEAM = "team"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class UserSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # Only a SHA-256 digest of the cookie value is stored.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)

    user: Mapped[User] = relationship(lazy="joined")


class Invite(Base):
    __tablename__ = "invites"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    used_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )


class LoginAttempt(Base):
    """Failed login attempts, used for rate limiting."""

    __tablename__ = "login_attempts"

    id: Mapped[int] = mapped_column(primary_key=True)
    identifier: Mapped[str] = mapped_column(String(254), index=True)
    ip: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(16), default=WORKSPACE_TEAM)
    # For personal workspaces: the user it belongs to. For teams: the creator.
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    members: Mapped[list[WorkspaceMember]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan", passive_deletes=True
    )


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"

    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role: Mapped[str] = mapped_column(String(16), default=ROLE_EDITOR)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    workspace: Mapped[Workspace] = relationship(back_populates="members")
    user: Mapped[User] = relationship()


class Page(Base):
    __tablename__ = "pages"

    id: Mapped[int] = mapped_column(primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("pages.id", ondelete="CASCADE"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(300), default="")
    icon: Mapped[str | None] = mapped_column(String(32), nullable=True)
    cover_attachment_id: Mapped[str | None] = mapped_column(
        ForeignKey("attachments.id", ondelete="SET NULL", name="fk_pages_cover"),
        nullable=True,
    )
    # Vertical focus of the cover image, 0 (top) … 100 (bottom).
    cover_position: Mapped[int] = mapped_column(Integer, default=50)
    # Appearance & layout, shared by everyone who opens the page.
    font: Mapped[str] = mapped_column(String(16), default="default")
    # Size of ordinary text in pixels; headings scale with it.
    text_size: Mapped[int] = mapped_column(Integer, default=16)
    full_width: Mapped[bool] = mapped_column(Boolean, default=False)
    # A locked page cannot be edited until somebody with edit rights unlocks it.
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    # "page", or "database": a page that holds a table of rows. The rows are
    # its sub-pages, so they inherit access, can be opened, shared and trashed.
    kind: Mapped[str] = mapped_column(String(16), default="page")
    # For a database: its properties (columns) and views.
    db_schema: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    # For a row of a database: property id → value.
    props: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    content: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # Incremented on every content save; the basis for optimistic concurrency.
    revision: Mapped[int] = mapped_column(Integer, default=1)
    position: Mapped[float] = mapped_column(Float, default=0.0)
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Recycle bin: a trashed page keeps its place in the tree.
    deleted_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True, index=True)
    deleted_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Id of the page whose deletion put this page in the bin (itself for the root).
    trashed_with: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    __table_args__ = (Index("ix_pages_tree", "workspace_id", "parent_id", "position"),)


class PagePermission(Base):
    """Explicit per-user grant on a page. Inherited by all nested pages."""

    __tablename__ = "page_permissions"

    id: Mapped[int] = mapped_column(primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    granted_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    __table_args__ = (UniqueConstraint("page_id", "user_id", name="uq_page_permission"),)


class PageVersion(Base):
    __tablename__ = "page_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(300), default="")
    content: Mapped[dict[str, Any]] = mapped_column(JSON)
    author_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # auto: folded autosaves, manual: named snapshot, restore: result of a restore
    kind: Mapped[str] = mapped_column(String(16), default="auto")
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    __table_args__ = (UniqueConstraint("page_id", "number", name="uq_page_version_number"),)


class Task(Base):
    """Index of the to-do items inside pages (rebuilt whenever a page is saved).

    The document stays the source of truth; this table only makes "My tasks"
    a cheap query.
    """

    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("pages.id", ondelete="CASCADE"), index=True)
    # Identifier of the to-do item inside the document (taskItem.attrs.taskId).
    task_key: Mapped[str] = mapped_column(String(32))
    text: Mapped[str] = mapped_column(String(500), default="")
    checked: Mapped[bool] = mapped_column(Boolean, default=False)
    assignee_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    due: Mapped[str | None] = mapped_column(String(10), nullable=True)  # YYYY-MM-DD
    position: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (UniqueConstraint("page_id", "task_key", name="uq_task_key"),)


class Attachment(Base):
    __tablename__ = "attachments"

    # Random identifier; also the only thing a client ever refers to.
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    # Path below the uploads directory, generated server side.
    storage_name: Mapped[str] = mapped_column(String(80), unique=True)
    original_name: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(16))  # image | pdf | video | audio | file
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    uploader_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class PageAttachment(Base):
    """A page references an attachment in its current content or its history.

    Rows are only removed when the page itself is permanently deleted, which is
    what keeps files alive for old versions and for pages in the recycle bin.
    """

    __tablename__ = "page_attachments"

    page_id: Mapped[int] = mapped_column(
        ForeignKey("pages.id", ondelete="CASCADE"), primary_key=True
    )
    attachment_id: Mapped[str] = mapped_column(
        ForeignKey("attachments.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Favorite(Base):
    __tablename__ = "favorites"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    page_id: Mapped[int] = mapped_column(
        ForeignKey("pages.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class PageVisit(Base):
    __tablename__ = "page_visits"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    page_id: Mapped[int] = mapped_column(
        ForeignKey("pages.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    visited_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)

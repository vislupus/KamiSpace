"""initial schema

Revision ID: 0001
Revises: -
Create Date: 2026-11-13 13:59:35.010802
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "login_attempts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("identifier", sa.String(length=254), nullable=False),
        sa.Column("ip", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("login_attempts", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_login_attempts_created_at"), ["created_at"], unique=False
        )
        batch_op.create_index(
            batch_op.f("ix_login_attempts_identifier"), ["identifier"], unique=False
        )
        batch_op.create_index(batch_op.f("ix_login_attempts_ip"), ["ip"], unique=False)

    op.create_table(
        "settings",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("email", sa.String(length=254), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("is_admin", sa.Boolean(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("inbox_page_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("last_login_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
        sa.UniqueConstraint("username"),
    )
    op.create_table(
        "attachments",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("storage_name", sa.String(length=80), nullable=False),
        sa.Column("original_name", sa.String(length=255), nullable=False),
        sa.Column("mime", sa.String(length=120), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("uploader_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["uploader_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("storage_name"),
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("target_type", sa.String(length=32), nullable=True),
        sa.Column("target_id", sa.String(length=64), nullable=True),
        sa.Column("detail", sa.JSON(), nullable=True),
        sa.Column("ip", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("audit_events", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_audit_events_action"), ["action"], unique=False)
        batch_op.create_index(
            batch_op.f("ix_audit_events_created_at"), ["created_at"], unique=False
        )
        batch_op.create_index(batch_op.f("ix_audit_events_user_id"), ["user_id"], unique=False)

    op.create_table(
        "invites",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("email", sa.String(length=254), nullable=True),
        sa.Column("is_admin", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("used_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["used_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("csrf_token", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("ip", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    with op.batch_alter_table("sessions", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_sessions_user_id"), ["user_id"], unique=False)

    op.create_table(
        "workspaces",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("workspaces", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_workspaces_owner_id"), ["owner_id"], unique=False)

    op.create_table(
        "pages",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("icon", sa.String(length=32), nullable=True),
        sa.Column("cover_attachment_id", sa.String(length=32), nullable=True),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("position", sa.Float(), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("deleted_by", sa.Integer(), nullable=True),
        sa.Column("trashed_with", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["cover_attachment_id"], ["attachments.id"], name="fk_pages_cover", ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["deleted_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["parent_id"], ["pages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("pages", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_pages_deleted_at"), ["deleted_at"], unique=False)
        batch_op.create_index(batch_op.f("ix_pages_owner_id"), ["owner_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_pages_parent_id"), ["parent_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_pages_trashed_with"), ["trashed_with"], unique=False)
        batch_op.create_index(
            "ix_pages_tree", ["workspace_id", "parent_id", "position"], unique=False
        )
        batch_op.create_index(batch_op.f("ix_pages_workspace_id"), ["workspace_id"], unique=False)

    op.create_table(
        "workspace_members",
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("workspace_id", "user_id"),
    )
    with op.batch_alter_table("workspace_members", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_workspace_members_user_id"), ["user_id"], unique=False)

    op.create_table(
        "favorites",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("page_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["page_id"], ["pages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "page_id"),
    )
    with op.batch_alter_table("favorites", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_favorites_page_id"), ["page_id"], unique=False)

    op.create_table(
        "page_attachments",
        sa.Column("page_id", sa.Integer(), nullable=False),
        sa.Column("attachment_id", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["attachment_id"], ["attachments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["page_id"], ["pages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("page_id", "attachment_id"),
    )
    with op.batch_alter_table("page_attachments", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_page_attachments_attachment_id"), ["attachment_id"], unique=False
        )

    op.create_table(
        "page_permissions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("page_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("granted_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["granted_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["page_id"], ["pages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("page_id", "user_id", name="uq_page_permission"),
    )
    with op.batch_alter_table("page_permissions", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_page_permissions_page_id"), ["page_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_page_permissions_user_id"), ["user_id"], unique=False)

    op.create_table(
        "page_versions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("page_id", sa.Integer(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("author_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("description", sa.String(length=300), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["page_id"], ["pages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("page_id", "number", name="uq_page_version_number"),
    )
    with op.batch_alter_table("page_versions", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_page_versions_page_id"), ["page_id"], unique=False)

    op.create_table(
        "page_visits",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("page_id", sa.Integer(), nullable=False),
        sa.Column("visited_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["page_id"], ["pages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "page_id"),
    )
    with op.batch_alter_table("page_visits", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_page_visits_page_id"), ["page_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_page_visits_visited_at"), ["visited_at"], unique=False)

    # Full-text index (FTS5 virtual table; rowid = pages.id).
    op.execute(
        """
        CREATE VIRTUAL TABLE pages_fts USING fts5(
            title,
            path,
            body,
            tokenize = 'unicode61 remove_diacritics 2',
            prefix = '2 3'
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS pages_fts")
    with op.batch_alter_table("page_visits", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_page_visits_visited_at"))
        batch_op.drop_index(batch_op.f("ix_page_visits_page_id"))

    op.drop_table("page_visits")
    with op.batch_alter_table("page_versions", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_page_versions_page_id"))

    op.drop_table("page_versions")
    with op.batch_alter_table("page_permissions", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_page_permissions_user_id"))
        batch_op.drop_index(batch_op.f("ix_page_permissions_page_id"))

    op.drop_table("page_permissions")
    with op.batch_alter_table("page_attachments", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_page_attachments_attachment_id"))

    op.drop_table("page_attachments")
    with op.batch_alter_table("favorites", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_favorites_page_id"))

    op.drop_table("favorites")
    with op.batch_alter_table("workspace_members", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_workspace_members_user_id"))

    op.drop_table("workspace_members")
    with op.batch_alter_table("pages", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_pages_workspace_id"))
        batch_op.drop_index("ix_pages_tree")
        batch_op.drop_index(batch_op.f("ix_pages_trashed_with"))
        batch_op.drop_index(batch_op.f("ix_pages_parent_id"))
        batch_op.drop_index(batch_op.f("ix_pages_owner_id"))
        batch_op.drop_index(batch_op.f("ix_pages_deleted_at"))

    op.drop_table("pages")
    with op.batch_alter_table("workspaces", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_workspaces_owner_id"))

    op.drop_table("workspaces")
    with op.batch_alter_table("sessions", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_sessions_user_id"))

    op.drop_table("sessions")
    op.drop_table("invites")
    with op.batch_alter_table("audit_events", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_audit_events_user_id"))
        batch_op.drop_index(batch_op.f("ix_audit_events_created_at"))
        batch_op.drop_index(batch_op.f("ix_audit_events_action"))

    op.drop_table("audit_events")
    op.drop_table("attachments")
    op.drop_table("users")
    op.drop_table("settings")
    with op.batch_alter_table("login_attempts", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_login_attempts_ip"))
        batch_op.drop_index(batch_op.f("ix_login_attempts_identifier"))
        batch_op.drop_index(batch_op.f("ix_login_attempts_created_at"))

    op.drop_table("login_attempts")

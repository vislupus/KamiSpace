"""usernames only, page appearance and lock, cover position, task index

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-16
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Accounts are a username and a password; nothing is ever emailed.
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("email")
        batch_op.drop_column("display_name")
        batch_op.drop_column("inbox_page_id")
    with op.batch_alter_table("invites", schema=None) as batch_op:
        batch_op.drop_column("email")

    with op.batch_alter_table("pages", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("cover_position", sa.Integer(), nullable=False, server_default="50")
        )
        batch_op.add_column(
            sa.Column("font", sa.String(length=16), nullable=False, server_default="default")
        )
        batch_op.add_column(
            sa.Column("small_text", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(
            sa.Column("full_width", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(
            sa.Column("locked", sa.Boolean(), nullable=False, server_default=sa.false())
        )

    op.create_table(
        "tasks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("page_id", sa.Integer(), nullable=False),
        sa.Column("task_key", sa.String(length=32), nullable=False),
        sa.Column("text", sa.String(length=500), nullable=False),
        sa.Column("checked", sa.Boolean(), nullable=False),
        sa.Column("assignee_id", sa.Integer(), nullable=True),
        sa.Column("due", sa.String(length=10), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["assignee_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["page_id"], ["pages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("page_id", "task_key", name="uq_task_key"),
    )
    with op.batch_alter_table("tasks", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_tasks_assignee_id"), ["assignee_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_tasks_page_id"), ["page_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("tasks", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_tasks_page_id"))
        batch_op.drop_index(batch_op.f("ix_tasks_assignee_id"))
    op.drop_table("tasks")

    with op.batch_alter_table("pages", schema=None) as batch_op:
        batch_op.drop_column("locked")
        batch_op.drop_column("full_width")
        batch_op.drop_column("small_text")
        batch_op.drop_column("font")
        batch_op.drop_column("cover_position")

    with op.batch_alter_table("invites", schema=None) as batch_op:
        batch_op.add_column(sa.Column("email", sa.String(length=254), nullable=True))

    # The removed values cannot be brought back; rebuild them from the username.
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("inbox_page_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("display_name", sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column("email", sa.String(length=254), nullable=True))
    op.execute("UPDATE users SET display_name = username, email = username || '@example.invalid'")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.alter_column("display_name", existing_type=sa.String(length=120), nullable=False)
        batch_op.alter_column("email", existing_type=sa.String(length=254), nullable=False)
        batch_op.create_unique_constraint("uq_users_email", ["email"])

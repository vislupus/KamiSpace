"""page text size (replaces "small text"), databases and their rows

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-19
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("pages", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("text_size", sa.Integer(), nullable=False, server_default="16")
        )
        batch_op.add_column(
            sa.Column("kind", sa.String(length=16), nullable=False, server_default="page")
        )
        batch_op.add_column(sa.Column("db_schema", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("props", sa.JSON(), nullable=True))
    # "Small text" becomes a text size of 14 pixels.
    op.execute("UPDATE pages SET text_size = 14 WHERE small_text")
    with op.batch_alter_table("pages", schema=None) as batch_op:
        batch_op.drop_column("small_text")


def downgrade() -> None:
    with op.batch_alter_table("pages", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("small_text", sa.Boolean(), nullable=False, server_default=sa.false())
        )
    op.execute("UPDATE pages SET small_text = 1 WHERE text_size < 16")
    # Rows keep existing as ordinary sub-pages; their property values are lost.
    with op.batch_alter_table("pages", schema=None) as batch_op:
        batch_op.drop_column("props")
        batch_op.drop_column("db_schema")
        batch_op.drop_column("kind")
        batch_op.drop_column("text_size")

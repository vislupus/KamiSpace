"""Start a throwaway MindDock instance for the browser tests.

Run from the project root:  uv run python tests/e2e_server.py [port]

The instance uses its own data directory (data/temp/e2e), wiped on every
start, and is seeded with three accounts sharing one password.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DATA_DIR = ROOT / "data" / "temp" / "e2e"
PASSWORD = "correct horse battery"
USERS = [
    ("admin", "Ada Admin", True),
    ("alice", "Alice Archer", False),
    ("bob", "Bob Builder", False),
]


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    shutil.rmtree(DATA_DIR, ignore_errors=True)
    os.environ["MINDDOCK_DATA_DIR"] = str(DATA_DIR)
    os.environ["MINDDOCK_ENV"] = "production"
    os.environ["MINDDOCK_COOKIE_SECURE"] = "never"
    os.environ["MINDDOCK_LOGIN_MAX_FAILURES"] = "1000"

    import uvicorn

    from app.cli import run_migrations
    from app.db import session_scope
    from app.services import auth

    run_migrations()
    with session_scope() as db:
        for username, name, is_admin in USERS:
            auth.create_user(
                db,
                username=username,
                email=f"{username}@example.com",
                password=PASSWORD,
                display_name=name,
                is_admin=is_admin,
            )
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()

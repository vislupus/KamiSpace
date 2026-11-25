"""Database engine and session handling (SQLite + SQLAlchemy 2)."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from functools import lru_cache

from sqlalchemy import DateTime, Engine, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from app.config import get_settings


def utcnow() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator[datetime]):
    """Store datetimes as naive UTC, always hand back timezone-aware values."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is not None:
            value = value.astimezone(UTC).replace(tzinfo=None)
        return value

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    pass


def configure_sqlite(engine: Engine) -> None:
    """Apply pragmas on every new connection and take over transaction control.

    pysqlite's implicit transaction handling is disabled so that we can decide
    per session whether a transaction starts with ``BEGIN IMMEDIATE`` (writers,
    avoids lock-upgrade failures under WAL) or a plain ``BEGIN`` (readers).
    See ``_emit_begin`` below.
    """

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_connection, _record) -> None:
        dbapi_connection.isolation_level = None
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=15000")
        cursor.execute("PRAGMA temp_store=MEMORY")
        # 8 MB of page cache per connection and memory-mapped reads.
        cursor.execute("PRAGMA cache_size=-8000")
        cursor.execute("PRAGMA mmap_size=268435456")
        cursor.close()


# One writer at a time is all SQLite allows. Inside a process the writers
# wait for each other here, in a queue, instead of each polling the lock of
# the file until its patience runs out ("database is locked") while a slower
# request holds it. Between worker processes SQLite's own waiting applies,
# with one contender per process.
_write_turn = threading.Lock()
WRITE_WAIT_SECONDS = 30


def _release_write_turn(session: Session) -> None:
    if session.info.pop("write_turn", False):
        _write_turn.release()


@event.listens_for(Session, "after_begin")
def _emit_begin(session: Session, _transaction, connection) -> None:
    """Start the real SQLite transaction for ORM sessions.

    Writers take the write lock up front; read-only sessions use a deferred
    transaction so they never block (or get blocked by) a writer under WAL.
    """
    if connection.dialect.name != "sqlite":
        return
    if session.info.get("read_only", False):
        connection.exec_driver_sql("BEGIN")
        return
    if not session.info.get("write_turn"):
        # After a long wait the request goes on regardless and lets SQLite decide.
        session.info["write_turn"] = _write_turn.acquire(timeout=WRITE_WAIT_SECONDS)
    try:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
    except Exception:
        _release_write_turn(session)
        raise


@event.listens_for(Session, "after_transaction_end")
def _end_write_turn(session: Session, transaction) -> None:
    # The outermost transaction is over (committed, rolled back or closed).
    if transaction.parent is None:
        _release_write_turn(session)


@lru_cache
def get_engine() -> Engine:
    settings = get_settings()
    settings.ensure_directories()
    engine = create_engine(
        settings.database_url,
        connect_args={"check_same_thread": False, "timeout": 15},
        # Requests run on a pool of 40 threads; each needs a connection of
        # its own, and none of them should wait for one.
        pool_size=10,
        max_overflow=40,
    )
    configure_sqlite(engine)
    return engine


@lru_cache
def get_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False, autoflush=False)


def new_session(*, read_only: bool = False) -> Session:
    session = get_sessionmaker()()
    session.info["read_only"] = read_only
    return session


@contextmanager
def session_scope(*, read_only: bool = False) -> Iterator[Session]:
    """Transactional scope for code running outside a request (CLI, tasks)."""
    session = new_session(read_only=read_only)
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def reset_engine() -> None:
    """Dispose cached engine/sessionmaker (used by tests and restore)."""
    if get_engine.cache_info().currsize:
        get_engine().dispose()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()

"""The log file, written by one process or by several workers at once."""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler

try:  # not available on Windows, where a single process writes the file
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]


class SharedRotatingFileHandler(RotatingFileHandler):
    """A size-limited log file that several worker processes share.

    The standard handler assumes it is the only writer: when two processes
    rotate the file at the same moment, lines are lost or end up in the wrong
    file. Here every write happens under a file lock, and a process first
    reopens the file when another one has rotated it in the meantime.
    """

    def __init__(self, filename: str | os.PathLike[str], **kwargs: object) -> None:
        super().__init__(filename, **kwargs)  # type: ignore[arg-type]
        self._lock_path = f"{self.baseFilename}.lock"

    def _rotated_elsewhere(self) -> bool:
        if self.stream is None:
            return False
        try:
            return os.fstat(self.stream.fileno()).st_ino != os.stat(self.baseFilename).st_ino
        except OSError:
            return True

    def emit(self, record: logging.LogRecord) -> None:
        if fcntl is None:
            super().emit(record)
            return
        try:
            with open(self._lock_path, "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    if self._rotated_elsewhere():
                        self.stream.close()
                        self.stream = self._open()
                    if self.shouldRollover(record):
                        self.doRollover()
                    logging.FileHandler.emit(self, record)
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)
        except Exception:
            self.handleError(record)

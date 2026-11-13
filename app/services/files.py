"""Attachment storage.

Files are written below ``data/uploads`` under server generated names. The
original file name is metadata only and never becomes part of a path. Files
are served exclusively through an access-controlled endpoint.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import secrets
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import NotFound, PayloadTooLarge, ValidationFailed
from app.models import Attachment, PageAttachment, User
from app.services.permissions import Access

CHUNK_SIZE = 1024 * 256


@dataclass(frozen=True, slots=True)
class FileType:
    mime: str
    kind: str  # image | pdf | file
    signature: str  # which content check applies


_ZIP = "zip"
_OLE = "ole"
_TEXT = "text"

ALLOWED_TYPES: dict[str, FileType] = {
    "png": FileType("image/png", "image", "png"),
    "jpg": FileType("image/jpeg", "image", "jpeg"),
    "jpeg": FileType("image/jpeg", "image", "jpeg"),
    "webp": FileType("image/webp", "image", "webp"),
    "gif": FileType("image/gif", "image", "gif"),
    "pdf": FileType("application/pdf", "pdf", "pdf"),
    "txt": FileType("text/plain; charset=utf-8", "file", _TEXT),
    "md": FileType("text/markdown; charset=utf-8", "file", _TEXT),
    "markdown": FileType("text/markdown; charset=utf-8", "file", _TEXT),
    "csv": FileType("text/csv; charset=utf-8", "file", _TEXT),
    "rtf": FileType("application/rtf", "file", "rtf"),
    "doc": FileType("application/msword", "file", _OLE),
    "xls": FileType("application/vnd.ms-excel", "file", _OLE),
    "ppt": FileType("application/vnd.ms-powerpoint", "file", _OLE),
    "docx": FileType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "file", _ZIP
    ),
    "xlsx": FileType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "file", _ZIP
    ),
    "pptx": FileType(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation", "file", _ZIP
    ),
    "odt": FileType("application/vnd.oasis.opendocument.text", "file", _ZIP),
    "ods": FileType("application/vnd.oasis.opendocument.spreadsheet", "file", _ZIP),
    "odp": FileType("application/vnd.oasis.opendocument.presentation", "file", _ZIP),
    "zip": FileType("application/zip", "file", _ZIP),
}

# Only these are ever rendered by the browser; everything else is a download.
INLINE_KINDS = {"image", "pdf"}


def _signature_matches(signature: str, head: bytes) -> bool:
    if signature == "png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if signature == "jpeg":
        return head.startswith(b"\xff\xd8\xff")
    if signature == "gif":
        return head.startswith((b"GIF87a", b"GIF89a"))
    if signature == "webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if signature == "pdf":
        return b"%PDF-" in head[:1024]
    if signature == _ZIP:
        return head.startswith((b"PK\x03\x04", b"PK\x05\x06"))
    if signature == _OLE:
        return head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    if signature == "rtf":
        return head.startswith(b"{\\rtf")
    if signature == _TEXT:
        return b"\x00" not in head
    return False


def clean_filename(name: str | None) -> str:
    """Reduce a client supplied name to a harmless display name."""
    name = (name or "").replace("\\", "/").split("/")[-1]
    name = "".join(ch for ch in name if ch.isprintable() and ch not in '<>:"|?*').strip(" .")
    return name[:255] or "file"


def file_type_for(filename: str) -> FileType:
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    file_type = ALLOWED_TYPES.get(extension)
    if file_type is None:
        allowed = ", ".join(sorted(ALLOWED_TYPES))
        raise ValidationFailed(f"This file type is not allowed. Allowed types: {allowed}")
    return file_type


def storage_path(storage_name: str) -> Path:
    """Resolve a stored name and make sure it cannot escape the uploads directory."""
    root = get_settings().uploads_dir.resolve()
    path = (root / storage_name).resolve()
    if root not in path.parents:
        raise NotFound("File not found")
    return path


def store_upload(
    db: Session, user: User, page_id: int, stream: BinaryIO, filename: str | None
) -> Attachment:
    """Validate and persist an uploaded file, linking it to ``page_id``."""
    settings = get_settings()
    display_name = clean_filename(filename)
    file_type = file_type_for(display_name)

    attachment_id = secrets.token_hex(16)
    storage_name = f"{attachment_id[:2]}/{attachment_id}"
    digest = hashlib.sha256()
    size = 0
    head = b""

    settings.temp_dir.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="upload-", dir=settings.temp_dir)
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := stream.read(CHUNK_SIZE):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise PayloadTooLarge(
                        f"File is larger than the {settings.max_upload_mb} MB upload limit"
                    )
                if len(head) < 4096:
                    head += chunk[: 4096 - len(head)]
                digest.update(chunk)
                out.write(chunk)
        if size == 0:
            raise ValidationFailed("The uploaded file is empty")
        if not _signature_matches(file_type.signature, head):
            raise ValidationFailed("The file content does not match its file type")

        destination = storage_path(storage_name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temp_name, destination)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)

    attachment = Attachment(
        id=attachment_id,
        storage_name=storage_name,
        original_name=display_name,
        mime=file_type.mime,
        kind=file_type.kind,
        size=size,
        sha256=digest.hexdigest(),
        uploader_id=user.id,
    )
    db.add(attachment)
    db.flush()
    db.add(PageAttachment(page_id=page_id, attachment_id=attachment_id))
    return attachment


def serialize_attachment(attachment: Attachment) -> dict[str, Any]:
    return {
        "id": attachment.id,
        "name": attachment.original_name,
        "mime": attachment.mime.split(";")[0],
        "kind": attachment.kind,
        "size": attachment.size,
        "url": f"/api/files/{attachment.id}",
    }


def can_read(db: Session, access: Access, attachment_id: str) -> bool:
    """A user may read a file when they can view any page that references it."""
    page_ids = db.execute(
        select(PageAttachment.page_id).where(PageAttachment.attachment_id == attachment_id)
    ).scalars()
    return any(access.can_view(page_id) for page_id in page_ids)


def get_readable(db: Session, access: Access, attachment_id: str) -> Attachment:
    attachment = db.get(Attachment, attachment_id)
    if attachment is None or not can_read(db, access, attachment_id):
        raise NotFound("File not found")
    return attachment


def link_attachments(db: Session, access: Access, page_id: int, attachment_ids: set[str]) -> None:
    """Reference attachments from a page, but only ones the user may read."""
    if not attachment_ids:
        return
    existing = set(
        db.execute(
            select(PageAttachment.attachment_id).where(
                PageAttachment.page_id == page_id,
                PageAttachment.attachment_id.in_(attachment_ids),
            )
        ).scalars()
    )
    for attachment_id in attachment_ids - existing:
        if db.get(Attachment, attachment_id) is not None and can_read(db, access, attachment_id):
            db.add(PageAttachment(page_id=page_id, attachment_id=attachment_id))


def referenced_by_pages(db: Session, page_ids: list[int]) -> set[str]:
    if not page_ids:
        return set()
    return set(
        db.execute(
            select(PageAttachment.attachment_id).where(PageAttachment.page_id.in_(page_ids))
        ).scalars()
    )


def delete_unreferenced(db: Session, candidate_ids: set[str]) -> list[Path]:
    """Drop attachments nobody references any more; returns files to unlink.

    The caller unlinks the returned paths only after the transaction commits.
    """
    paths: list[Path] = []
    for attachment_id in candidate_ids:
        still_used = db.execute(
            select(PageAttachment.page_id)
            .where(PageAttachment.attachment_id == attachment_id)
            .limit(1)
        ).first()
        if still_used:
            continue
        attachment = db.get(Attachment, attachment_id)
        if attachment is None:
            continue
        paths.append(storage_path(attachment.storage_name))
        db.execute(delete(Attachment).where(Attachment.id == attachment_id))
    return paths


def unlink_files(paths: list[Path]) -> None:
    for path in paths:
        with contextlib.suppress(OSError):
            path.unlink(missing_ok=True)

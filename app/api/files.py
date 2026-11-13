"""Uploading and downloading attachments (always access controlled)."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, UploadFile
from fastapi.responses import FileResponse

from app.deps import Db, UserAccess
from app.errors import NotFound
from app.models import ROLE_EDITOR
from app.services import files

router = APIRouter(tags=["files"])


@router.post("/pages/{page_id}/files", status_code=201)
def upload_file(page_id: int, file: UploadFile, access: UserAccess, db: Db) -> dict[str, Any]:
    page = access.require_page(page_id, ROLE_EDITOR)
    attachment = files.store_upload(db, access.user, page.id, file.file, file.filename)
    try:
        db.commit()
    except Exception:
        files.unlink_files([files.storage_path(attachment.storage_name)])
        raise
    return files.serialize_attachment(attachment)


@router.get("/files/{attachment_id}")
def download_file(
    attachment_id: str, access: UserAccess, db: Db, download: bool = False
) -> FileResponse:
    attachment = files.get_readable(db, access, attachment_id)
    path = files.storage_path(attachment.storage_name)
    if not path.is_file():
        raise NotFound("File not found")

    inline = attachment.kind in files.INLINE_KINDS and not download
    disposition = "inline" if inline else "attachment"
    ascii_name = attachment.original_name.encode("ascii", "replace").decode().replace('"', "'")
    headers = {
        "Content-Disposition": (
            f'{disposition}; filename="{ascii_name}"; '
            f"filename*=UTF-8''{quote(attachment.original_name)}"
        ),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=86400",
        # Uploaded content never gets to run script in the application origin.
        "Content-Security-Policy": (
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"
            if attachment.kind == "pdf"
            else "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        ),
    }
    db.close()
    return FileResponse(path, media_type=attachment.mime, headers=headers)

"""Fetching public web addresses on a user's request.

Used for bookmark previews and for images pasted from web pages. Because the
server makes the request, the target is checked first: only http(s), only
hosts that resolve to public addresses (no loopback, private, link-local or
otherwise reserved ranges), and the connection is made to exactly the address
that was checked, so a DNS answer cannot change in between. Redirects are
followed by hand and re-checked the same way.
"""

from __future__ import annotations

import contextlib
import http.client
import io
import ipaddress
import posixpath
import socket
import ssl
from html.parser import HTMLParser
from typing import Any
from urllib.parse import unquote, urljoin, urlsplit

from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import Forbidden, PayloadTooLarge, ValidationFailed
from app.models import Attachment, User
from app.services import files

TIMEOUT_SECONDS = 6
MAX_REDIRECTS = 4
MAX_HTML_BYTES = 512 * 1024
USER_AGENT = "KamiSpace/1.0 (link preview)"


def require_enabled() -> None:
    if not get_settings().allow_remote_fetch:
        raise Forbidden("Fetching web addresses is turned off on this server")


def public_address(host: str, port: int) -> str:
    """Resolve a host and return one address, refusing anything not public."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise ValidationFailed("This address could not be found") from exc
    addresses: list[str] = []
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        mapped = getattr(ip, "ipv4_mapped", None)
        if not ip.is_global or (mapped is not None and not mapped.is_global):
            raise ValidationFailed("This address is not reachable from the server")
        addresses.append(str(ip))
    if not addresses:
        raise ValidationFailed("This address could not be found")
    return addresses[0]


def split_target(url: str) -> tuple[str, str, int, str]:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValidationFailed("Only http and https addresses are supported")
    if parts.username or parts.password:
        raise ValidationFailed("Addresses with credentials are not supported")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise ValidationFailed("Invalid address") from exc
    path = parts.path or "/"
    if parts.query:
        path += f"?{parts.query}"
    return parts.scheme, parts.hostname, port, path


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, address: str) -> None:
        super().__init__(host, port, timeout=TIMEOUT_SECONDS)
        self._address = address

    def connect(self) -> None:
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, address: str) -> None:
        self._tls = ssl.create_default_context()
        super().__init__(host, port, timeout=TIMEOUT_SECONDS, context=self._tls)
        self._address = address

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), self.timeout)
        # Certificate and SNI are still checked against the host name.
        self.sock = self._tls.wrap_socket(sock, server_hostname=self.host)


def _request(url: str, accept: str, limit: int) -> tuple[int, dict[str, str], bytes]:
    """One GET without following redirects. Returns status, headers, body."""
    scheme, host, port, path = split_target(url)
    address = public_address(host, port)
    connection_type = _PinnedHTTPSConnection if scheme == "https" else _PinnedHTTPConnection
    connection = connection_type(host, port, address)
    try:
        connection.request("GET", path, headers={"User-Agent": USER_AGENT, "Accept": accept})
        response = connection.getresponse()
        headers = {key.lower(): value for key, value in response.getheaders()}
        body = response.read(limit + 1)
        return response.status, headers, body
    except (OSError, http.client.HTTPException) as exc:
        raise ValidationFailed("This address could not be loaded") from exc
    finally:
        connection.close()


def fetch(url: str, *, accept: str, limit: int) -> tuple[str, dict[str, str], bytes]:
    """GET a public URL, following a few redirects. Returns final URL, headers, body."""
    require_enabled()
    for _ in range(MAX_REDIRECTS + 1):
        status, headers, body = _request(url, accept, limit)
        if status in (301, 302, 303, 307, 308) and headers.get("location"):
            url = urljoin(url, headers["location"])
            continue
        if status != 200:
            raise ValidationFailed(f"The site answered with an error ({status})")
        return url, headers, body
    raise ValidationFailed("Too many redirects")


# -- bookmarks ---------------------------------------------------------------


class _MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            values = {key: value or "" for key, value in attrs}
            name = (values.get("property") or values.get("name") or "").lower()
            if name and values.get("content") and name not in self.meta:
                self.meta[name] = values["content"]

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data


def _clean(value: str | None, limit: int) -> str | None:
    value = " ".join((value or "").split())
    return value[:limit] or None


def parse_metadata(html: str) -> dict[str, str | None]:
    parser = _MetadataParser()
    with contextlib.suppress(Exception):  # malformed markup must not fail the request
        parser.feed(html)
    meta = parser.meta
    return {
        "title": _clean(meta.get("og:title") or parser.title or meta.get("twitter:title"), 300),
        "description": _clean(
            meta.get("og:description")
            or meta.get("description")
            or meta.get("twitter:description"),
            500,
        ),
    }


def bookmark_preview(url: str) -> dict[str, Any]:
    """Title and description of a web page, for a bookmark block."""
    final_url, headers, body = fetch(url, accept="text/html,*/*;q=0.5", limit=MAX_HTML_BYTES)
    metadata: dict[str, str | None] = {"title": None, "description": None}
    if "html" in headers.get("content-type", "text/html"):
        charset = "utf-8"
        content_type = headers.get("content-type", "")
        if "charset=" in content_type:
            charset = content_type.split("charset=")[-1].split(";")[0].strip(" \"'") or "utf-8"
        try:
            text = body[:MAX_HTML_BYTES].decode(charset, errors="replace")
        except LookupError:
            text = body[:MAX_HTML_BYTES].decode("utf-8", errors="replace")
        metadata = parse_metadata(text)
    return {"url": final_url, **metadata}


# -- images ------------------------------------------------------------------


def import_image(db: Session, user: User, page_id: int, url: str) -> Attachment:
    """Download an image from the web and store it as an attachment of a page."""
    limit = get_settings().max_upload_bytes
    final_url, _headers, body = fetch(url, accept="image/*", limit=limit)
    if len(body) > limit:
        raise PayloadTooLarge("This image is larger than the upload limit")
    extension = files.image_extension(body[:64])
    if extension is None:
        raise ValidationFailed("This address does not point to a PNG, JPG, GIF or WebP image")
    name = posixpath.basename(unquote(urlsplit(final_url).path)) or "image"
    stem = name.rsplit(".", 1)[0] if "." in name else name
    return files.store_upload(db, user, page_id, io.BytesIO(body), f"{stem or 'image'}.{extension}")

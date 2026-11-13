# Security notes

What MindDock does to protect your notes, and what remains your job.

## Authentication and sessions

- Passwords are hashed with **Argon2id** (argon2-cffi defaults) and rehashed
  transparently when parameters change. Minimum length: 8 characters.
- Sessions are **server-side**. The browser holds a random 256-bit token in an
  `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS); the database stores
  only its SHA-256 digest, so a leaked database does not yield usable cookies.
- Sessions expire after inactivity (default 7 days) and at an absolute age
  (default 30 days). Signing out, changing a password, an administrator's
  password reset and deactivating an account all revoke sessions immediately.
- Failed sign-ins are rate limited per account name and per client address
  (default: 5 per 15 minutes) and recorded in the activity log. Responses do
  not reveal whether an account exists.
- Public registration is off by default. Invitation tokens are single use,
  expire after 7 days and are stored hashed.

## Request forgery

- Every state-changing API request must carry the session's CSRF token in the
  `X-CSRF-Token` header (constant-time comparison).
- Requests with an `Origin` header that does not match the `Host` are rejected
  before they reach any handler.
- Cookies are `SameSite=Lax`; request bodies are JSON with unknown fields
  rejected.

## Authorization

- One resolver (`app/services/permissions.py`) decides access for pages,
  versions, attachments, search results, sharing and the recycle bin.
- The server never accepts roles, owners or file paths from the client.
- Pages a user may not see are reported as "not found", not "forbidden".
- Administrators manage accounts, workspaces and backups, but have no access to
  page content they were not given. Adding themselves to a team workspace is
  possible and audited; personal workspaces cannot be shared at all.

## Stored content (XSS)

- Documents are ProseMirror JSON, never HTML. On every save the server rebuilds
  the document from an allow-list of node types, mark types and typed
  attributes (`app/services/document.py`); anything else is dropped.
- Link targets are limited to `http(s)`, `mailto`, `tel` and same-site paths,
  on both the client and the server. Links open with
  `rel="noopener noreferrer nofollow"`.
- Images can only reference uploaded attachments by id — never external URLs —
  so a page cannot embed trackers.
- The UI builds DOM nodes with `textContent`; it never assigns user content to
  `innerHTML`. Search snippets arrive with marker characters, not markup.
- A strict Content-Security-Policy (`script-src 'self'`, no inline scripts, no
  external origins) backs this up.

## Uploads

- Allow-list of file types; the content must match the claimed type (magic
  bytes for images, PDF and office formats; no NUL bytes in text files). SVG
  and HTML are not accepted.
- Files are stored under generated random names in `data/uploads`, which is
  not a static directory. The original name is display metadata only.
- Downloads go through an endpoint that checks page access, sets
  `X-Content-Type-Options: nosniff`, forces `Content-Disposition: attachment`
  for everything except images and PDFs, and adds a sandboxing CSP.
- Size is limited while streaming (default 25 MB); partial files are removed.

## Other

- Security headers on every response: CSP, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`,
  `Permissions-Policy`, and HSTS over HTTPS.
- SQL goes through SQLAlchemy with bound parameters; full-text queries are
  tokenised and quoted before reaching FTS5.
- Backup and restore validate archive member names against fixed patterns
  (no path traversal) and check database integrity before replacing data.
- Errors are logged server-side; clients get a generic message.
- No third-party requests: no CDN, fonts, analytics or telemetry.

## Your responsibilities

- **Use HTTPS** and set `MINDDOCK_COOKIE_SECURE=always`.
- Keep the server and its `data/` directory private (`chmod 700 data`). The
  database and uploads are not encrypted at rest — use full-disk encryption if
  the machine could be stolen. Anyone with shell access to the server can read
  everything.
- Protect backup archives like the data itself.
- Keep dependencies current: `uv lock --upgrade` and `npm update`, then run
  the tests.
- Not implemented: two-factor authentication, single sign-on, password reset
  by email (administrators reset passwords).

## Reporting a problem

Please open a private security advisory on the repository rather than a public
issue.

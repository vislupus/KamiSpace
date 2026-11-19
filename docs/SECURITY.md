# Security notes

What KamiSpace does to protect your notes, and what remains your job.

## Authentication and sessions

- An account is a username and a password; no email address is stored.
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

### Tasks given to someone

Assigning a to-do item is a deliberate act by somebody who can edit the page,
and it shares exactly that item: the assignee sees its text in "My tasks" and
may tick it, even when the page is not shared with them. They do not get the
page's title, its content or the other tasks, and opening the page still
answers "not found". Ticking is the only change they can make; it is checked
against the task's assignee on the server.

### Databases

A database and its rows are pages, so every rule above applies unchanged: a
viewer cannot add rows or change values, a row can be shared on its own, and
somebody without access gets "not found" for the database and for each row.
The schema, the view settings and all property values go through an
allow-list on the server (`app/services/databases.py`); people in a *Person*
property must be existing accounts, links in a *URL* property must be safe
addresses.

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

## Embeds and requests to other sites

- An embed block shows another site in an `<iframe>` with the `sandbox`
  attribute and `referrerpolicy="no-referrer"`. The framed site runs in its own
  origin and cannot read or script KamiSpace. Only `https` addresses are
  accepted (CSP `frame-src 'self' https:`). Opening a page with an embed makes
  the reader's browser contact that site — that is what embedding means.
- Images, video and audio can only come from uploaded attachments, never from
  another site.
- For web bookmarks and for pictures in pasted web content the *server* fetches
  an address on the user's request. That fetcher (`app/services/remote.py`)
  only speaks http(s), refuses every host that resolves to a loopback,
  private, link-local or otherwise non-public address, connects to exactly the
  address it checked (no DNS rebinding), follows at most four redirects with
  the same checks, and limits time and size. Turn it off entirely with
  `KAMISPACE_ALLOW_REMOTE_FETCH=false`.
- Equations are rendered by KaTeX with `trust` off, so TeX cannot produce
  links, images or HTML.

## Uploads

- Allow-list of file types; the content must match the claimed type (magic
  bytes for images, PDF, video, audio and office formats; no NUL bytes in text
  files). SVG and HTML are not accepted.
- Files are stored under generated random names in `data/uploads`, which is
  not a static directory. The original name is display metadata only.
- Downloads go through an endpoint that checks page access, sets
  `X-Content-Type-Options: nosniff`, forces `Content-Disposition: attachment`
  for everything except images, PDFs, video and audio, and adds a sandboxing CSP.
- Size is limited while streaming (default 100 MB); partial files are removed.

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

- **Use HTTPS** and set `KAMISPACE_COOKIE_SECURE=always`.
- Keep the server and its `data/` directory private (`chmod 700 data`). The
  database and uploads are not encrypted at rest — use full-disk encryption if
  the machine could be stolen. Anyone with shell access to the server can read
  everything.
- Protect backup archives like the data itself.
- Keep dependencies current: `uv lock --upgrade` and `npm update`, then run
  the tests.
- Not implemented: two-factor authentication and single sign-on. There is no
  email at all: administrators reset forgotten passwords.

## Reporting a problem

Please open a private security advisory on the repository rather than a public
issue.

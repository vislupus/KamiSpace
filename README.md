# KamiSpace

**Your data. Your server. Your workspace.**

KamiSpace is a self-hosted knowledge and documentation workspace: a block editor
in the spirit of Notion, the Markdown typing speed of Obsidian, and nothing that
leaves your own machine. One Python process, one SQLite file, one directory.

- Block-based editor with Markdown shortcuts, slash commands and drag-and-drop
- Nested pages, favourites, recents, full-text search, recycle bin
- Accounts, team workspaces, per-page sharing with inherited permissions
- Version history with restore, autosave with conflict detection
- Images, PDFs and file attachments stored on your disk, served only to people
  with access
- Backups and restore from the command line; light and dark themes
- No CDN, no external fonts, no telemetry, no cloud service of any kind

---

## Contents

1. [Quick start](#quick-start)
2. [Development on Windows](#development-on-windows)
3. [Production on Ubuntu](#production-on-ubuntu)
4. [Configuration](#configuration)
5. [Command line](#command-line)
6. [Backup and restore](#backup-and-restore)
7. [Using the editor](#using-the-editor)
8. [Users, roles and sharing](#users-roles-and-sharing)
9. [Tests](#tests)
10. [Project layout](#project-layout)
11. [Feature status](#feature-status)

Further reading: [architecture and design decisions](docs/ARCHITECTURE.md) ·
[Ubuntu deployment guide](docs/DEPLOYMENT.md) · [security notes](docs/SECURITY.md)

---

## Quick start

Requirements: [uv](https://docs.astral.sh/uv/). uv installs the right Python
(3.12.11, pinned in `.python-version`) by itself. Node.js is **not** needed to
run KamiSpace — the built frontend is part of the repository.

```bash
uv sync
```

```bash
uv run python -m app create-admin
```

```bash
uv run python -m app run
```

Open <http://127.0.0.1:8000> and sign in with the account you just created.

`run` applies database migrations automatically. Everything KamiSpace stores —
database, uploads, backups, logs, temporary files — lives in `data/` inside the
project directory.

## Development on Windows

Works in PowerShell or `cmd`, no Docker and no WSL required.

1. Install uv (once):

   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```

2. In the project directory, install dependencies. uv downloads Python 3.12.11
   if it is missing and creates `.venv\`:

   ```powershell
   uv sync
   ```

3. Create the first administrator (you are prompted for a password):

   ```powershell
   uv run python -m app create-admin --username admin
   ```

4. Start the server with auto-reload:

   ```powershell
   uv run python -m app run --reload
   ```

### Working on the frontend

Only needed when you change files in `frontend/src`. Requires Node.js 20.19+
or 22.12+.

```powershell
cd frontend
npm install
npm run dev
```

`npm run dev` rebuilds `static/dist` on every change; the Python server serves
the result (there is no separate dev server). Run `npm run build` for the
minified bundle before committing.

### Database migrations

```powershell
uv run python -m app migrate
```

```powershell
uv run alembic revision --autogenerate -m "describe the change"
```

The test suite fails when a model changes without a matching migration.

## Production on Ubuntu

The short version — the complete walkthrough with a dedicated user, firewall,
HTTPS and scheduled backups is in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

```bash
git clone https://github.com/vislupus/KamiSpace.git /opt/kamispace && cd /opt/kamispace
```

```bash
uv sync --frozen --no-dev
```

```bash
cp .env.example .env
```

```bash
uv run --no-dev python -m app create-admin
```

```bash
uv run --no-dev python -m app run
```

Then put a reverse proxy with HTTPS in front of it and run it as a service:

- `deploy/kamispace.service` — systemd unit
- `deploy/nginx.conf.example` — nginx reverse proxy (HTTPS via certbot)
- `deploy/Caddyfile.example` — Caddy alternative (automatic HTTPS)

Run a **single** server process. SQLite in WAL mode handles a team comfortably,
and one process keeps things simple; requests are served from a thread pool.

## Configuration

Settings are environment variables prefixed with `KAMISPACE_`, or lines in a
`.env` file in the project root. See [`.env.example`](.env.example) for the
full, commented list. The most relevant ones:

| Variable | Default | Purpose |
|---|---|---|
| `KAMISPACE_ENV` | `development` | `production` hides API docs and caches the asset manifest |
| `KAMISPACE_HOST` / `KAMISPACE_PORT` | `127.0.0.1` / `8000` | Listen address |
| `KAMISPACE_DATA_DIR` | `data` | Where all persistent data lives (relative to the project) |
| `KAMISPACE_ALLOWED_HOSTS` | *(any)* | Comma separated host names to accept |
| `KAMISPACE_COOKIE_SECURE` | `auto` | `always` behind HTTPS |
| `KAMISPACE_SESSION_IDLE_MINUTES` | `10080` | Sign out after inactivity (7 days) |
| `KAMISPACE_SESSION_MAX_DAYS` | `30` | Absolute session lifetime |
| `KAMISPACE_MAX_UPLOAD_MB` | `100` | Upload size limit (videos need room) |
| `KAMISPACE_ALLOW_REMOTE_FETCH` | `true` | Let the server fetch link previews and pasted web images |
| `KAMISPACE_VERSION_INTERVAL_MINUTES` | `10` | How autosaves are grouped into versions |

There are no secrets to configure: sessions are random tokens stored (hashed)
in the database, not signed cookies.

### Where data lives

```
data/
├── database.sqlite3      SQLite database (plus -wal / -shm while running)
├── uploads/              attachment files under generated names
├── backups/              backup archives, and data replaced by a restore
├── logs/kamispace.log     application log (rotated)
└── temp/                 upload and backup scratch space
```

`data/` is ignored by git. uv's package cache is kept in `.uv-cache/` and the
virtual environment in `.venv/`, both inside the project as well.

## Command line

```
uv run python -m app run [--host H] [--port P] [--reload]   start the server
uv run python -m app migrate                                apply migrations
uv run python -m app create-admin [--username U]            create an administrator
uv run python -m app reset-password <username>              set a new password
uv run python -m app backup                                 write a backup archive
uv run python -m app restore <archive> [--yes]              restore from a backup
```

## Backup and restore

A backup is one `.zip` with a consistent snapshot of the database — taken with
SQLite's online backup API, so it is safe while the server is running — plus
every uploaded file and a manifest.

Create one from **Settings → Backups** (administrators; the archive can be
downloaded there for off-server storage) or from the shell:

```bash
uv run python -m app backup
```

Restoring replaces all current data, so it is done with the server stopped:

```bash
sudo systemctl stop kamispace
```

```bash
uv run python -m app restore data/backups/kamispace-backup-20260101-030000.zip
```

```bash
sudo systemctl start kamispace
```

The data being replaced is not deleted: it is moved to
`data/backups/pre-restore-<timestamp>/`. After restoring, pending migrations
are applied, so a backup from an older version can be restored into a newer
one. See the deployment guide for a nightly backup timer.

## Using the editor

There is no permanent toolbar. Everything appears where you need it.

**Markdown as you type** (at the start of a block):

| Type | Get |
|---|---|
| `#`, `##`, `###` + Space | Heading 1, 2, 3 |
| `-` + Space | Bulleted list |
| `1.` + Space | Numbered list |
| `[]` + Space | Checklist |
| `>` + Space | Quote |
| `---` + Space | Divider |
| ```` ``` ```` + Space (or ```` ```python ````) | Code block |
| `>>` + Space | Toggle list |
| `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` | Inline formatting |
| `==text==` | Yellow highlight |
| `$$x^2$$` | Inline equation |
| `@` or `[[` | Link to another page |

Backspace right after a conversion — or Ctrl+Z — turns it back.

**Slash commands** — type `/` and keep typing to filter:
`/text` `/h1` `/h2` `/h3` `/bullet` `/numbered` `/todo` `/toggle`
`/toggleh1` `/toggleh2` `/toggleh3` `/quote` `/code` `/callout` `/divider`
`/table` `/columns2` `/columns3` `/columns4` `/page` `/linkpage` `/image`
`/video` `/audio` `/file` `/embed` `/bookmark` `/equation` `/inlineequation`
`/link`

**Blocks** — hover a block to reveal its controls in the left margin:
`+` adds a block below (Alt+click: above); the grip ⠿ drags the block to a
new position, or opens a menu on click: *Turn into*, *Duplicate*, *Move up /
down*, *Delete* (and *Add a column* / *Remove columns* on a column layout).

**Selecting text** shows a small toolbar: block type, bold, italic, underline,
strikethrough, inline code, text and background colour, link, inline equation.

**Toggles** hide the blocks beneath a summary line. A toggle heading is a
heading (H1–H3) that folds its section. Click the triangle or press
Ctrl+Enter; the state is saved with the page.

**Columns** put blocks side by side (2–5 columns); on a phone they stack.

**Equations** are written in TeX and typeset with KaTeX: a block equation
(`/equation`) or inline in a sentence (`$$…$$`, Ctrl+Shift+E, or the toolbar).
Click an equation to edit it.

**Pages inside pages** — a new sub-page appears as a link in its parent.
`/page` creates one right where the caret is; `@` or `[[` mentions any other
page, and pasting a page's address does the same. Links always show the
current title and icon of the page they point to.

**Files and media** — drag files into the page, paste a screenshot, or use
`/image`, `/video`, `/audio` and `/file`. Images appear inline, video and
audio get a player, PDFs can be previewed in place, other files become
download cards. `/embed` shows a web page, YouTube or Vimeo video in a
sandboxed frame; `/bookmark` makes a link card with the page's title.

**Pasting from Word** (and other rich sources) keeps the formatting *and* the
pictures: each picture is uploaded and placed where it was in the text.

**Tasks** — a to-do item (`[]` or `/todo`) has two small buttons on its right:
a person (assign it to someone) and a calendar (due date). Everything assigned
to you, from every page you can open, is listed under **My tasks** in the
sidebar, where it can be ticked off directly. The page must be shared with the
person for them to see the task.

**Page menu (⋯)** — *Copy link*, *Copy page contents* (as Markdown and rich
text), *Appearance & layout* (default / serif / mono font, small text, full
width), *Lock page* (nobody can edit until it is unlocked), *Export as
Markdown*, *Import Markdown as sub-page*, version history.

**Markdown files** — *Export as Markdown* downloads the page as a `.md` file;
*Import Markdown* (Home, Library, page menu) turns a `.md` file into a page.
Standard Markdown is used wherever it exists; KamiSpace-only blocks (callouts,
columns, toggles, embeds, attachments) are written as `:::name` blocks so an
exported page imports again with its structure. Pictures stay on the server
and are referenced by address; text and background colours are not kept.

**Covers** — hover a cover and choose *Reposition* to drag the picture up or
down (or use the arrow keys), then *Save position*.

| Shortcut | Action |
|---|---|
| Ctrl+K | Search pages — or, with text selected, add/edit a link |
| Ctrl+B / I / U | Bold / italic / underline |
| Ctrl+Shift+S, Ctrl+E | Strikethrough, inline code |
| Ctrl+Shift+H | Highlight |
| Ctrl+Shift+E | Inline equation |
| Ctrl+Alt+7 | Toggle list |
| Ctrl+Enter | Open / close the toggle |
| Ctrl+Alt+1…3 | Heading 1…3 |
| Alt+Shift+↑ / ↓ | Move the block (or list item) up / down |
| Ctrl+D | Duplicate the block |
| Tab / Shift+Tab | Indent / outdent a list item |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Alt+N | New page |
| Ctrl+\\ | Show / hide the sidebar |
| Ctrl+Shift+F | Focus mode (Esc to leave) |
| Ctrl+/ | List of shortcuts |

On macOS use ⌘ instead of Ctrl.

**Saving** is automatic, about a second after you stop typing. The indicator in
the top bar shows *Unsaved changes → Saving… → Saved*, or *Offline — will
retry* when the server cannot be reached. If the same page was changed
somewhere else in the meantime, nothing is overwritten: you choose which
version to keep, and the other one stays in the version history.

## Users, roles and sharing

- **An account is a username and a password** — no email address, nothing is
  ever sent. You can change your username under Settings → My account.
- **Registration is closed by default.** An administrator creates accounts or
  hands out one-time invitation links (Settings → Users). Open registration can
  be switched on there if you want it.
- **Private** — every user has a private section that nobody else can see.
- **Team workspaces** — created by an administrator; every member sees its
  pages. Members are *owners* (manage members and all pages), *editors*
  (create and edit) or *viewers* (read only).
- **Sharing a page** — the page owner can give specific people *view* or
  *edit* access. Access is inherited by all pages nested inside.
- **Administrators manage the application, not your notes.** They manage users,
  settings, workspaces and backups, but have no access to private pages or to
  workspaces they are not a member of. Adding themselves to a team workspace
  is possible and recorded in the activity log. Note that whoever controls the
  server can always read the database file itself.

All of this is enforced by the server on every request — including file
downloads, search results and version history.

## Tests

Backend (pytest, 190+ tests: authentication, sessions, CSRF, permissions,
pages, versions, conflicts, uploads, search, backups, migrations):

```bash
uv run pytest
```

Browser tests (Playwright, 125+ tests: Markdown shortcuts, slash commands,
block drag-and-drop, toolbar, links, uploads, autosave, conflicts, responsive
layout at laptop sizes, long-document performance):

```bash
cd frontend && npm install && npx playwright install chromium
```

```bash
npm run build && npm run test:e2e
```

The browser tests start their own throwaway server with its own data
directory (`data/temp/e2e`); they never touch your data.

Lint and format the Python code:

```bash
uv run ruff check . && uv run ruff format --check .
```

## Project layout

```
app/                    FastAPI application
├── main.py             app factory, security headers, error handling
├── config.py           settings (environment variables)
├── db.py               engine, SQLite pragmas, sessions
├── models.py           SQLAlchemy models
├── schemas.py          request bodies (Pydantic)
├── deps.py             request dependencies: session, current user, CSRF
├── security.py         Argon2 hashing, tokens
├── cli.py              command line (run, migrate, create-admin, backup…)
├── web.py              HTML entry points
├── api/                HTTP routes, one module per area
├── services/           business logic: auth, permissions, pages, versions,
│                       files, search, sharing, workspaces, backups, audit
└── templates/          Jinja2 shells for the app and sign-in pages
frontend/               frontend sources (vanilla JS modules, CSS) and tests
├── src/editor/         the block editor (Tiptap/ProseMirror extensions)
├── src/app/            sidebar, page view, search, sharing, settings…
├── src/lib/            small UI primitives: popover, menu, modal, toast
├── src/styles/         design tokens and stylesheets
└── e2e/                Playwright browser tests
static/                 served assets; static/dist is the built bundle
migrations/             Alembic migrations
tests/                  pytest suite
deploy/                 systemd, nginx and Caddy examples
docs/                   architecture, deployment and security notes
data/                   all runtime data (git-ignored)
```

## Feature status

Nothing below is a placeholder: "complete" means implemented and covered by
automated tests.

### Complete

| Area | Details |
|---|---|
| Editor blocks | Paragraph, headings 1–3, bulleted / numbered / to-do lists (nested), toggle list and toggle headings, quote, code block with syntax highlighting (22 languages), divider, callout (5 styles), table, columns (2–5), image, video, audio, file attachment, embed (web page, YouTube, Vimeo), web bookmark, block and inline equations (KaTeX), page link, page mention |
| Text formatting | Bold, italic, underline, strikethrough, inline code, links, 9 text colours and 9 background colours (both themes) |
| Editor input | Markdown block and inline shortcuts, slash menu (keyboard driven, filtered, no network), `@` / `[[` page picker, undo/redo across conversions, paste of rich and plain text, paste from Word with pictures |
| Block handling | `+` button, drag handle with drop indicator, block menu (turn into, duplicate, move, delete), keyboard move/duplicate, floating selection toolbar, link editor |
| Files | Drag-and-drop and paste upload with placeholders, inline images (lazy loaded), video and audio players with seeking, PDF preview, download cards; type allow-list with content sniffing, size limit, generated storage names, access-controlled downloads |
| Pages | Unlimited nesting, sub-pages linked in their parent, icon, cover image with repositioning, appearance (font, small text, full width), lock, create / rename / move (dialog and sidebar drag-and-drop) / duplicate / delete, recycle bin, favourites, recents, breadcrumbs, library of all pages |
| Markdown | Export a page as `.md`, import `.md` files as pages, copy page contents |
| Tasks | Assign to-do items to people, due dates, "My tasks" across all pages with a counter, tick off from the list |
| Search | SQLite FTS5 over titles, content and page hierarchy; prefix matching, ranked, highlighted snippets, permission filtered; Ctrl+K palette with keyboard navigation |
| Accounts | Username and password only, changeable username, Argon2id hashes, server-side sessions in HttpOnly cookies, idle and absolute expiry, CSRF protection, sign-in rate limiting, change password, list and revoke own sessions |
| Administration | Create and rename users, invitation links, optional open registration, deactivate, reset password, admin role, team workspaces and members, activity log |
| Permissions | Private pages, team workspace roles, per-page view/edit sharing with inheritance, enforced on every endpoint |
| Saving | Debounced autosave with state indicator, offline retry with backoff, unsaved-changes warning, optimistic concurrency (revision check), conflict resolution without data loss, idle tabs pick up newer content |
| Versions | Automatic snapshots grouped by author and time, named versions, read-only preview, restore as a new version |
| Backups | Online SQLite snapshot + uploads in one archive, create / list / download / delete in settings, CLI backup and restore |
| UI | Light and dark themes (persisted), collapsible sidebar, focus mode, keyboard shortcuts, toasts, confirmation dialogs, empty and loading states, laptop-first responsive layout, overlay sidebar on small screens |

### Partial — works, with known limits

| Area | Limit |
|---|---|
| Block handles | Handles address top-level blocks. Blocks inside columns, toggles, callouts and lists are moved with Alt+Shift+↑/↓ (and cut/paste), not by dragging |
| Paste from Word | Pictures are recovered from the clipboard's RTF data, which is how Word provides them; tested with clipboard data in Word's format, not with every Word version. Pictures that cannot be recovered are left out with a notice |
| Embeds | Many sites refuse to be shown inside another page; for those the frame stays empty and the link below it opens the site. Only `https` pages can be embedded |
| Web bookmarks | Title and description are fetched by the server, which therefore needs outbound internet access (and no proxy in between). Without it the card shows the address |
| Markdown export | Pictures and files are referenced, not bundled, so a `.md` file imports with its pictures only on the same KamiSpace instance. Text colours, assignees and due dates are not written to Markdown |
| Tasks | The assignee is not notified (nothing is emailed); they see the task in "My tasks" |
| Images | Shown at their natural size up to the text width; there is no resize or alignment control yet |
| Touch devices | Reading and typing work and the layout adapts, but block handles and drag-and-drop need a pointer |
| Offline | Unsaved edits are retried while the tab stays open; they are not persisted across a browser crash |
| Browsers | Automated tests run in Chromium. Firefox and Safari use the same standards-based code but are not covered by the automated suite |
| Restore | Command line only (by design: it replaces live data) |

### Planned — not implemented

Backlinks ("pages that link here"), graph view, templates, comments, synced
blocks, databases / board views, PDF export, side-by-side version comparison
(full snapshots are already stored for it), real-time collaborative editing,
two-factor authentication.

### Upgrading from MindDock

KamiSpace is the new name of MindDock. Pull the new code and start it as
usual: the database is migrated in place (`python -m app run` does it
automatically, or run `python -m app migrate`).

- Email addresses and display names are removed from accounts; people sign in
  with their username as before.
- Existing sub-pages get a link in their parent page.
- Settings written with the old `MINDDOCK_` prefix (environment or `.env`)
  keep working; new installations use `KAMISPACE_`.
- Everyone has to sign in once more (the session cookie was renamed), and the
  theme choice is carried over.
- Old backup archives (`minddock-backup-…zip`) can still be listed, downloaded
  and restored.

## License

MIT — see [LICENSE](LICENSE).

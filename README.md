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

One server process handles a small team comfortably (requests are served from
a thread pool). When many people work at the same time, start several workers
— `KAMISPACE_WORKERS=4` in `.env`, or `python -m app run --workers 4`; they
share the SQLite database (WAL mode) safely. See *How many worker processes?*
in `docs/DEPLOYMENT.md`.

## Configuration

Settings are environment variables prefixed with `KAMISPACE_`, or lines in a
`.env` file in the project root. See [`.env.example`](.env.example) for the
full, commented list. The most relevant ones:

| Variable | Default | Purpose |
|---|---|---|
| `KAMISPACE_ENV` | `development` | `production` hides API docs and caches the asset manifest |
| `KAMISPACE_HOST` / `KAMISPACE_PORT` | `127.0.0.1` / `8000` | Listen address |
| `KAMISPACE_WORKERS` | `1` | Worker processes of `python -m app run`; 2–4 when many people work at once |
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
uv run python -m app migrate [--assume REVISION]            apply migrations (and check the result)
uv run python -m app status                                 which code and data are in use, and do they fit
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
`/link` `/emoji` `/database` `/database-page` `/board` `/board-page`
`/linked-database`

**Emoji** — in the text, type `:` and a few letters of a name (`:rocket`,
`:сърце`) and pick from the list at the caret; a finished shortcode turns into
its emoji by itself (`:fire:` → 🔥); `/emoji` opens the whole picker. The
picker (also used for page icons) has the complete Unicode set in nine groups,
remembers the ones you used last, and searches names and keywords in English
and Bulgarian. The emoji data is part of the application — nothing is fetched
from the internet — and emoji your computer's fonts cannot draw are left out.

**Blocks** — every line is a block, wherever it lives: on the page, inside a
toggle, a column, a callout, a quote, or as an item of a list. Hover a block
to reveal its controls to the left of it: `+` adds a block below (Alt+click:
above); the grip ⠿ drags the block to a new position — also into or out of a
toggle or a column — or opens a menu on click: *Turn into*, *Duplicate*,
*Move up / down*, *Delete* (and *Add a column* / *Remove columns* inside a
column layout). "Turn into" and the slash menu change the block in place, so
a line inside a toggle stays inside it.

**Selecting text** shows a small toolbar: block type, bold, italic, underline,
strikethrough, inline code, text and background colour, link, inline equation.

**Toggles** hide the blocks beneath a summary line. A toggle heading is a
heading (H1–H3) that folds its section. Click the triangle or press
Ctrl+Enter; the state is saved with the page. Enter on the summary starts
the first line inside; Enter on an empty last line leaves the toggle. Tab
moves the current block into the toggle above it, Shift+Tab takes it out
again, and blocks can be dragged in (drop on the summary, slightly indented,
or between the lines inside) and out.

**Columns** put blocks side by side (2–5 columns); on a phone they stack.
Pointing at a column layout outlines every column, so it is clear where each
one begins and ends.

**Spacing** follows Notion: paragraphs stand apart, list items and toggles sit
close together, headings get air above them — the same on the page, inside
toggles and in columns.

**Tables** (`/table`) behave like Notion's simple tables. Nothing is shown
until the pointer is over the table; then a bar on the right adds a column and
a bar below adds a row — click for one, drag for several (dragging back removes
empty ones). The small handle on the top edge of a column, or the left edge of
a row, opens a menu (insert, clear contents, delete, header row / column) and
can be dragged to move the column or row. A right click in a cell offers the
same actions in one menu. Drag the line between two columns to resize them. The cell you are writing in has a blue frame; Tab goes to the
next cell, Enter to the cell below, Shift+Enter breaks the line.

**Calendar** (sidebar) shows everything that has a date: rows of every
database you can open (their *Date* property, with or without a time) and
tasks due for you — next to the official holidays of Bulgaria. Nothing is
fetched from the internet.

- Views: **Year** (all twelve months at a glance), **Month**, **Week** and
  **Day** (time grid). The **Holidays** button lists the official holidays of
  the year shown, when you want to see them.
- The panel on the left has a small month to jump around in and the list of
  *calendars*: every database with a Date property (each with its own colour),
  your due tasks, and the holidays — tick what you want to see. Weeks start on
  Monday and carry their ISO week number; dates read DD.MM.YYYY, times use the
  24-hour clock, and "today" and "now" are those of Europe/Sofia whatever the
  time zone of the computer.
- Holidays are calculated, not downloaded: the fixed official holidays, the
  Orthodox Easter days (Good Friday to Easter Monday), and the working day off
  that follows a holiday on a Saturday or Sunday (Labour Code, art. 154).
  1 November is marked as a day without classes. The days the clocks change
  are marked in the week and day views.
- *New event* (or a click on a day) adds a row to one of your databases. In
  the week and day views, press and drag over the hours to create an event
  with those times, drag an event to another time or day (steps of 15
  minutes), and drag its lower edge to change when it ends. In the month view
  an event of several days is one bar; drag it to another day to move it.
- A click on an event opens its page beside the calendar (side peek); a right
  click offers to open it as a full page or in a new tab, or to delete it.
  Without a database yet, the calendar offers to create an *Events* one.
- A *Date* property can include a time (*Include time* in its editor) and an
  end. Every date in the app is chosen from the same month grid.
- **Colours**: every calendar (database) has a colour — hover it in the list
  on the left and press the palette to choose one. A single row can have a
  colour of its own, which wins: right-click the event (or the row in its
  table) → *Color*. *Same as the calendar* goes back to the database's colour.

**Databases** — `/database` puts a table into the page, `/board` a Kanban
board. Both are views of the same thing: a set of rows, where every row is a
page of its own with *properties* (status, person, date, number, select,
multi-select, checkbox, URL, text, formula).

- *Inline or full page*, as in Notion: `/database` and `/board` show the
  database inside the page you are writing; `/database-page` and
  `/board-page` make it a page of its own that is only linked here (and open
  it). `/linked-database` shows a database that already exists somewhere else
  — both places show the same rows. A database is linked and mentioned like
  any page (`@`, `[[`, *Link to page*) and carries a database icon.
- *Formulas*: `+` → **Calculated** offers ready-made columns that need no
  writing — *Number of days* (from a date to a date, both counted), *Working
  days* (without weekends and Bulgarian public holidays), *Days left* (from
  today), *Calculation* (two numbers added, subtracted, multiplied, divided,
  or one as a percentage of the other) — and *Formula* to write your own:
  `prop("Price") * prop("Quantity")`,
  `if(daysUntil(prop("Deadline")) < 0, "Late", "On time")`. The editor lists
  the properties and functions (dates, numbers, logic, text), inserts them
  with a click, explains mistakes while you type and shows the result for the
  first row. Formulas are calculated as you enter data, can be sorted,
  filtered and summed like any column, and follow a property when it is
  renamed. Empty inputs give an empty result, not an error.
- *Entering data*: **Tab** stores the cell and opens the next one, Shift+Tab
  the one before, Enter stores and closes, Esc cancels. Only the row you
  changed is redrawn, so a table of thousands of rows stays quick.
- *Colour of a row*: right-click a row → *Color*. It marks the row in the
  table and on the board and is the colour of its entry in the calendar. The
  colour of the whole database (for rows without their own) is under the
  view's options → *Color in the calendar*.

- *Table*: click a cell to edit it; **New** or *+ New page* adds a row and
  starts typing its name. Click a column header — or right-click it — for the
  property menu: name, *Edit property* (the options of a select or status,
  the format of a number), *Change type*, *Filter*, *Sort*, *Group*,
  *Calculate*, *Hide*, *Wrap content*, *Insert left / right*, *Duplicate
  property*, *Delete property*. Drag a header's right edge to resize, the
  header itself to reorder; `+` adds a property.
- *Rows*: the *Open* button opens a row **beside the table** (side peek), with
  its properties and its text; ⤢ makes it a full page, » or Esc closes it. A
  right click on a row (or a card) offers *Open in side peek / as a full page
  / in a new tab*, *Copy link*, *Duplicate* and *Delete*.
- *Options* of a select, multi-select or status are edited as in Notion: each
  has a name, a colour (picked from swatches) and can be reordered by
  dragging. A status also has a stage — *To-do*, *In progress* or *Complete*
  — and its picker lists the options stage by stage.
- *Board*: one column per status (or person, or any select property — *Group
  by* in the view menu). Drag cards between columns and up and down; *+ New
  page* adds a card to that column; *Add a group* adds a status.
- Views are the tabs above the database: add as many as you like, each with
  its own filters, sorting, visible properties and layout. Click the active
  tab for its options.
- A row opened as a page shows its properties under the title and has normal
  page content below. Rows inherit sharing from the database, can be shared on
  their own, and go to the recycle bin when deleted (with *Undo*).
- The database itself is a sub-page: the ⤢ button (or the sidebar) opens it as
  a full page, and it can be moved like any page.

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

**Pictures** are centred. Hover one for its controls: drag the handles on its
sides to resize it, and use the small toolbar for a caption, alignment (left,
centre, right), the full-size view, download, replace and delete.

**Links** — hover a link to see where it goes, with buttons to copy, edit or
remove it; click it to open it. Ctrl+K on selected text adds a link: paste an
address, or type a few letters to pick one of your pages. Pasting a web
address into an empty spot makes a link and offers to turn it into a bookmark
card or an embed instead ("Paste as"); pasting it over selected text links
that text.

**Pasting from Word** (and other rich sources) keeps the formatting *and* the
pictures: each picture is uploaded and placed where it was in the text.

**Tasks** — a to-do item (`[]` or `/todo`) has two small buttons on its right:
a person (assign it to someone) and a calendar (due date). Faster ways to hand
out work:

- type `@name` inside a to-do item to assign it;
- press Enter: the next item goes to the same person with the same due date;
- select several items and use the person button of one of them — all of them
  are assigned;
- or choose *Assign all in this list* from that button.

Everything assigned to you is listed under **My tasks** in the sidebar and can
be ticked off there. The person a task is given to can always tick it: in the
page itself when they can only read it, and from *My tasks* when the page is
not shared with them at all (they then see the text of that one task, nothing
else of the page). For work that needs more than a checklist — a status, a
board, several people — use a database (above) with a *Person* property.

**Page menu (⋯)** — *Copy link*, *Copy page contents* (as Markdown and rich
text), *Appearance & layout* (default / serif / mono font, **text size** from
12 to 32 px with a live slider — headings and the title scale with it — and
full width), *Lock page* (nobody can edit until it is unlocked), *Export as
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
| Ctrl+K or Ctrl+P | Search pages — Ctrl+K with text selected adds / edits a link |
| Ctrl+click, middle mouse button | Open a page in a new tab (sidebar, links, search results, database rows and cards, calendar) |
| Ctrl+[ / Ctrl+] | Back / forward |
| Ctrl+Shift+U | Go to the parent page |
| Alt+N | New page |
| Ctrl+\\ | Show / hide the sidebar |
| Ctrl+Shift+L | Light / dark |
| Ctrl+Shift+F | Focus mode (Esc to leave) |
| Ctrl+/ | List of shortcuts |
| Esc | Select the block the caret is in |
| ↑ / ↓ (block selected) | Select the block above / below |
| Enter (block selected) | Write in it again |
| Delete or Backspace (block selected) | Delete the block — also while its ⠿ menu is open |
| Ctrl+D | Duplicate the block |
| Ctrl+Shift+↑ / ↓ (or Alt+Shift+↑ / ↓) | Move the block (or list item) up / down |
| Ctrl+Shift+0 | Turn into text |
| Ctrl+Shift+1 / 2 / 3 | Heading 1 / 2 / 3 |
| Ctrl+Shift+4 / 5 / 6 | To-do list / bulleted list / numbered list |
| Ctrl+Shift+7 / 8 / 9 | Toggle list / code block / new sub-page |
| Ctrl+Enter | Tick a to-do item; open / close the toggle |
| Ctrl+Alt+T | Open / close all toggles |
| Ctrl+B / I / U | Bold / italic / underline |
| Ctrl+Shift+S, Ctrl+E | Strikethrough, inline code |
| Ctrl+Shift+H | Highlight |
| Ctrl+Shift+E | Inline equation |
| Tab / Shift+Tab | Indent / outdent a list item; move a block into / out of the toggle above it; next / previous table cell; in a database: store the cell and edit the next / previous one |
| `:` and a name | Emoji at the caret (`:rocket`, `:сърце`, `:fire:`) |
| Enter / Shift+Enter in a table | Cell below (a new row at the end) / line break inside the cell |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| T · Y / M / W / D · ← / → | Calendar: today · year, month, week, day view · previous / next |

Ctrl+Alt+0…9 does the same as Ctrl+Shift+0…9. Shortcuts follow the physical
keys, so they also work while a Cyrillic keyboard layout is active.

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

Calendar arithmetic (Node's own test runner, no dependencies): holidays,
Orthodox Easter, days in lieu, ISO weeks, leap years, clock changes checked
against the time zone database:

```bash
cd frontend && npm run test:unit
```

Browser tests (Playwright, 185+ tests: right-click and property menus, side peek, calendar, tables, keyboard and new-tab
habits, databases and boards, tasks, Markdown shortcuts, slash commands,
block drag-and-drop (also into toggles), pictures, toolbar, links, uploads,
autosave, conflicts, responsive
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
| Block handling | `+` button, drag handle with drop indicator and block menu (turn into, duplicate, move, delete) for every block at any depth — inside toggles, columns, callouts, quotes and for single list items; keyboard move/duplicate; floating selection toolbar |
| Links | Hover card (address, copy, edit, remove), click to open, Ctrl+K editor with page suggestions, "Paste as" URL / bookmark / embed |
| Files | Drag-and-drop and paste upload with placeholders, images with resize handles, alignment, caption and full-size view (lazy loaded), video and audio players with seeking, PDF preview, download cards; type allow-list with content sniffing, size limit, generated storage names, access-controlled downloads |
| Pages | Unlimited nesting, sub-pages linked in their parent, icon, cover image with repositioning, appearance (font, text size, full width), lock, create / rename / move (dialog and sidebar drag-and-drop) / duplicate / delete, recycle bin, favourites, recents, breadcrumbs, library of all pages |
| Markdown | Export a page as `.md`, import `.md` files as pages, copy page contents |
| Tasks | Assign to-do items to people (`@name`, carried over on Enter, several at once, whole list), due dates, "My tasks" with a counter; the assignee can tick a task from the list or in a read-only page |
| Calendar | Year / month / week / day views; Monday-first ISO weeks with week numbers; DD.MM.YYYY and 24-hour time; Europe/Sofia with clock changes; Bulgarian official holidays, Orthodox Easter and days in lieu, calculated offline; dated database rows (with or without time, ranges) and due tasks; new events, drag to another day |
| Tables | Notion-style simple tables: add bars with drag, row / column handles with menus and drag-to-move, header row / column, column resize, framed current cell, Enter / Tab navigation |
| Keyboard and mouse | Block selection (Esc, arrows, Enter, Delete), Ctrl+Shift+0…9 turn-into, layout-independent shortcuts (work on a Cyrillic layout), middle button / Ctrl+click to open in a new tab |
| Databases | Inline, full-page (linked from the page) or a linked view of an existing database; rows are pages; properties: title, text, number (plain, percent, progress bar), select, multi-select, status, date (with end date), person, checkbox, URL, formula; formulas with ready-made columns (number of days, working days, days left, calculation) and an editor with functions for dates, numbers, logic and text; table view (inline editing with Tab between cells, resize and reorder columns, drag rows, calculations) and board view (group by status / select / person, drag cards); a colour per row and per database, used by the calendar; several views per database with filters, sorts, search and hidden properties; row pages with a property list; permissions, recycle bin and search as for pages |
| Emoji | The complete Unicode set, bundled; search in English and Bulgarian; recently used; `:name` at the caret and `/emoji`; emoji the system fonts cannot draw are left out |
| Many users | Several worker processes on one server (`KAMISPACE_WORKERS`); answers of any size in a fixed number of queries; gzip; writers queue instead of failing |
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
| Block handles | A table is one block; its rows and columns have their own handles. A column layout cannot be dropped inside another column |
| Tables | Cells cannot be merged from the interface. A selected block is one block: Shift+↑/↓ does not extend the selection to several blocks (select text across them with the mouse or Shift+arrows instead) |
| Calendar | Holidays follow the Labour Code as in force since 2017 (earlier years are shown without days in lieu); extra days off declared by the government for a single year, and school holidays, are not included. Times are clock times in Europe/Sofia — the zone is fixed, not a setting. An event that runs past midnight is drawn as a bar in the all-day row, not in the time grid. Recurring events and reminders do not exist |
| Paste from Word | Pictures are recovered from the clipboard's RTF data, which is how Word provides them; tested with clipboard data in Word's format, not with every Word version. Pictures that cannot be recovered are left out with a notice |
| Embeds | Many sites refuse to be shown inside another page; for those the frame stays empty and the link below it opens the site. Only `https` pages can be embedded |
| Web bookmarks | Title and description are fetched by the server, which therefore needs outbound internet access (and no proxy in between). Without it the card shows the address |
| Markdown export | Pictures and files are referenced, not bundled, so a `.md` file imports with its pictures only on the same KamiSpace instance. Text colours, assignees and due dates are not written to Markdown |
| Tasks | The assignee is not notified (nothing is emailed); they see the task in "My tasks". Rows of a database that have a person are not listed there — "My tasks" covers to-do items |
| Databases | The side peek is not part of the address: reloading the browser closes it. No relations between databases or roll-ups; a formula reads the values of its own row only, is calculated in the browser (so it is not in exports and the calendar does not show formula dates), and skin tones of emoji cannot be chosen; views are table and board (no timeline or gallery; the Calendar shows the dated rows of all databases together). Property values are not part of version history and are not searched (row names and page text are). Deleting the database block from a page leaves the database as a sub-page; delete that page to remove it. Two people editing the same database see each other's changes after reloading |
| Images | Width is kept as a percentage of the text column (10–100 %). Pictures cannot be cropped, and text does not wrap around them |
| Links | Clicking a link opens it (as in Notion); to change its text, edit around it or use *Edit link* on the hover card. The hover card needs a pointer |
| Touch devices | Reading and typing work and the layout adapts, but block handles and drag-and-drop need a pointer |
| Offline | Unsaved edits are retried while the tab stays open; they are not persisted across a browser crash |
| Browsers | Automated tests run in Chromium. Firefox and Safari use the same standards-based code but are not covered by the automated suite |
| Restore | Command line only (by design: it replaces live data) |

### Planned — not implemented

Backlinks ("pages that link here"), graph view, templates, comments, synced
blocks, database relations / roll-ups / formulas and timeline views,
recurring events, PDF export, side-by-side version comparison
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

### Upgrading an existing KamiSpace

Pull the new code **where the service runs**, install (`uv sync`), restart;
the database is migrated in place when the application starts. Code and
database go together: old code that keeps running against an upgraded
database answers "Something went wrong on the server". To check,
`curl http://<host>/healthz` shows the running version and whether the
database fits it, and `uv run python -m app status` shows which code and data
directory a command is using — see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#10-updating).

- Pages with "Small text" keep their look: they get a text size of 14 px.
- Tasks assigned to somebody without access to the page now show up in that
  person's "My tasks" (the task only, not the page) — see
  [docs/SECURITY.md](docs/SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).

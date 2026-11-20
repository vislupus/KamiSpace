# Architecture and design decisions

KamiSpace is deliberately small: one FastAPI process, one SQLite database, a
frontend without a framework. This document records the decisions that shape
the code and why they were made.

## Overview

```
Browser ── HTTPS ──▶ reverse proxy ──▶ Uvicorn / FastAPI (one process)
                                         ├── app/api        HTTP routes (thin)
                                         ├── app/services   business rules
                                         ├── app/models     SQLAlchemy 2 models
                                         ├── SQLite (WAL)   data/database.sqlite3
                                         └── files          data/uploads/
```

Routes validate input and call services. Services hold the rules (who may do
what, how versions are created, how files are stored) and never commit; the
route commits explicitly once the whole operation has succeeded, so every
multi-step change is one transaction.

## Backend

### SQLite configuration

Every connection sets `foreign_keys=ON`, `journal_mode=WAL`,
`synchronous=NORMAL` and a 5 second `busy_timeout` (`app/db.py`).

Transactions are started explicitly: requests that change data begin with
`BEGIN IMMEDIATE` and take the write lock up front; GET requests use a
deferred transaction and never block writers. This avoids the classic WAL
failure where a transaction that started reading cannot upgrade to a write.

### Data model

`users`, `sessions`, `invites`, `login_attempts`, `settings`, `workspaces`,
`workspace_members`, `pages`, `page_permissions`, `page_versions`,
`attachments`, `page_attachments`, `tasks`, `favorites`, `page_visits`,
`audit_events`,
plus the FTS5 table `pages_fts`. The schema is created by Alembic
(`migrations/`); a test fails if models and migrations drift apart.

- **Pages** form a tree through `parent_id`. Content is ProseMirror JSON in a
  JSON column, exactly as the editor produces it (after sanitising).
- **The recycle bin** is a flag, not a move: trashed pages keep their place in
  the tree. `trashed_with` remembers which deletion a page belongs to, so
  restoring a parent restores exactly what was deleted with it.
- **Attachments** are metadata rows; bytes live on disk. `page_attachments`
  records every page that references a file now *or in its history*. Rows are
  only removed when a page is permanently deleted, and a file is deleted only
  when its last reference goes — that is what keeps images alive for old
  versions, trashed pages and duplicates.

- **Tasks** are to-do items inside documents. Each item carries an id, an
  optional assignee and due date; the `tasks` table is an index rebuilt from
  the document whenever a page is saved. The document stays the source of
  truth — ticking a task in "My tasks" edits the document (and bumps its
  revision) like any other change.
- **Databases** are pages of kind `database` (`pages.kind`). The schema —
  properties and views — is one JSON document on that page (`db_schema`); the
  rows are its sub-pages, each with its values in `pages.props`. Rows are
  therefore ordinary pages: they inherit access through the page tree, have
  content and versions, are found by search and go to the recycle bin. The
  sidebar leaves rows out (`is_row` in the tree). A `database` block in a
  document only stores the id of the database page it shows.
  `app/services/databases.py` is the allow-list: property types, option
  colours, view settings and every value are checked there; changing a
  property re-checks the values of all rows. Filtering, sorting, grouping and
  calculations happen in the browser (`frontend/src/app/database/`), on the
  rows the server already decided the user may see.
- **Page links** store the id of the page they point to. Titles and icons are
  looked up when a link is shown, so links never go stale and a reader only
  ever sees the titles of pages they may open. Creating a sub-page appends a
  link to its parent; duplicating a tree remaps the links inside the copy.

### Permissions

Effective role = the strongest of the user's workspace role and any explicit
grant on the page or its ancestors (`app/services/permissions.py`). Grants
only ever add access, which keeps inheritance easy to reason about: sharing a
page shares its sub-pages. Guests of a shared page never become owners, and
only owners can move a page out of the place it inherits access from.

### Saving and versions

- `pages.revision` increases with every content save. A save states the
  revision it was based on; a mismatch is answered with `409 Conflict` and
  nothing is written. The client then lets the user choose; a forced overwrite
  always creates a new version, so the losing side remains in the history.
- Invariant: **the newest version equals the current content.** Autosaves by
  the same author within `KAMISPACE_VERSION_INTERVAL_MINUTES` update that
  newest version in place; a different author, a pause, a named snapshot or a
  restore starts a new one. History therefore grows by editing sessions, not
  keystrokes, and restoring simply appends.
- Versions are full snapshots (not deltas): simple, robust, and ready for a
  future compare view.
- Stored documents always end with a paragraph (the editor keeps one after a
  trailing table or image). Normalising this on the server means that opening
  a page never produces a spurious change — and therefore never a spurious
  conflict between two people who merely looked at it.

### Search

One FTS5 row per page: title, ancestor titles ("path") and plain text, with
the `unicode61` tokenizer (case and diacritic insensitive, works for Cyrillic
and other scripts) and prefix indexes. The index is updated in the same
transaction as the page. Results are filtered through the permission resolver;
for pages reached through a share, matches on hidden ancestors' titles are
discarded so search cannot be used to probe them.

### Backups

`sqlite3.Connection.backup()` produces a consistent snapshot while the server
runs; uploads are added to the same zip. Restore is offline and conservative:
validate, integrity-check, move the current data aside, swap, migrate.

## Frontend

### No framework

The interface is vanilla JavaScript modules and CSS, bundled by Vite into
`static/dist`. The editor is the only complex widget, and it is ProseMirror —
which manages its own DOM and gains nothing from a virtual DOM around it.
The rest (sidebar tree, dialogs, menus) is a few hundred lines of direct DOM
code on top of four small primitives: `h()`, popover, menu, modal.

Measured bundle (minified / gzip): application shell 80 kB / 27 kB, CSS
47 kB / 11 kB, editor chunk 724 kB / 226 kB (ProseMirror, Tiptap, tables,
Markdown and 22 highlight.js grammars), KaTeX 259 kB / 78 kB plus its fonts. The editor chunk is loaded on demand
the first time a page is opened; settings, version history and KaTeX (script,
styles and woff2 fonts, only when a page contains an equation) are separate
lazy chunks. Assets are content-hashed and served with immutable caching.

The built bundle is committed so that installing KamiSpace needs only uv.

### Editor

`frontend/src/editor/` configures Tiptap 3 (ProseMirror):

- `blocks.js` is the **block catalogue**. The slash menu, the `+` button and
  the "Turn into" menus are generated from it; a new block type is one entry
  plus its extension.
- Markdown shortcuts are ProseMirror input rules. They only match at the start
  of a text block, are undoable, and do not fire inside code.
- `block-ops.js` defines what a **block** is and every operation on one. A
  block is a node directly inside a container (the page, a toggle body, a
  column, a callout, a quote) or any list item; lists, column layouts and the
  two halves of a toggle are structure. Moving, converting ("turn into"),
  duplicating and deleting all work on a document position, at any depth.
  Moves between lists and containers rewrap the block (a list item dropped
  among paragraphs becomes a one-item list, a paragraph dropped into a list
  splits or joins it), in one transaction.
- `extensions/block-handle.js` positions one shared handle next to the
  innermost block under the pointer (no per-block DOM). Dragging computes the
  target gap from the pointer position — including "into this toggle" — and
  performs the move as one transaction.
- `extensions/image.js` renders pictures with a node view: resize handles
  (width is stored as a percentage), alignment, caption and a hover toolbar.
- `extensions/link-editor.js`: hover card, click-to-open, the Ctrl+K editor
  with page suggestions, and the "Paste as" menu for pasted addresses.
- `extensions/slash.js`, `bubble-toolbar.js`, `link-editor.js`,
  `table-toolbar.js` are contextual UI — nothing is permanently visible.
- `extensions/uploads.js` handles paste, drop and file pickers, with
  placeholder decorations while a file uploads.
- Custom nodes: `callout`, `columns`/`column`, toggles (Tiptap's details
  nodes with a heading level), `image`/`video`/`audio`/`attachment`
  (attachment id only), `embed`, `bookmark`, `blockEquation`/`inlineEquation`,
  `pageLink`/`pageMention`; custom marks `textColor` and `highlight` (colour
  *names*, valued by the stylesheet per theme).
- `extensions/app-context.js` is the only bridge to the rest of the app
  (other pages, people, server fetches); the page view fills it in.
- `markdown.js` exports and imports Markdown through Tiptap's Markdown
  support; KamiSpace-only blocks use `:::name {attributes}` blocks.
- `extensions/paste-images.js` uploads pictures found in pasted HTML (Word's
  `file://` pictures are recovered from the clipboard's RTF flavour).

Node and mark names are shared with the server's allow-list
(`app/services/document.py`); adding a block type means updating both.

### State and saving

`app/store.js` holds the user and a flat list of all pages the user can see
(one request at start). The sidebar renders only expanded branches.
`app/saver.js` is the autosave state machine: debounce (0.8 s, at most 5 s),
one request in flight, retry with backoff when offline, stop on conflict.

### Performance approach

- Typing never triggers application work beyond ProseMirror's own update and
  a debounce timer.
- One block handle, one toolbar, one drop line — positioned, not re-created.
- Images are `loading="lazy"`; PDF previews are created only on request.
- Views are torn down on navigation (editor destroyed, listeners aborted via
  `AbortController`).

`frontend/e2e/performance.spec.js` opens a 600-block document (code blocks,
tables, images, nested lists) and measures typing. On the development machine:
opened in about 0.6 s, key-to-next-frame median about 20 ms (roughly one
frame), no long tasks.

## Trade-offs worth knowing

- **Single process.** Simple and fast for a team; not designed for horizontal
  scaling. The practical limits are SQLite's single writer and the one
  machine's disk.
- **No real-time co-editing.** Two people can edit different pages freely;
  on the same page the second saver gets a conflict prompt. Idle tabs refresh
  themselves when they regain focus.
- **Full version snapshots** cost disk space on very large, frequently edited
  pages. Versions disappear only when their page is permanently deleted.
- **Tables are one block.** Rows and cells are edited with the table toolbar;
  they have no handles of their own.
- **Toggle state is part of the document.** Opening or closing a toggle is an
  edit (saved, versioned) — simple and predictable, at the cost of a save.

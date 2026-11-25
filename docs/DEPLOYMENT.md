# Deploying KamiSpace on Ubuntu Server

This guide sets up KamiSpace on Ubuntu 22.04 / 24.04 as a systemd service
behind a reverse proxy with HTTPS. Docker is not required.

The examples use `/opt/kamispace`, a system user called `kamispace` and the host
name `notes.example.com`. Replace them with your own.

## 1. Prerequisites

- A server you control, and a DNS name pointing at it (for HTTPS).
- `git` and `curl`: `sudo apt update && sudo apt install -y git curl`

Python does not need to be installed: uv downloads the exact version pinned in
`.python-version` (3.12.11).

## 2. Create a user and fetch the code

```bash
sudo adduser --system --group --home /opt/kamispace --shell /usr/sbin/nologin kamispace
```

```bash
sudo -u kamispace git clone https://github.com/vislupus/KamiSpace.git /opt/kamispace
```

## 3. Install uv and the dependencies

Install uv system-wide so the service can use it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh
```

Install the locked dependencies (no development tools). The project's
`uv.toml` keeps uv's cache in `/opt/kamispace/.uv-cache`, and
`UV_PYTHON_INSTALL_DIR` keeps the downloaded Python inside the project too:

```bash
cd /opt/kamispace
```

```bash
sudo -u kamispace env UV_PYTHON_INSTALL_DIR=/opt/kamispace/.python uv sync --frozen --no-dev
```

## 4. Configure

```bash
sudo -u kamispace cp .env.example .env
```

Edit `/opt/kamispace/.env`. For a production site behind HTTPS set at least:

```ini
KAMISPACE_ENV=production
KAMISPACE_ALLOWED_HOSTS=notes.example.com
KAMISPACE_COOKIE_SECURE=always
```

Protect the file and the data directory:

```bash
sudo chmod 600 /opt/kamispace/.env && sudo chmod 700 /opt/kamispace/data
```

## 5. Create the first administrator

```bash
sudo -u kamispace uv run --frozen --no-dev python -m app create-admin
```

You are asked for a username and a password. This also
creates the database (`data/database.sqlite3`) and applies all migrations.

## 6. Run as a service

```bash
sudo cp deploy/kamispace.service /etc/systemd/system/kamispace.service
```

Check `User`, `WorkingDirectory` and the uv path in the unit file, then:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kamispace
```

```bash
systemctl status kamispace
```

```bash
curl -s http://127.0.0.1:8000/healthz
```

The server listens on `127.0.0.1:8000` only; it is reached through the reverse
proxy. Logs: `journalctl -u kamispace -f` (server) and
`/opt/kamispace/data/logs/kamispace.log` (application errors).

### How many worker processes?

One process serves a small team without trouble, and it is the default. When
many people work at the same time, start several: each worker is a process of
its own, so the server uses more than one CPU core. They share the database
file — SQLite (in WAL mode) lets all of them read at once and takes writers in
turn — and the log file.

```bash
# in .env
KAMISPACE_WORKERS=4
```

```bash
sudo systemctl restart kamispace
```

or on the command line: `python -m app run --workers 4`. A service that starts
uvicorn itself takes the same option:
`uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 4`.

About one worker per CPU core, and not more than the machine has: 2 for up to
a few dozen people, 4 for more. Each worker uses roughly 80–120 MB of memory.
Measured on a 4-core machine with 24 people reading and writing a 300-row
database at once: one worker answers about 25 requests a second, four answer
about 110.

Two things have to hold for several workers:

- the data directory is on a **local disk** (not NFS / SMB, where the file
  locks SQLite relies on are unreliable);
- all workers belong to the **same installation**. Two installations (two
  checkouts, an old and a new release) must never share one data directory.

## 7. Reverse proxy and HTTPS

Always serve KamiSpace over HTTPS — sign-in cookies and your notes travel over
this connection.

### Option A: nginx + Let's Encrypt

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/kamispace
```

Replace `notes.example.com` in that file, then:

```bash
sudo ln -s /etc/nginx/sites-available/kamispace /etc/nginx/sites-enabled/kamispace
```

```bash
sudo certbot --nginx -d notes.example.com
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

certbot installs the certificate and renews it automatically.

Important details in the example configuration:

- `client_max_body_size` must be at least `KAMISPACE_MAX_UPLOAD_MB`.
- `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` are passed on. KamiSpace
  trusts these headers only from `127.0.0.1` (change with
  `python -m app run --forwarded-allow-ips …` if your proxy runs elsewhere).
  They are what makes the `Secure` cookie flag, HSTS and the cross-site
  request check work behind a proxy.

### Option B: Caddy

Caddy obtains and renews certificates by itself:

```bash
sudo apt install -y caddy
```

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
```

Replace the host name, then `sudo systemctl reload caddy`.

### Firewall

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Port 8000 stays closed to the outside.

### Private network only?

If KamiSpace should only be reachable inside your LAN or VPN, the same setup
applies; use a certificate from your internal CA or Caddy's `tls internal`.
Avoid plain HTTP even internally. If you must use it, leave
`KAMISPACE_COOKIE_SECURE=auto`.

## 8. Backups

A backup archive contains a consistent database snapshot (SQLite online backup
API — safe while the service runs), all uploads and a manifest.

Manual:

```bash
sudo -u kamispace uv run --frozen --no-dev python -m app backup
```

### Nightly, with systemd

`/etc/systemd/system/kamispace-backup.service`:

```ini
[Unit]
Description=KamiSpace backup

[Service]
Type=oneshot
User=kamispace
WorkingDirectory=/opt/kamispace
ExecStart=/usr/local/bin/uv run --frozen --no-dev python -m app backup
# Keep the 14 newest archives.
ExecStartPost=/bin/sh -c 'ls -1t data/backups/kamispace-backup-*.zip | tail -n +15 | xargs -r rm --'
```

`/etc/systemd/system/kamispace-backup.timer`:

```ini
[Unit]
Description=Nightly KamiSpace backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kamispace-backup.timer
```

### Keep a copy elsewhere

Backups in `data/backups/` protect against mistakes, not against losing the
server. Copy them off the machine, for example:

```bash
rsync -a /opt/kamispace/data/backups/ backup-host:/srv/backups/kamispace/
```

Administrators can also download archives from **Settings → Backups**.

## 9. Restore

```bash
sudo systemctl stop kamispace
```

```bash
sudo -u kamispace uv run --frozen --no-dev python -m app restore data/backups/kamispace-backup-YYYYMMDD-HHMMSS.zip
```

```bash
sudo systemctl start kamispace
```

- The archive is validated first (format, database integrity check).
- The current database and uploads are **moved** to
  `data/backups/pre-restore-<timestamp>/`, not deleted.
- Pending migrations run afterwards, so archives from older versions work.

To move KamiSpace to a new server: install it there (steps 2–4), copy one
backup archive across and restore it.

## 10. Updating

```bash
cd /opt/kamispace && sudo -u kamispace uv run --frozen --no-dev python -m app backup
```

```bash
sudo -u kamispace git pull
```

```bash
sudo -u kamispace env UV_PYTHON_INSTALL_DIR=/opt/kamispace/.python uv sync --frozen --no-dev
```

```bash
sudo systemctl restart kamispace
```

Database migrations are applied when the application starts — however it is
started (`python -m app run`, uvicorn directly, a container). The built
frontend is part of the repository, so no Node.js is needed on the server.

**The code and the database must be updated together.** A migration changes
the database for good; a copy of the *old* code that keeps running against it
(a service that was restarted but still runs from an older checkout, image or
release directory) fails with "Something went wrong on the server". Check what
is actually running:

```bash
curl -s http://127.0.0.1:8000/healthz
```

It answers with the version and whether the database fits it, for example
`{"status":"ok","version":"0.3.0","schema":"ok","revision":"0003"}`. An answer
without `version` comes from a release older than 0.2.0. And to see which code and
which data a command (or the service's own environment) is using:

```bash
sudo -u kamispace uv run --frozen --no-dev python -m app status
```

```text
KamiSpace 0.3.0 (needs schema revision 0003)
Code:       /opt/kamispace
Migrations: /opt/kamispace/migrations/versions (newest: 0003)
Data:       /opt/kamispace/data
Database:   /opt/kamispace/data/database.sqlite3
Log:        /opt/kamispace/data/logs/kamispace.log
Contents:   4 user(s), 212 page(s)
Schema:     revision 0003 — ok
```

The check does not trust the revision number alone: the tables and columns
the code uses are compared with what the database really has. Anything but
`ok` comes with an explanation and the command to run:

| Schema | Meaning | What to do |
|---|---|---|
| `behind` | The database is older than the code | `python -m app migrate` (or just start the service) |
| `ahead` | The database was upgraded by a newer version | Update the code in this directory |
| `incomplete` | The code is newer than the files in `migrations/versions` | The update copied only part of the project; update all of it |
| `damaged` | The revision mark says "newest" but tables or columns are missing (the database file was replaced by an older copy, or the mark was set by hand) | Back up, then `python -m app migrate --assume <revision it really is at>` |

If *Code* or *Data* is not the directory the service runs from, the command
was looking at another copy: run it with the service's working directory and
environment (`KAMISPACE_DATA_DIR`, `.env`).

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| 502 from the proxy | `systemctl status kamispace`, `journalctl -u kamispace -n 50` |
| "Something went wrong" / 500 on every page right after an update | The running code and the database do not match. `curl …/healthz`: no `version` in the answer → the service still runs the old code, deploy the new code where the service runs and restart; `"schema"` other than `ok` → `python -m app status` explains it and names the command. The exact error is at the end of `data/logs/kamispace.log` (`no such column: pages.small_text` = old code, new database; `no such column: pages.kind` = new code, old database) |
| The service does not start after an update, the log says "schema revision … does not know" | The database was upgraded by a newer version than the code that is starting: update the code in that directory (`git pull`, `uv sync`) |
| "Cross-site request blocked" when saving | The proxy must pass the original `Host` header |
| Signed out immediately after signing in | `KAMISPACE_COOKIE_SECURE=always` requires HTTPS; the proxy must send `X-Forwarded-Proto` |
| "Invalid host header" | Add the host name to `KAMISPACE_ALLOWED_HOSTS` |
| Uploads fail with 413 | Raise `client_max_body_size` (nginx) and `KAMISPACE_MAX_UPLOAD_MB` |
| Locked out of the admin account | `uv run python -m app reset-password <username>` on the server |
| "database is locked" errors | Only one KamiSpace *installation* may use a data directory (its own workers share it fine); the directory must be on a local disk, not a network share |
| Slow with many people at once | Start more workers (section 6): `KAMISPACE_WORKERS=4`. `curl -s -o /dev/null -w '%{time_total}\n' http://127.0.0.1:8000/healthz` should answer in a few milliseconds; if it does and pages are still slow, look at the proxy and the network |

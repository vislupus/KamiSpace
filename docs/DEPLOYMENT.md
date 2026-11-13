# Deploying MindDock on Ubuntu Server

This guide sets up MindDock on Ubuntu 22.04 / 24.04 as a systemd service
behind a reverse proxy with HTTPS. Docker is not required.

The examples use `/opt/minddock`, a system user called `minddock` and the host
name `notes.example.com`. Replace them with your own.

## 1. Prerequisites

- A server you control, and a DNS name pointing at it (for HTTPS).
- `git` and `curl`: `sudo apt update && sudo apt install -y git curl`

Python does not need to be installed: uv downloads the exact version pinned in
`.python-version` (3.12.11).

## 2. Create a user and fetch the code

```bash
sudo adduser --system --group --home /opt/minddock --shell /usr/sbin/nologin minddock
```

```bash
sudo -u minddock git clone https://github.com/vislupus/MindDock.git /opt/minddock
```

## 3. Install uv and the dependencies

Install uv system-wide so the service can use it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh
```

Install the locked dependencies (no development tools). The project's
`uv.toml` keeps uv's cache in `/opt/minddock/.uv-cache`, and
`UV_PYTHON_INSTALL_DIR` keeps the downloaded Python inside the project too:

```bash
cd /opt/minddock
```

```bash
sudo -u minddock env UV_PYTHON_INSTALL_DIR=/opt/minddock/.python uv sync --frozen --no-dev
```

## 4. Configure

```bash
sudo -u minddock cp .env.example .env
```

Edit `/opt/minddock/.env`. For a production site behind HTTPS set at least:

```ini
MINDDOCK_ENV=production
MINDDOCK_ALLOWED_HOSTS=notes.example.com
MINDDOCK_COOKIE_SECURE=always
```

Protect the file and the data directory:

```bash
sudo chmod 600 /opt/minddock/.env && sudo chmod 700 /opt/minddock/data
```

## 5. Create the first administrator

```bash
sudo -u minddock uv run --frozen --no-dev python -m app create-admin
```

You are asked for a username, an email address and a password. This also
creates the database (`data/database.sqlite3`) and applies all migrations.

## 6. Run as a service

```bash
sudo cp deploy/minddock.service /etc/systemd/system/minddock.service
```

Check `User`, `WorkingDirectory` and the uv path in the unit file, then:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now minddock
```

```bash
systemctl status minddock
```

```bash
curl -s http://127.0.0.1:8000/healthz
```

The server listens on `127.0.0.1:8000` only; it is reached through the reverse
proxy. Logs: `journalctl -u minddock -f` (server) and
`/opt/minddock/data/logs/minddock.log` (application errors).

MindDock runs as **one process**. Do not start several workers: SQLite prefers
a single writer process, and one process serves a team without trouble.

## 7. Reverse proxy and HTTPS

Always serve MindDock over HTTPS — sign-in cookies and your notes travel over
this connection.

### Option A: nginx + Let's Encrypt

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/minddock
```

Replace `notes.example.com` in that file, then:

```bash
sudo ln -s /etc/nginx/sites-available/minddock /etc/nginx/sites-enabled/minddock
```

```bash
sudo certbot --nginx -d notes.example.com
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

certbot installs the certificate and renews it automatically.

Important details in the example configuration:

- `client_max_body_size` must be at least `MINDDOCK_MAX_UPLOAD_MB`.
- `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` are passed on. MindDock
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

If MindDock should only be reachable inside your LAN or VPN, the same setup
applies; use a certificate from your internal CA or Caddy's `tls internal`.
Avoid plain HTTP even internally. If you must use it, leave
`MINDDOCK_COOKIE_SECURE=auto`.

## 8. Backups

A backup archive contains a consistent database snapshot (SQLite online backup
API — safe while the service runs), all uploads and a manifest.

Manual:

```bash
sudo -u minddock uv run --frozen --no-dev python -m app backup
```

### Nightly, with systemd

`/etc/systemd/system/minddock-backup.service`:

```ini
[Unit]
Description=MindDock backup

[Service]
Type=oneshot
User=minddock
WorkingDirectory=/opt/minddock
ExecStart=/usr/local/bin/uv run --frozen --no-dev python -m app backup
# Keep the 14 newest archives.
ExecStartPost=/bin/sh -c 'ls -1t data/backups/minddock-backup-*.zip | tail -n +15 | xargs -r rm --'
```

`/etc/systemd/system/minddock-backup.timer`:

```ini
[Unit]
Description=Nightly MindDock backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now minddock-backup.timer
```

### Keep a copy elsewhere

Backups in `data/backups/` protect against mistakes, not against losing the
server. Copy them off the machine, for example:

```bash
rsync -a /opt/minddock/data/backups/ backup-host:/srv/backups/minddock/
```

Administrators can also download archives from **Settings → Backups**.

## 9. Restore

```bash
sudo systemctl stop minddock
```

```bash
sudo -u minddock uv run --frozen --no-dev python -m app restore data/backups/minddock-backup-YYYYMMDD-HHMMSS.zip
```

```bash
sudo systemctl start minddock
```

- The archive is validated first (format, database integrity check).
- The current database and uploads are **moved** to
  `data/backups/pre-restore-<timestamp>/`, not deleted.
- Pending migrations run afterwards, so archives from older versions work.

To move MindDock to a new server: install it there (steps 2–4), copy one
backup archive across and restore it.

## 10. Updating

```bash
cd /opt/minddock && sudo -u minddock uv run --frozen --no-dev python -m app backup
```

```bash
sudo -u minddock git pull
```

```bash
sudo -u minddock env UV_PYTHON_INSTALL_DIR=/opt/minddock/.python uv sync --frozen --no-dev
```

```bash
sudo systemctl restart minddock
```

Database migrations are applied on start (`MINDDOCK_AUTO_MIGRATE=true`). The
built frontend is part of the repository, so no Node.js is needed on the
server.

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| 502 from the proxy | `systemctl status minddock`, `journalctl -u minddock -n 50` |
| "Cross-site request blocked" when saving | The proxy must pass the original `Host` header |
| Signed out immediately after signing in | `MINDDOCK_COOKIE_SECURE=always` requires HTTPS; the proxy must send `X-Forwarded-Proto` |
| "Invalid host header" | Add the host name to `MINDDOCK_ALLOWED_HOSTS` |
| Uploads fail with 413 | Raise `client_max_body_size` (nginx) and `MINDDOCK_MAX_UPLOAD_MB` |
| Locked out of the admin account | `uv run python -m app reset-password <username>` on the server |
| "database is locked" errors | Make sure only one MindDock process uses the data directory |

# Linux Deployment Guide

This guide targets a generic Linux VM (no cloud-vendor lock-in).

## 1. Runtime Requirements

- Node.js 18+
- `codex` CLI available in PATH
- A dedicated Linux user (recommended): `codexbridge`
- Outbound network access to Feishu/Lark APIs and Codex dependencies

## 2. Directory Layout

Recommended:

```text
/srv/codex-feishu-bridge/
  app/                  # git checkout
  state/
    sessions-cloud.json
    attachments/
  logs/
```

## 3. Environment File

Create `/srv/codex-feishu-bridge/app/.env`:

```text
FEISHU_APP_ID=cli_xxx_cloud
FEISHU_APP_SECRET=xxx_cloud_secret
CODEX_IM_DEFAULT_CODEX_MODEL=gpt-5.3-codex
CODEX_IM_DEFAULT_CODEX_EFFORT=medium
CODEX_IM_DEFAULT_CODEX_ACCESS_MODE=default
CODEX_IM_EXTENSIONS_FILE=./extensions/mem0-extension.js
MEM0_ENABLED=true
MEM0_BASE_URL=https://api.mem0.ai
MEM0_API_KEY=m0_xxx
MEM0_USER_ID_PREFIX=feishu
MEM0_SEARCH_LIMIT=5
MEM0_TIMEOUT_MS=15000
CODEX_IM_SESSIONS_FILE=/srv/codex-feishu-bridge/state/sessions-cloud.json
CODEX_IM_ATTACHMENTS_DIR=/srv/codex-feishu-bridge/state/attachments
```

## 4. Install and Start

```sh
cd /srv/codex-feishu-bridge/app
npm install
npm run check:mem0
npm run feishu-bot
```

## 5. systemd Service (recommended)

`/etc/systemd/system/codex-feishu-bridge.service`:

```ini
[Unit]
Description=codex-feishu-bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codexbridge
WorkingDirectory=/srv/codex-feishu-bridge/app
Environment=NODE_ENV=production
ExecStart=/usr/bin/env node ./bin/codex-im.js feishu-bot
Restart=always
RestartSec=3
StandardOutput=append:/srv/codex-feishu-bridge/logs/stdout.log
StandardError=append:/srv/codex-feishu-bridge/logs/stderr.log

[Install]
WantedBy=multi-user.target
```

Enable:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now codex-feishu-bridge
sudo systemctl status codex-feishu-bridge
```

## 6. Health Checks

Minimal checks:

```sh
sudo systemctl is-active codex-feishu-bridge
sudo journalctl -u codex-feishu-bridge -n 50 --no-pager
cd /srv/codex-feishu-bridge/app && npm run check:mem0
```

Behavior checks (in Feishu):

- `/codex bind /absolute/path`
- send a normal message
- `/codex where`
- `/codex access`

## 7. Upgrade and Rollback

Upgrade:

```sh
cd /srv/codex-feishu-bridge/app
git pull
npm install
sudo systemctl restart codex-feishu-bridge
```

Rollback:

```sh
cd /srv/codex-feishu-bridge/app
git checkout <previous-commit>
npm install
sudo systemctl restart codex-feishu-bridge
```

## 8. Logging and Data Hygiene

- Rotate `/srv/codex-feishu-bridge/logs/*.log` with logrotate.
- Back up `state/sessions-cloud.json` only if needed.
- Do not commit `.env`, logs, or state files into git.

# Dual-Instance Runbook (Local + Cloud)

Goal: run two independent bridge instances without event collisions.

## 1. Use Two Feishu Apps/Bots

- Local instance -> App A
- Cloud instance -> App B

Do not run two always-on instances behind the same bot unless you implement explicit traffic partitioning.

## 2. Keep Runtime State Isolated

Must be different between instances:

- `CODEX_IM_SESSIONS_FILE`
- `CODEX_IM_ATTACHMENTS_DIR`
- logs directory

Recommended: share only non-secret config templates.

## 3. Suggested Configuration Split

Local `.env` (example):

```text
FEISHU_APP_ID=cli_xxx_local
FEISHU_APP_SECRET=xxx_local_secret
CODEX_IM_SESSIONS_FILE=/Users/you/.codex-im/sessions-local.json
CODEX_IM_ATTACHMENTS_DIR=/Users/you/.codex-feishu-bridge/attachments-local
```

Cloud `.env` (example):

```text
FEISHU_APP_ID=cli_xxx_cloud
FEISHU_APP_SECRET=xxx_cloud_secret
CODEX_IM_SESSIONS_FILE=/srv/codex-feishu-bridge/state/sessions-cloud.json
CODEX_IM_ATTACHMENTS_DIR=/srv/codex-feishu-bridge/state/attachments
```

## 4. Migration Checklist (Local -> Cloud)

Safe to copy:

- source code
- non-secret docs
- `.env.example`
- command policy preferences (manually re-enter)

Do NOT copy:

- `.env`
- sessions files
- attachment cache
- logs

## 5. Verification

- Local bot receives only local messages.
- Cloud bot receives only cloud messages.
- No duplicate replies in same chat.
- `/codex where` and `/codex access` reflect independent state per bot.

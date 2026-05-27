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
FEISHU_APP_SECRET=YOUR_FEISHU_APP_SECRET
CODEX_IM_DEFAULT_CODEX_MODEL=gpt-5.3-codex
CODEX_IM_DEFAULT_CODEX_EFFORT=medium
CODEX_IM_DEFAULT_CODEX_ACCESS_MODE=default
CODEX_IM_INSTANCE_LABEL=cloud
CODEX_IM_GITHUB_ENABLED=true
CODEX_IM_CANVA_ENABLED=true
CODEX_IM_CLOUDFLARE_ENABLED=false
CODEX_IM_CHROME_ENABLED=false
CODEX_IM_PLUGIN_ROOT=/home/codex/plugins
CODEX_IM_MARKETPLACE_ROOT=/home/codex/.agents/plugins
CODEX_IM_EXTENSIONS_FILE=/absolute/path/to/runtime-extensions.cjs
CODEX_IM_SESSIONS_FILE=/srv/codex-feishu-bridge/state/sessions-cloud.json
CODEX_IM_ATTACHMENTS_DIR=/root/snap/codex/common/.codex-feishu-attachments
CODEX_IM_MORNING_BRIEFING_ENABLED=false
CODEX_IM_MORNING_BRIEFING_CRON=0 8 * * *
CODEX_IM_MORNING_BRIEFING_TIMEZONE=Asia/Shanghai
CODEX_IM_MORNING_BRIEFING_CHAT_ID=
CODEX_IM_MORNING_BRIEFING_WORKSPACE_ROOT=/srv/codex-feishu-bridge/app
CODEX_IM_MORNING_BRIEFING_PROMPT_FILE=
CODEX_IM_MORNING_BRIEFING_TITLE=飞书晨报
CODEX_IM_APPOINTMENT_REMINDER_ENABLED=true
CODEX_IM_APPOINTMENT_NL_INTERCEPT_ENABLED=false
CODEX_IM_APPOINTMENT_TIMEZONE=Asia/Shanghai
CODEX_IM_APPOINTMENT_SCAN_INTERVAL_SEC=60
CODEX_IM_PLUGIN_ROUTE_INTERCEPT_ENABLED=false
```

If your Linux host runs Codex from `snap`, keep `CODEX_IM_ATTACHMENTS_DIR` under `/root/snap/codex/common/` (or the service user's `~/snap/codex/common/`). This avoids `localImage` reads failing inside Codex even when the bridge itself can read files under `/srv/...`.

## 4. Install and Start

```sh
cd /srv/codex-feishu-bridge/app
npm install
npm run check
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
cd /srv/codex-feishu-bridge/app && npm run check
which codex
codex --version
```

If SSH itself becomes flaky, use the SSH banner probe from this repo before guessing:

```sh
npm run ssh:probe -- <host> 22 8000
```

For the full fallback flow, including cloud console / serial console recovery, see [docs/SSH_RECOVERY.md](./SSH_RECOVERY.md).

Behavior checks (in Feishu):

- `/codex bind /absolute/path`
- `/goal cloud-side project target`
- send a normal message
- `/codex where`
- `/codex doctor`
- `/codex new`
- `/codex where`
- `/goal`
- `/goal clear`
- send another normal message
- send `张三预约明天下午三点服务沟通，备注带上方案`
- confirm creation on the card
- `/预约`
- `/预约 列表 全部`
- `/预约 客户 张三`
- `/codex access`
- `/codex skill create support-bot --type bot --with-scripts --with-references Handle customer support triage and summarize outcomes in Feishu`

Goal acceptance:

- `/goal` immediately shows the current workspace goal
- `/codex where` and `/codex doctor` both show the same goal text
- after `/codex new`, the new thread still inherits the same workspace goal
- after `/goal clear`, `/goal` shows no current goal and the next normal message no longer carries the project goal prefix

Appointment acceptance:

- with `CODEX_IM_APPOINTMENT_NL_INTERCEPT_ENABLED=false`, a message like `张三预约明天下午三点服务沟通，备注带上方案` still enters Codex
- with `CODEX_IM_APPOINTMENT_NL_INTERCEPT_ENABLED=true`, the same message is intercepted before Codex and returns a confirmation card
- keep `CODEX_IM_PLUGIN_ROUTE_INTERCEPT_ENABLED=false` when plugin-like messages should also enter Codex instead of stopping at a local suggestion card
- after tapping confirm, `/预约 列表 全部` shows the new appointment
- `/预约 客户 张三` shows customer history and profile note
- appointment commands work without `/codex bind`
- reminders are sent back to the same Feishu chat only once

Skill scaffold acceptance:

- bot reply includes `Type: bot`
- bot reply includes created paths for `SKILL.md` and `agents/openai.yaml`
- when `--with-scripts` is present, bot reply includes `scripts/run.js`
- when `--with-references` is present, bot reply includes `references/context.md`
- on the server, the generated files exist under the configured skill root

Capability checks:

- GitHub: ask the bot for a repository / PR / issue summary and confirm a real result is returned
- Canva: ask the bot for one real Canva query or generation task and confirm a usable result is returned
- Cloudflare: ask the bot for one real Cloudflare query or resource summary and confirm a usable result is returned
- Chrome: only mark enabled after separate browser validation succeeds; otherwise keep `CODEX_IM_CHROME_ENABLED=false`

Morning briefing check:

```sh
cd /srv/codex-feishu-bridge/app
npm run morning-briefing:run
```

If that succeeds, the daily scheduler inside the bridge process can take over at `08:00`.

## 7. Upgrade and Rollback

Upgrade:

```sh
cd /srv/codex-feishu-bridge/app
git pull
npm install
npm run check
npm run test:goal-doctor
npm run test:appointment
node ./scripts/test-skill-scaffold.js
sudo systemctl restart codex-feishu-bridge
```

Rollback:

```sh
cd /srv/codex-feishu-bridge/app
git checkout <previous-commit>
npm install
sudo systemctl restart codex-feishu-bridge
```

## 8. Cloud Rollout For Skill Creation

Shortest path to make the Feishu bot use the new generic skill scaffold flow:

```sh
cd /srv/codex-feishu-bridge/app
git pull origin main
npm install
npm run check
npm run test:goal-doctor
npm run test:appointment
node ./scripts/test-skill-scaffold.js
sudo systemctl restart codex-feishu-bridge
sudo systemctl status codex-feishu-bridge --no-pager
```

Then validate directly in Feishu:

```text
/codex bind /srv/codex-feishu-bridge/app
/codex skill create support-bot --type bot --with-scripts --with-references Handle customer support triage and summarize outcomes in Feishu
```

If you want a lighter scaffold:

```text
/codex skill create approval-helper --type workflow --without-references --desc Process approval requests and produce short action summaries
```

## 9. Quick Restart For Current Cloud Host

If your cloud host is currently running the bridge as `root` with `nohup node ./bin/codex-im.js feishu-bot`
instead of `systemd`, you can use the bundled helper:

```sh
cd /root/snap/codex/common/projects/codex-feishu-bridge-v2/app
bash ./scripts/restart-feishu-bot-cloud.sh
```

What it does:

- prefers `systemctl restart codex-feishu-bridge.service` when that service exists
- ensures `CODEX_IM_APPOINTMENT_NL_INTERCEPT_ENABLED=true` in `.env`
- if no `systemd` service exists, falls back to stopping old `feishu-bot` processes and starting a fresh one
- prints the new PID plus recent startup logs

Optional env overrides:

```sh
CODEX_IM_APP_DIR=/your/app/path \
CODEX_IM_RUNTIME_LOG=/tmp/your-bridge.log \
bash ./scripts/restart-feishu-bot-cloud.sh
```

## 10. One-Click Deploy From Windows

If you are working from the Windows Codex workspace and already have:

- `ssh.exe` and `scp.exe`
- a usable private key at `C:\Users\Administrator\.ssh\codex_deploy_key`
- the current cloud host at `43.153.132.237`

you can run the bundled publish script:

```powershell
cd C:\Users\Administrator\Documents\Codex\2026-05-14\new-chat-3\codex-feishu-bridge
.\scripts\deploy-feishu-bot-cloud.ps1
```

Default behavior:

- packages the current workspace while skipping `.git`, `node_modules`, logs, and runtime state
- uploads to `root@43.153.132.237`
- extracts into `/root/snap/codex/common/projects/codex-feishu-bridge-v2/app`
- runs `npm install`
- runs `npm run test:appointment`
- runs `bash ./scripts/restart-feishu-bot-cloud.sh`
- prints recent `systemd` status and bridge logs

Useful switches:

```powershell
.\scripts\deploy-feishu-bot-cloud.ps1 -SkipInstall
.\scripts\deploy-feishu-bot-cloud.ps1 -SkipTests
.\scripts\deploy-feishu-bot-cloud.ps1 -SkipRestart
.\scripts\deploy-feishu-bot-cloud.ps1 -HostName 43.153.132.237 -UserName root -RemoteAppDir /srv/codex-feishu-bridge/app
```

Recommended verification right after deploy:

- send `明天有几个预约`
- send `下周安排`
- send `Alice 下周二有哪些预约`
- send `本月预约列表`

## 11. Feishu Goal Acceptance Checklist

If you want a single Feishu-side acceptance run, use one temporary goal and verify each step in order.

Suggested goal text:

```text
/goal 验收云端预约查询与本轮发布时间点
```

Feishu checklist:

1. Bind the cloud project:

```text
/codex bind /root/snap/codex/common/projects/codex-feishu-bridge-v2/app
```

Expected:

- bind succeeds
- the current workspace path is the cloud app path

2. Set a visible acceptance goal:

```text
/goal 验收云端预约查询与本轮发布时间点
```

Expected:

- `/goal` immediately shows that exact text
- `/codex where` and `/codex doctor` show the same goal text

3. Verify plain Codex traffic still works:

```text
请用一句话确认你现在已经运行在云端新版本上
```

Expected:

- bot replies normally
- reply is not blocked by local intercept logic

4. Verify base appointment count:

```text
明天有几个预约
```

Expected:

- returns a direct appointment count card reply
- does not fall through to generic Codex reasoning

5. Verify new next-week overview:

```text
下周安排
```

Expected:

- returns a next-week appointment list summary
- wording includes `下周`

6. Verify new weekday plus customer query:

```text
Alice 下周二有哪些预约
```

Expected:

- only Alice records are shown
- wording includes `下周二`

7. Verify new month-range query:

```text
本月预约列表
```

Expected:

- returns only current-month appointments
- wording includes `本月预约列表`

8. Verify vague availability phrasing:

```text
Alice 下月忙不忙
```

Expected:

- returns a count-style answer instead of asking for clarification
- wording includes `下月客户 Alice`

9. Verify goal survives a new Codex thread:

```text
/codex new
/goal
```

Expected:

- the new thread still shows the same goal for the bound cloud project

10. Clear the temporary acceptance goal:

```text
/goal clear
/goal
```

Expected:

- `/goal` no longer shows the temporary acceptance text
- the next normal Codex message no longer carries the goal prefix

If all ten steps pass, you can treat this rollout as accepted on the Feishu side for:

- cloud deploy path
- goal persistence and clearing
- natural-language appointment count/list interception
- next week / weekday / month / vague query phrasing

## 12. Feishu Merge-Forward Acceptance Checklist

Use this checklist after any cloud deploy or bridge restart that touches merged-forward Feishu messages.

Suggested goal text:

```text
/goal 验收云端 merge_forward 进入 Codex 主线
```

Feishu checklist:

1. Bind the cloud project:

```text
/codex bind /root/snap/codex/common/projects/codex-feishu-bridge-v2/app
```

Expected:

- bind succeeds
- the current workspace path is the cloud app path

2. Set a visible acceptance goal:

```text
/goal 验收云端 merge_forward 进入 Codex 主线
```

Expected:

- `/goal` immediately shows that exact text
- `/codex where` and `/codex doctor` show the same goal text

3. Verify the cloud instance is responding:

```text
请用一句话确认你现在已经运行在云端 merge_forward 修复版本上
```

Expected:

- bot replies normally
- reply is not blocked by local intercept logic

4. Send a new merged-forward Feishu message that contains readable child text.

Expected:

- the bot does not reply with `我收到了非文本消息：merge_forward。`
- the bot does not reply with `当前飞书桥暂时只处理文字消息；这类消息还不会进入 Codex。`

5. Judge the returned result:

Expected:

- the reply includes `[bridge merge_forward:v2 active | status=...]`
- if child text expands successfully, the bot response clearly reflects the forwarded text content
- if child text still cannot be expanded, the bot now treats it as normal Codex context instead of stopping at the old bridge fallback
- if the reply still falls back, it should no longer use the old `我收到了非文本消息：merge_forward。` bridge text

6. Run a clean single-line verification:

Create a merged-forward message whose child text is only:

```text
merge-forward-test-20260524
```

Then ask:

```text
这条转发里写了什么？
```

Expected:

- the bot can answer with that exact forwarded line or a faithful paraphrase
- this confirms merged-forward text is entering Codex instead of being dropped at the bridge layer

7. Clear the temporary acceptance goal:

```text
/goal clear
/goal
```

Expected:

- `/goal` no longer shows the temporary acceptance text
- the next normal Codex message no longer carries the goal prefix

If all seven steps pass, you can treat this rollout as accepted on the Feishu side for:

- cloud deploy path
- merge-forward fallback recovery
- merged-forward text entering the Codex mainline
- post-restart Feishu-side regression checking

## 13. Logging and Data Hygiene

- Rotate `/srv/codex-feishu-bridge/logs/*.log` with logrotate.
- Back up `state/sessions-cloud.json` only if needed.
- Do not commit `.env`, logs, or state files into git.

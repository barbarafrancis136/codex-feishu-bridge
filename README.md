# codex-feishu-bridge

A focused Feishu/Lark bridge for local Codex.

`codex-feishu-bridge` connects Feishu/Lark messages to a local Codex app-server, then sends Codex replies back to Feishu/Lark cards.

```text
Feishu/Lark message -> codex-feishu-bridge -> local Codex app-server -> codex-feishu-bridge -> Feishu/Lark reply
```

中文说明见：[docs/使用说明.md](docs/使用说明.md)
Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
Linux deployment: [docs/DEPLOY_LINUX.md](docs/DEPLOY_LINUX.md)
Dual-instance runbook: [docs/DUAL_INSTANCE.md](docs/DUAL_INSTANCE.md)
Release checklist: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)
24x7 systemd-user ops: [docs/OPERATIONS_SYSTEMD_USER.md](docs/OPERATIONS_SYSTEMD_USER.md)
SSH recovery and console restart: [docs/SSH_RECOVERY.md](docs/SSH_RECOVERY.md)
Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md)

版本更新记录见：[CHANGELOG.md](CHANGELOG.md)。

## What It Does

- Remote Codex chat from Feishu/Lark.
- Bind a Feishu conversation to one or more local workspaces.
- Create/switch/resume Codex threads per workspace.
- Stream replies to Feishu cards.
- Handle approval requests (approve/reject/workspace-scope allowlist).
- Inbound image/file/audio intake (download to private cache; images go in as `localImage`).
- Outbound file send:
  - Manual: `/codex send <relative-path>`
  - Automatic directive: `[[codex-feishu-send:relative/path]]`
- Per-workspace Codex settings:
  - Model (`/codex model ...`)
  - Effort (`/codex effort ...`)
  - Access mode (`/codex access ...`)
- Runtime diagnostics:
  - `/codex doctor`
- Stable extension hooks for downstream private integrations.

## What It Does Not Do

- No private memory/knowledge base.
- No personal automation or proprietary orchestration bundled in core.
- No local business workflow in the default thin path.
- No secrets, local logs, private IDs, or personal workspace data in repo.

## Install

```sh
npm install -g codex-feishu-bridge
codex-im feishu-bot
```

Local development:

```sh
npm install
npm run feishu-bot
```

## Configuration

Copy `.env.example` to `.env`.

Required:

```text
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
CODEX_IM_DEFAULT_CODEX_MODEL=gpt-5.3-codex
CODEX_IM_DEFAULT_CODEX_EFFORT=medium
CODEX_IM_DEFAULT_CODEX_ACCESS_MODE=default
```

Optional:

```text
CODEX_IM_BRIDGE_MODE=thin
CODEX_IM_BRIDGE_PASSTHROUGH_TO_CODEX=true
CODEX_IM_DEFAULT_WORKSPACE_ID=default
CODEX_IM_INSTANCE_LABEL=local
CODEX_IM_WORKSPACE_ALLOWLIST=/absolute/project-a,/absolute/project-b
CODEX_IM_CODEX_ENDPOINT=
CODEX_IM_SESSIONS_FILE=/path/to/sessions.json
CODEX_IM_ATTACHMENTS_DIR=/path/to/attachments
CODEX_IM_MAX_IMAGE_BYTES=10485760
CODEX_IM_MAX_ATTACHMENT_BYTES=104857600
CODEX_IM_FEISHU_RETRY_MAX_ATTEMPTS=3
CODEX_IM_FEISHU_RETRY_BASE_DELAY_MS=300
CODEX_IM_FEISHU_PLAIN_TEXT_FALLBACK=false
CODEX_IM_EXTENSIONS_FILE=
CODEX_IM_GITHUB_ENABLED=false
CODEX_IM_CANVA_ENABLED=false
CODEX_IM_CLOUDFLARE_ENABLED=false
CODEX_IM_CHROME_ENABLED=false
CODEX_IM_SKILL_ROOT=/root/.codex/skills
CODEX_IM_PLUGIN_ROOT=/root/plugins
CODEX_IM_MARKETPLACE_ROOT=/root/.agents/plugins
CODEX_IM_MORNING_BRIEFING_ENABLED=false
CODEX_IM_MORNING_BRIEFING_CRON=0 8 * * *
CODEX_IM_MORNING_BRIEFING_CHAT_ID=
CODEX_IM_MORNING_BRIEFING_WORKSPACE_ROOT=
CODEX_IM_APPOINTMENT_REMINDER_ENABLED=false
CODEX_IM_APPOINTMENT_NL_INTERCEPT_ENABLED=false
CODEX_IM_APPOINTMENT_TIMEZONE=Asia/Shanghai
CODEX_IM_APPOINTMENT_SCAN_INTERVAL_SEC=60
CODEX_IM_PLUGIN_ROUTE_INTERCEPT_ENABLED=false
```

## Thin Bridge Mode

Thin mode is the default. Use it when Feishu should behave like a remote Codex window and Codex should handle almost everything:

```text
CODEX_IM_BRIDGE_MODE=thin
CODEX_IM_BRIDGE_PASSTHROUGH_TO_CODEX=true
```

Thin mode keeps the transport/control-plane features local:

- Feishu/Lark connection and CardKit replies
- Codex thread creation, resume, switch, and stop
- Workspace binding and path reachability checks
- Model, effort, access mode, and profile selection
- Approval cards and approve/reject commands
- Inbound attachments and outbound `[[codex-feishu-send:...]]`
- Runtime diagnostics such as `/codex doctor`

Thin mode sends local product/workflow commands into Codex instead of handling them in the bridge:

- `/goal ...`
- `/预约 ...` and `/appoint ...`
- `/codex skill ...`
- `/codex plugin ...`
- `/codex score ...`
- `/codex eval ...`

`CODEX_IM_BRIDGE_PASSTHROUGH_TO_CODEX=false` does not disable this behavior while the effective bridge mode is `thin`. Thin mode wins because the bridge should remain a transport layer.

Thin mode also disables bundled local schedulers and message injection such as morning briefing, appointment reminders, plugin-route suggestion cards, and optimization-memory prefixes. Set `CODEX_IM_BRIDGE_MODE=standard` only if you explicitly want those legacy local bridge capabilities.

## Scheduled Morning Briefing

This is a legacy standard-mode example capability. For normal use, prefer Codex scheduled tasks and keep the bridge in thin mode.

This repo can run a simple daily morning briefing job through the same Feishu bridge runtime when `CODEX_IM_BRIDGE_MODE=standard`.

What it does:

- creates a `morning-briefing` skill scaffold under the configured skill root
- starts a daily scheduler when `CODEX_IM_MORNING_BRIEFING_ENABLED=true`
- creates or reuses a dedicated Codex thread for the report
- sends the generated result back to the configured Feishu chat

Minimum config:

```text
CODEX_IM_MORNING_BRIEFING_ENABLED=true
CODEX_IM_MORNING_BRIEFING_CRON=0 8 * * *
CODEX_IM_MORNING_BRIEFING_CHAT_ID=oc_xxxxxxxxx
CODEX_IM_MORNING_BRIEFING_WORKSPACE_ROOT=/srv/your-project
```

Optional:

```text
CODEX_IM_MORNING_BRIEFING_PROMPT_FILE=/srv/codex-feishu-bridge/prompts/morning-briefing.md
CODEX_IM_MORNING_BRIEFING_TITLE=飞书晨报
CODEX_IM_MORNING_BRIEFING_MODEL=gpt-5.3-codex
CODEX_IM_MORNING_BRIEFING_EFFORT=medium
CODEX_IM_MORNING_BRIEFING_ACCESS_MODE=default
```

The built-in morning briefing prompt and scaffold are intentionally generic. They are not created in thin mode. Put finance, industry, team, or personal briefing formats in `CODEX_IM_MORNING_BRIEFING_PROMPT_FILE` instead of changing the public default.

Manual test:

```sh
CODEX_IM_BRIDGE_MODE=standard
npm run morning-briefing:run
```

## Appointment Reminders

This is a legacy standard-mode example capability. It is not part of the bridge core. In thin mode, appointment-like messages go to Codex instead of being parsed locally by the bridge.

This repo includes appointment reminders as an optional bundled example capability when `CODEX_IM_BRIDGE_MODE=standard`.

Examples:

```text
张三预约明天下午三点服务沟通，备注带上方案
/预约
/预约 列表 今天
/预约 取消 300521-001
/预约 修改 300521-001 时间=2030-05-21 16:00 项目=方案评审 备注=线上会议
/预约 客户 张三
/预约 客户 张三 备注 偏好线上沟通
/appoint list all
```

Behavior:

- By default, normal Feishu messages always continue into Codex. Natural-language appointment interception is opt-in with `CODEX_IM_APPOINTMENT_NL_INTERCEPT_ENABLED=true`.
- Local plugin-route suggestion cards are also opt-in with `CODEX_IM_PLUGIN_ROUTE_INTERCEPT_ENABLED=true`; keep it `false` when Feishu should behave like a Codex remote twin.
- The bot sends a confirmation card first; nothing is saved until the user confirms.
- Appointment data is persisted by `workspaceId + chatId`, so new and old threads in the same Feishu chat share the same appointment list.
- Appointment management and reminders stay local to the bridge runtime; they do not enter Codex chat turns or the public extension boundary.
- Public defaults use generic service wording. Domain-specific phrasing belongs in downstream docs, tests, or future capability config rather than bridge core.
- Reminder rule:
  - default: `09:00` on the appointment day
  - if the appointment is created after `09:00` on the same day: `1h` before the appointment

## Third-Party API Proxy / Endpoint

You can run this bridge with a third-party relay, as long as it matches one of these modes:

1. OpenAI-compatible HTTP relay (most common)

Set environment variables used by your Codex runtime process (the bridge inherits process env):

```text
OPENAI_API_KEY=your_proxy_key
OPENAI_BASE_URL=https://your-proxy.example.com/v1
```

2. Codex RPC WebSocket endpoint (advanced)

```text
CODEX_IM_CODEX_ENDPOINT=wss://your-codex-rpc-endpoint
```

This must be protocol-compatible with Codex RPC used by this project, not just a generic Chat/Responses REST API.

Security notes:

- Use trusted/self-controlled relay providers whenever possible.
- Never commit real keys in git; keep them in `.env` only.
- Use different keys/apps for local and cloud instances.

## Optional Runtime Extension

This repo keeps private integrations out of core, but you can load an external extension file through the hook:

```text
CODEX_IM_EXTENSIONS_FILE=/absolute/path/to/runtime-extensions.cjs
```

See `docs/examples/runtime-extensions.example.cjs` and `docs/examples/runtime-extensions.production-skeleton.cjs` for templates.

## Commands

Local control-plane commands in thin mode:

- `/codex bind /absolute/path`
- `/codex where`
- `/codex doctor`
- `/codex workspace`
- `/codex remove /absolute/path`
- `/codex send <relative-file-path>`
- `/codex switch <threadId>`
- `/codex message`
- `/codex new`
- `/codex stop`
- `/codex model`
- `/codex model update`
- `/codex model <modelId>`
- `/codex effort`
- `/codex effort <low|medium|high|xhigh>`
- `/codex access`
- `/codex access <default|full-access>`
- `/codex profile`
- `/codex profile main`
- `/codex approve`
- `/codex approve workspace`
- `/codex reject`
- `/codex help`

Commands and workflow intents sent to Codex in thin mode:

- `/goal ...`
- `/预约 ...`
- `/appoint ...`
- `/codex skill ...`
- `/codex plugin ...`
- `/codex score ...`
- `/codex eval ...`

Those commands only run as local bridge features in `CODEX_IM_BRIDGE_MODE=standard`.

## Path Reachability Principle

This bridge now distinguishes between:

- conversation context visible to the model
- filesystem path actually reachable from the current runtime instance

Example:

- a message may mention `/srv/codex-feishu-bridge-v2/app`
- but if the current instance cannot access that path, `/codex bind` will not pretend it succeeded

Use `/codex doctor` when you need to confirm which instance is handling the chat, what OS it runs on, and whether the current bound path is really accessible from that execution layer.

## Legacy Skill Scaffolding

This local scaffold helper only runs in `CODEX_IM_BRIDGE_MODE=standard`. In the default thin mode, `/codex skill ...` is forwarded to Codex as a normal user intent.

In standard mode, you can create a skill scaffold directly from the Feishu bot window:

```text
/codex skill create morning-briefing
```

You can also create it with a purpose in one command:

```text
/codex skill create morning-briefing Generate a daily finance morning briefing for Feishu
```

You can also control the scaffold shape:

```text
/codex skill create support-bot --type bot --with-scripts --with-references Handle customer support triage and summarize outcomes in Feishu
```

Optional flags:

- `--type <value>` sets the skill type label, for example `bot`, `workflow`, or `ops`
- `--with-scripts` or `--without-scripts`
- `--with-references` or `--without-references`
- `--desc <text>` if you prefer to separate the description from the name

The bridge will create:

- `<skillRoot>/<name>/SKILL.md`
- `<skillRoot>/<name>/agents/openai.yaml`
- `<skillRoot>/<name>/scripts/run.js`
- `<skillRoot>/<name>/references/context.md`

The generated scaffold now includes:

- a purpose-oriented `description`
- a `## Purpose` section in `SKILL.md`
- a matching `short_description` and `default_prompt` in `agents/openai.yaml`
- a starter helper script in `scripts/run.js`
- a reference notes template in `references/context.md`

This gives you a more usable skill skeleton instead of only an empty placeholder file.

## Feishu/Lark App Setup

Event subscriptions:

- `im.message.receive_v1`
- `card.action.trigger`

Recommended permissions:

- `cardkit:card:write`
- `cardkit:card:read`
- `im:message:send_as_bot`
- `im:message.p2p_msg:readonly`
- `im:message.group_msg`
- `im:message.reactions:write_only`
- `im:resource`

Cloud-side defaults:

- Skills: `~/.codex/skills`
- Plugins: `~/plugins`
- Marketplace: `~/.agents/plugins`

## Open-Source and Dual-Instance Notes

- Keep core bridge reusable; attach private features via extension points.
- For local + cloud deployment, use two separate Feishu apps/bots.
- Do not share session files between instances unless you explicitly want coupled state.
- Recommended: share config templates only, keep runtime state isolated.

## Release Checks

```sh
npm run check
npm run test:markdown
npm run test:card-content
npm run test:media
npm run test:directives
npm run privacy:scan
npm audit --omit=dev
npm pack --dry-run
npm run check:release
```

## License

MIT

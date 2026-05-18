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

## What It Does Not Do

- No private memory/knowledge base.
- No personal automation or proprietary orchestration bundled in core.
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
CODEX_IM_DEFAULT_WORKSPACE_ID=default
CODEX_IM_WORKSPACE_ALLOWLIST=/absolute/project-a,/absolute/project-b
CODEX_IM_CODEX_ENDPOINT=
CODEX_IM_SESSIONS_FILE=/path/to/sessions.json
CODEX_IM_ATTACHMENTS_DIR=/path/to/attachments
CODEX_IM_MAX_IMAGE_BYTES=10485760
CODEX_IM_MAX_ATTACHMENT_BYTES=104857600
CODEX_IM_FEISHU_RETRY_MAX_ATTEMPTS=3
CODEX_IM_FEISHU_RETRY_BASE_DELAY_MS=300
CODEX_IM_EXTENSIONS_FILE=
```

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

## Optional Mem0 Memory Extension

This repo keeps personal memory out of core, but you can enable Mem0 through the extension hook:

```text
CODEX_IM_EXTENSIONS_FILE=./extensions/mem0-extension.js
MEM0_ENABLED=true
MEM0_BASE_URL=https://api.mem0.ai
MEM0_API_KEY=m0_xxx
```

Behavior:

- Before a normal user message is sent to Codex, the extension searches Mem0 with the Feishu sender as `user_id`.
- After Codex produces a reply, the extension writes the user message and assistant reply back into Mem0.
- `/codex ...` management commands are ignored by the memory extension.

## Commands

- `/codex bind /absolute/path`
- `/codex where`
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

## Feishu/Lark App Setup

Event subscriptions:

- `im.message.receive_v1`
- `card.action.trigger`

Recommended permissions:

- `cardkit:card:write`
- `cardkit:card:read`
- `im:message:send_as_bot`
- `im:message.p2p_msg:readonly`
- `im:message.reactions:write_only`
- `im:resource`

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

# Security Policy

## Supported Versions

This project is pre-1.0. Security fixes target the latest published version.

## Reporting a Vulnerability

Please report vulnerabilities privately to repository maintainers. Do not open public issues with exploit details, secrets, or private logs.

## Sensitive Data Rules

Never commit:

- `.env` files
- API keys, app secrets, access tokens, OAuth tokens, or session cookies
- Real Feishu/Lark open IDs, chat IDs, tenant IDs, or document tokens
- Local absolute paths from real users
- Logs, screenshots, chat transcripts, or private workspace data
- Session persistence files (`sessions*.json`) from running instances

Use `.env.example` for placeholders only.

## Dual-Instance Security Guidance

For local + cloud setup:

- Use two separate Feishu/Lark apps/bots.
- Keep `CODEX_IM_SESSIONS_FILE` isolated per instance.
- Keep attachment cache directories isolated per instance.
- Share only non-secret config templates; do not copy runtime state files.
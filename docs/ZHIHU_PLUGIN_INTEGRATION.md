# Zhihu Plugin Integration

This document tracks the public-core integration path for Zhihu Developer API, MCP, and Skill workflows.

## Status

- Routing: supported by the bridge intent router.
- Auth: not configured in this repository.
- Runtime verification: pending.
- Public entry: `https://developer.zhihu.com`

The bridge must not claim live Zhihu data until a developer token or official MCP endpoint is configured and verified.

## Use Cases

- Zhihu search for questions, answers, and articles.
- Web search through Zhihu Developer.
- Hotlist retrieval for creator topic discovery.
- Direct-answer style synthesis.
- Feishu-forwarded content triage for creator workflows.

## Required Credentials

Store credentials outside this public repository.

Suggested environment names for private deployment:

- `ZHIHU_DEVELOPER_TOKEN`
- `ZHIHU_MCP_URL`

Do not commit tokens, account IDs, private request logs, or screenshots.

## Preferred Integration Order

1. Configure official Zhihu MCP if the developer console provides an MCP endpoint.
2. Verify one read-only call, preferably hotlist retrieval.
3. Verify one search call for a known keyword.
4. Add a private runtime extension or plugin that calls the official endpoint.
5. Keep bridge-core behavior limited to routing, documentation, and status reporting.

## Feishu Prompt Starters

- `用知乎热榜给我整理今天的选题素材`
- `用知乎搜索这个关键词的高赞问题和回答`
- `用知乎直答帮我提炼这个话题的观点`

## Response Shape

Use the same compact Feishu shape as other plugin routes:

1. `一句结论`
2. `3-5 条关键发现`
3. `下一步建议`

## Verification Checklist

- Developer token is available in the private runtime.
- MCP or API endpoint is reachable.
- One hotlist request succeeds.
- One keyword search succeeds.
- Feishu reply includes source/time caveats when data is live.
- `/codex doctor` or equivalent status does not expose secrets.

## Boundary

This repository may include generic routing and documentation only. Any token handling, account-specific defaults, private topic lists, or organization-specific creator workflows belong in a private extension.

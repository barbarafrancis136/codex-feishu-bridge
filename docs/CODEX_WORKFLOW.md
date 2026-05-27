# Codex Workflow

This repository is meant to be operated by Codex in a narrow, controlled way:

- public core only
- generic workflow guidance only
- no private knowledge bases, personal memory, or org-specific automation

## How To Ask Codex

Use a request shape like this:

- objective
- scope
- constraints
- verification
- rollback or fallback if relevant

Example:

> Add a short workflow guide for Codex usage in this repo.
> Scope: docs only, no product logic.
> Constraints: keep it public-core, generic, and brief.
> Verify: update `AGENTS.md`, add a doc page, and keep the change small.

## Default Workflow

1. Read the relevant source and docs first.
2. Decide whether the task is public core or an extension hook.
3. Make the smallest change that satisfies the request.
4. Prefer docs, tests, and examples over new product behavior.
5. Verify with the repo's release check when possible.
6. Summarize what changed and what remains unverified.

## Repo-Specific Guardrails

- Keep Feishu/Lark bridge behavior generic.
- Keep Codex RPC, thread management, approvals, model selection, and attachments as public core.
- Do not add private task writeback, personal memory, or org-specific dashboards.
- Do not commit secrets, local paths, logs, screenshots, or chat transcripts.
- If a feature needs private data or automation, document the extension hook only.

## Prompt Pattern

For bigger tasks, write the request as:

- what to change
- what not to change
- where to look
- how to verify

That format keeps the task bounded and makes the result easier to review.

## Verification

Use the repo's standard release check before publishing or handing off:

```sh
npm run check:release
```

If that cannot run, report the blocker and the closest available validation.

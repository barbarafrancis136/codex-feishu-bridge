# Architecture

`codex-feishu-bridge` is the public core for one job:

```text
Feishu/Lark message -> local Codex app-server -> Feishu/Lark response
```

## Layers

```text
bin/
  CLI entrypoint

src/app/
  Runtime orchestration and command dispatch

src/domain/
  Workspace, thread, attachment, approval, and session behavior

src/infra/
  Feishu SDK adapter, Codex RPC client, config, storage

src/presentation/
  Feishu card and message rendering

src/shared/
  Small shared parsing and formatting helpers
```

## Public Core vs Private Extensions

The public core should stay clean and reusable. Private or organization-specific capabilities should attach through stable extension points instead of being added directly to core.

Examples of public core:

- Receive Feishu messages.
- Send replies and cards.
- Bind a Feishu conversation to a local workspace.
- Start or reuse Codex threads.
- Approve or reject Codex actions.
- Download Feishu/Lark images and pass them to Codex as localImage inputs.
- Upload current-workspace images or files back to Feishu/Lark.

Examples of private extensions:

- Personal memory recall.
- Private task or note writeback.
- Personal activity summary sync.
- External agent orchestration.
- Organization-specific dashboards.

## Extension Direction

Future extension points should prefer explicit hooks:

```text
beforeMessage(context)
afterCodexReply(context)
onCommand(command, context)
onApprovalRequest(request, context)
onUsageUpdate(usage, context)
```

Hooks must receive structured context and return structured results. They must not require private paths, private tokens, or private platform assumptions in the public core.

Current public hook surface is defined in `src/app/runtime-extensions.js`:

- `hooks.beforeMessage({ event, normalized, runtime }) => normalized | null`
- `hooks.afterCodexReply({ threadId, turnId, chatId, text, event, runtime }) => string`
- `hooks.onApprovalRequest({ threadId, turnId, approval, event, runtime })`
- `hooks.onUsageUpdate({ threadId, usage, message, runtime })`

Default behavior is no-op. Private integrations should implement these hooks outside this repository and keep the core contract stable.

To load an external extension file at runtime:

```text
CODEX_IM_EXTENSIONS_FILE=/absolute/path/to/runtime-extensions.cjs
```

A minimal template is provided at:

```text
docs/examples/runtime-extensions.example.cjs
```

A production-oriented skeleton template is also provided:

```text
docs/examples/runtime-extensions.production-skeleton.cjs
```

Suggested env toggles for private extension behavior:

```text
CODEX_IM_EXT_HOOKS_ENABLED=true
CODEX_IM_EXT_REPLY_TAG=
CODEX_IM_EXT_APPROVAL_AUDIT=true
CODEX_IM_EXT_USAGE_AUDIT=false
```

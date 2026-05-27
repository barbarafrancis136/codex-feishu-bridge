# Prompt Assets

Prompt assets are reusable prompt text files that can be referenced by local
operators, downstream extensions, or private deployment scripts.

They are not part of the bridge runtime contract. Adding a prompt asset must not
change default bot behavior.

## Current Assets

- `prompts/agent-memory-layering.md`: classifies task information before deciding what is worth remembering.
- `prompts/skill-five-tier-audit.md`: audits installed skills into five operational tiers.

## Boundary

- Keep prompt assets generic and public-safe.
- Do not store secrets, account IDs, chat transcripts, logs, screenshots, or real local absolute paths.
- Do not use prompt assets to add private workflow behavior to the public bridge core.
- Do not include the full `prompts/` directory in the npm package without a full public-safety review.

## External Loading Example

Use prompt assets from an explicit external path instead of hard-coding them into
the bridge runtime.

```sh
PROMPT_ASSET_FILE=./prompts/agent-memory-layering.md
```

```js
const fs = require("fs");
const path = require("path");

function loadPromptAsset(filePath = process.env.PROMPT_ASSET_FILE) {
  if (!filePath) {
    return "";
  }
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

module.exports = { loadPromptAsset };
```

Downstream code can pass the loaded text to Codex as task context. The bridge
core should stay transport-focused.

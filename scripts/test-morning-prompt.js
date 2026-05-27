#!/usr/bin/env node

const assert = require("assert");
const path = require("path");

const {
  DEFAULT_PROMPT,
  resolveMorningBriefingPrompt,
} = require(path.join(__dirname, "..", "src", "morning", "prompt"));

function main() {
  assert.match(DEFAULT_PROMPT, /今日一句话结论/);
  assert.match(DEFAULT_PROMPT, /今日概览/);
  assert.match(DEFAULT_PROMPT, /重点事项/);
  assert.match(DEFAULT_PROMPT, /待确认信息/);
  assert.match(DEFAULT_PROMPT, /下一步建议/);
  assert.match(DEFAULT_PROMPT, /CODEX_IM_MORNING_BRIEFING_PROMPT_FILE/);
  assert.match(DEFAULT_PROMPT, /风险提示/);
  assert.ok(!DEFAULT_PROMPT.includes("AI Hot"));
  assert.ok(!DEFAULT_PROMPT.includes("毛选穿透"));

  const resolved = resolveMorningBriefingPrompt({});
  assert.strictEqual(resolved, DEFAULT_PROMPT);

  console.log("morning prompt ok");
}

main();

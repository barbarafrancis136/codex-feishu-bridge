#!/usr/bin/env node

const assert = require("assert");
const path = require("path");

const {
  buildMorningNormalizedContext,
  parseDailyCron,
  computeNextDelayMs,
} = require(path.join(__dirname, "..", "src", "morning", "service"));

function main() {
  const schedule = parseDailyCron("0 8 * * *");
  assert.deepStrictEqual(schedule, { hour: 8, minute: 0 });

  const delayLocal = computeNextDelayMs(schedule);
  assert.strictEqual(Number.isFinite(delayLocal), true);
  assert.strictEqual(delayLocal > 0, true);

  const delayShanghai = computeNextDelayMs(schedule, "Asia/Shanghai");
  assert.strictEqual(Number.isFinite(delayShanghai), true);
  assert.strictEqual(delayShanghai > 0, true);
  assert.strictEqual(delayShanghai <= 48 * 60 * 60 * 1000, true);

  const normalized = buildMorningNormalizedContext({
    config: {
      defaultWorkspaceId: "default",
      morningBriefingTitle: "Daily Brief",
    },
  }, {
    chatId: "oc_test",
    workspaceRoot: "/srv/codex-feishu-bridge-v2/app",
    manual: false,
  });
  assert.strictEqual(normalized.chatId, "oc_test");
  assert.strictEqual(normalized.messageId, "");
  assert.strictEqual(normalized.senderId, "system:morning-briefing");

  console.log("morning schedule ok");
}

main();

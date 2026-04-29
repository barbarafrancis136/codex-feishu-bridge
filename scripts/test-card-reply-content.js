#!/usr/bin/env node

const assert = require("node:assert/strict");
const { upsertAssistantReplyCard } = require("../src/presentation/card/card-service");
const { classifyLocalAttachment, inferFeishuFileType } = require("../src/shared/media-types");

function createRuntime() {
  const runtime = {
    activeTurnIdByThreadId: new Map(),
    currentRunKeyByThreadId: new Map(),
    replyCardByRunKey: new Map(),
    pendingChatContextByThreadId: new Map(),
    replyFlushTimersByRunKey: new Map(),
    replyFlushInFlightByRunKey: new Map(),
    replyFlushQueuedByRunKey: new Set(),
    config: {
      feishuStreamingOutput: true,
      feishuCardKitStreaming: true,
    },
  };
  runtime.setReplyCardEntry = (runKey, entry) => {
    runtime.replyCardByRunKey.set(runKey, entry);
  };
  runtime.setCurrentRunKeyForThread = (threadId, runKey) => {
    runtime.currentRunKeyByThreadId.set(threadId, runKey);
  };
  return runtime;
}

async function testCompletedSnapshotPromotesPreviousTextToProcessPanel() {
  const runtime = createRuntime();
  const base = {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "chat-1",
    state: "streaming",
    deferFlush: true,
  };

  const processText = "I am checking files before preparing the final answer.";
  const answerText = "结论是：\n\n- Body keeps the final answer\n- Process moves to the panel";

  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: processText,
    mode: "delta",
  });
  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: answerText,
    mode: "delta",
  });
  await upsertAssistantReplyCard(runtime, {
    ...base,
    text: answerText,
    mode: "completed_snapshot",
  });

  const entry = runtime.replyCardByRunKey.get("thread-1:turn-1");
  assert.ok(entry, "reply entry should exist");
  assert.strictEqual(entry.answerText, answerText);
  assert.match(entry.processText, /checking files/);
  assert.doesNotMatch(entry.answerText, /checking files/);
}

function testAttachmentClassification() {
  assert.strictEqual(classifyLocalAttachment("chart.png"), "image");
  assert.strictEqual(classifyLocalAttachment("voice.opus"), "audio");
  assert.strictEqual(classifyLocalAttachment("report.pdf"), "file");
  assert.strictEqual(inferFeishuFileType("report.pdf"), "pdf");
  assert.strictEqual(inferFeishuFileType("deck.pptx"), "ppt");
}

(async () => {
  await testCompletedSnapshotPromotesPreviousTextToProcessPanel();
  testAttachmentClassification();
  console.log("card reply content fixtures ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

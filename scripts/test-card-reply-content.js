#!/usr/bin/env node

const assert = require("node:assert/strict");
const { upsertAssistantReplyCard } = require("../src/presentation/card/card-service");
const { buildAssistantReplyCard } = require("../src/presentation/card/builders");
const { classifyLocalAttachment, inferFeishuFileType } = require("../src/shared/media-types");

function createRuntime(configOverrides = {}) {
  const sent = {
    interactiveCards: [],
    patchedCards: [],
    textMessages: [],
    cardEntities: [],
    sentCardIds: [],
    updatedCardKitCards: [],
    streamedContent: [],
    streamingModes: [],
  };
  const adapter = {
    async sendInteractiveCard(payload) {
      sent.interactiveCards.push(payload);
      return { data: { message_id: `interactive-${sent.interactiveCards.length}` } };
    },
    async patchInteractiveCard(payload) {
      sent.patchedCards.push(payload);
      return {};
    },
    async sendTextByChatId(payload) {
      sent.textMessages.push(payload);
      return { data: { message_id: `text-${sent.textMessages.length}` } };
    },
    async createCardEntity({ card }) {
      sent.cardEntities.push({ card });
      return `card-${sent.cardEntities.length}`;
    },
    async sendCardByCardId(payload) {
      sent.sentCardIds.push(payload);
      return { data: { message_id: `cardkit-${sent.sentCardIds.length}` } };
    },
    async updateCardKitCard(payload) {
      sent.updatedCardKitCards.push(payload);
      return {};
    },
    async streamCardContent(payload) {
      sent.streamedContent.push(payload);
      return {};
    },
    async setCardStreamingMode(payload) {
      sent.streamingModes.push(payload);
      return {};
    },
  };
  const runtime = {
    activeTurnIdByThreadId: new Map(),
    currentRunKeyByThreadId: new Map(),
    replyCardByRunKey: new Map(),
    pendingChatContextByThreadId: new Map(),
    replyFlushTimersByRunKey: new Map(),
    replyFlushInFlightByRunKey: new Map(),
    replyFlushQueuedByRunKey: new Set(),
    toolTraceByRunKey: new Map(),
    toolItemIdsByRunKey: new Map(),
    latestTokenUsageByThreadId: new Map(),
    assistantDeltaSeenByRunKey: new Map(),
    pendingReactionByBindingKey: new Map(),
    pendingReactionByThreadId: new Map(),
    config: {
      feishuStreamingOutput: true,
      feishuCardKitStreaming: true,
      defaultCodexModel: "Codex",
      ...configOverrides,
    },
  };
  runtime.setReplyCardEntry = (runKey, entry) => {
    runtime.replyCardByRunKey.set(runKey, entry);
  };
  runtime.setCurrentRunKeyForThread = (threadId, runKey) => {
    runtime.currentRunKeyByThreadId.set(threadId, runKey);
  };
  runtime.requireFeishuAdapter = () => adapter;
  runtime.clearPendingReactionForThread = async () => {};
  runtime.disposeReplyRunState = () => {};
  runtime.sent = sent;
  return runtime;
}

function assertNoInternalPanels(card) {
  const serialized = JSON.stringify(card);
  assert.doesNotMatch(serialized, /collapsible_panel/);
  assert.doesNotMatch(serialized, /工具执行/);
  assert.doesNotMatch(serialized, /正在想/);
  assert.doesNotMatch(serialized, /思考完成/);
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

function testLegacyBuilderOmitsInternalPanels() {
  const card = buildAssistantReplyCard({
    text: "结论是：\n\n- 只保留正式回复",
    state: "completed",
    incomingText: "好",
    elapsed: "3s",
    model: "Codex",
  });
  assertNoInternalPanels(card);
  assert.match(JSON.stringify(card), /只保留正式回复/);
}

async function testLegacyReplyCardOmitsInternalPanels() {
  const runtime = createRuntime({ feishuCardKitStreaming: false });
  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-legacy",
    turnId: "turn-legacy",
    chatId: "chat-legacy",
    text: "结论是：\n\n- 只保留正式回复",
    state: "completed",
  });
  assert.strictEqual(runtime.sent.interactiveCards.length, 1);
  const sentCard = runtime.sent.interactiveCards[0]?.card;
  assert.ok(sentCard, "legacy reply card should be sent");
  assertNoInternalPanels(sentCard);
}

async function testCardKitReplyOmitsInternalPanels() {
  const runtime = createRuntime();
  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-cardkit",
    turnId: "turn-cardkit",
    chatId: "chat-cardkit",
    text: "我先检查文件，再整理给你。",
    state: "streaming",
  });
  assert.strictEqual(runtime.sent.cardEntities.length, 1);
  assertNoInternalPanels(runtime.sent.cardEntities[0].card);

  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-cardkit",
    turnId: "turn-cardkit",
    chatId: "chat-cardkit",
    text: "结论是：\n\n- 只保留正式回复",
    state: "completed",
    mode: "completed_snapshot",
  });
  const finalUpdate = runtime.sent.updatedCardKitCards.at(-1);
  assert.ok(finalUpdate?.card, "final CardKit card should be updated");
  assertNoInternalPanels(finalUpdate.card);
  assert.match(JSON.stringify(finalUpdate.card), /只保留正式回复/);
}

(async () => {
  await testCompletedSnapshotPromotesPreviousTextToProcessPanel();
  testAttachmentClassification();
  testLegacyBuilderOmitsInternalPanels();
  await testLegacyReplyCardOmitsInternalPanels();
  await testCardKitReplyOmitsInternalPanels();
  console.log("card reply content fixtures ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

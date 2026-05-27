const crypto = require("crypto");
const { createLogger } = require("../../shared/logger");

const logger = createLogger("bridge-wakeup");

const WAKEUP_DIRECTIVE_NAME = "codex-feishu-wakeup";
const WAKEUP_DIRECTIVE_MARKER = `[[${WAKEUP_DIRECTIVE_NAME}:`;
const WAKEUP_DIRECTIVE_RE = /\[\[codex-feishu-wakeup:([\s\S]*?)\]\]/g;

function extractAndStoreWakeupDirectives(runtime, {
  text = "",
  threadId = "",
  turnId = "",
  chatId = "",
  normalized = null,
} = {}) {
  const rawText = String(text || "");
  if (!rawText.includes(WAKEUP_DIRECTIVE_MARKER)) {
    return {
      visibleText: rawText,
      tasks: [],
    };
  }

  const tasks = [];
  const visibleText = rawText.replace(WAKEUP_DIRECTIVE_RE, (_fullMatch, payloadText) => {
    const directive = parseWakeupDirectivePayload(payloadText);
    if (!directive) {
      return "";
    }
    const task = buildBridgeWakeupTaskFromDirective(runtime, {
      directive,
      threadId,
      turnId,
      chatId,
      normalized,
    });
    if (!task) {
      return "";
    }
    runtime.sessionStore.upsertBridgeWakeupTask(task);
    tasks.push(task);
    return "";
  });

  return {
    visibleText,
    tasks,
  };
}

function parseWakeupDirectivePayload(payloadText) {
  try {
    const parsed = JSON.parse(String(payloadText || "").trim());
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    logger.warn("failed to parse wakeup directive payload", { error });
    return null;
  }
}

function buildBridgeWakeupTaskFromDirective(runtime, {
  directive = {},
  threadId = "",
  turnId = "",
  chatId = "",
  normalized = null,
} = {}) {
  const runAt = normalizeIsoString(directive.runAt);
  const text = normalizeText(directive.text);
  if (!chatId || !runAt || !text) {
    return null;
  }
  const sourceMessageId = normalizeText(normalized?.messageId);
  const bindingContext = typeof runtime?.getBindingContext === "function"
    ? runtime.getBindingContext(normalized || {})
    : {};
  const dedupeKey = normalizeText(directive.dedupeKey)
    || [chatId, threadId, sourceMessageId, runAt, text].filter(Boolean).join("|");
  const taskId = crypto
    .createHash("sha1")
    .update(dedupeKey)
    .digest("hex")
    .slice(0, 20);

  return {
    id: taskId,
    chatId: normalizeText(chatId),
    threadId: normalizeText(threadId),
    threadKey: normalizeText(normalized?.threadKey),
    replyToMessageId: sourceMessageId,
    replyInThread: directive.replyInThread !== false,
    bindingKey: normalizeText(bindingContext?.bindingKey),
    workspaceRoot: normalizeText(bindingContext?.workspaceRoot),
    sourceMessageId,
    sourceTurnId: normalizeText(turnId),
    title: normalizeText(directive.title),
    text,
    runAt,
    dedupeKey,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deliveredAt: "",
    lastError: "",
  };
}

function startBridgeWakeupScheduler(runtime, {
  scanIntervalSec = 15,
} = {}) {
  stopBridgeWakeupScheduler(runtime);
  const intervalMs = Math.max(5, Number(scanIntervalSec) || 15) * 1000;
  const timer = setInterval(() => {
    flushDueBridgeWakeupTasks(runtime).catch((error) => {
      logger.error("bridge wakeup scan failed", { error });
    });
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  runtime.bridgeWakeupScheduler = timer;
  void flushDueBridgeWakeupTasks(runtime);
}

function stopBridgeWakeupScheduler(runtime) {
  if (runtime?.bridgeWakeupScheduler) {
    clearInterval(runtime.bridgeWakeupScheduler);
    runtime.bridgeWakeupScheduler = null;
  }
}

async function flushDueBridgeWakeupTasks(runtime, now = new Date()) {
  const tasks = runtime?.sessionStore?.listDueBridgeWakeupTasks
    ? runtime.sessionStore.listDueBridgeWakeupTasks(now)
    : [];
  for (const task of tasks) {
    try {
      await runtime.requireFeishuAdapter().sendTextByChatId({
        chatId: task.chatId,
        text: task.text,
        replyToMessageId: task.replyToMessageId,
        replyInThread: task.replyInThread !== false,
      });
      runtime.sessionStore.markBridgeWakeupTaskDelivered(task.id, new Date().toISOString());
      logger.info("bridge wakeup delivered", {
        taskId: task.id,
        chatId: task.chatId,
        runAt: task.runAt,
      });
    } catch (error) {
      runtime.sessionStore.markBridgeWakeupTaskFailed(task.id, error?.message || String(error));
      logger.error("bridge wakeup delivery failed", {
        taskId: task.id,
        chatId: task.chatId,
        error,
      });
    }
  }
  runtime?.sessionStore?.pruneDeliveredBridgeWakeupTasks?.({ now });
  return tasks.length;
}

function normalizeIsoString(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  WAKEUP_DIRECTIVE_MARKER,
  WAKEUP_DIRECTIVE_NAME,
  extractAndStoreWakeupDirectives,
  flushDueBridgeWakeupTasks,
  parseWakeupDirectivePayload,
  startBridgeWakeupScheduler,
  stopBridgeWakeupScheduler,
};

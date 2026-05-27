const codexMessageUtils = require("../infra/codex/message-utils");
const attachmentDirectives = require("../domain/attachments/outbound-directive-service");
const bridgeWakeupService = require("../domain/automation/bridge-wakeup-service");
const { formatFailureText } = require("../shared/error-text");
const { createLogger } = require("../shared/logger");
const logger = createLogger("codex-events");
const HIDDEN_DIRECTIVE_RE = /\[\[(?:codex-goal-state|codex-memory-evolution|codex-feishu-wakeup):[\s\S]*?\]\]/g;
const HIDDEN_DIRECTIVE_START_MARKERS = Object.freeze([
  "[[codex-goal-state:",
  "[[codex-memory-evolution:",
  "[[codex-feishu-wakeup:",
]);
const HIDDEN_DIRECTIVE_END = "]]";

async function handleStopCommand(runtime, normalized) {
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  const threadId = workspaceRoot ? runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot) : null;
  const turnId = threadId ? runtime.activeTurnIdByThreadId.get(threadId) || null : null;

  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话还没有可停止的运行任务。",
    });
    return;
  }

  try {
    await runtime.codex.sendRequest("turn/interrupt", {
      threadId,
      turnId,
    });
    runtime.cleanupThreadRuntimeState(threadId);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "已发送停止请求，并已清理飞书端运行状态。可以继续发新消息。",
    });
  } catch (error) {
    runtime.cleanupThreadRuntimeState(threadId);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `${formatFailureText("停止请求未确认", error)}\n\n我已先清理飞书端运行状态，你可以继续发消息；如果终端侧仍在跑，建议稍后再发一次 /codex stop。`,
    });
  }
}

function handleCodexMessage(runtime, message) {
  if (typeof message?.method === "string") {
    logger.info("codex event", { method: message.method });
  }
  codexMessageUtils.trackAssistantDeltaReceipt(runtime.assistantDeltaSeenByRunKey, message);
  trackLatestTokenUsage(runtime, message);
  trackLatestToolUsage(runtime, message);
  codexMessageUtils.trackRunningTurn(runtime.activeTurnIdByThreadId, message);
  trackRunningTurnStartedAt(runtime, message);
  codexMessageUtils.trackPendingApproval(runtime.pendingApprovalByThreadId, message);
  codexMessageUtils.trackRunKeyState(runtime.currentRunKeyByThreadId, runtime.activeTurnIdByThreadId, message);
  runtime.pruneRuntimeMapSizes();
  const outbound = codexMessageUtils.mapCodexMessageToImEvent(message, {
    suppressCompletedAssistantText: codexMessageUtils.shouldSuppressCompletedAssistantText(
      runtime.assistantDeltaSeenByRunKey,
      message
    ),
  });
  if (!outbound) {
    return;
  }

  const threadId = outbound.payload?.threadId || "";
  if (!outbound.payload.turnId) {
    outbound.payload.turnId = runtime.activeTurnIdByThreadId.get(threadId) || "";
  }
  const context = runtime.pendingChatContextByThreadId.get(threadId);
  if (context) {
    outbound.payload.chatId = context.chatId;
    outbound.payload.threadKey = context.threadKey;
    outbound.payload.normalized = context;
  }

  if (codexMessageUtils.eventShouldClearPendingReaction(outbound)) {
    runtime.clearPendingReactionForThread(threadId).catch((error) => {
      logger.error("failed to clear pending reaction", { threadId, error });
    });
  }

  const shouldCleanupThreadState = isTerminalTurnMessage(message);
  runtime.deliverToFeishu(outbound)
    .catch((error) => {
      logger.error("failed to deliver Feishu message", { error });
    })
    .finally(() => {
      if (!shouldCleanupThreadState || !threadId) {
        return;
      }
      runtime.clearPendingReactionForThread(threadId).catch((error) => {
        logger.error("failed to clear pending reaction", { threadId, error });
      });
      runtime.cleanupThreadRuntimeState(threadId);
    });
}

function trackLatestTokenUsage(runtime, message) {
  if (message?.method !== "thread/tokenUsage/updated") {
    return;
  }
  const params = message?.params || {};
  const threadId = params?.threadId || "";
  const usage = params?.tokenUsage || {};
  if (!threadId || !usage || typeof usage !== "object") {
    return;
  }
  runtime.latestTokenUsageByThreadId.set(threadId, usage);
  runtime.runUsageUpdateHook({
    threadId,
    usage,
    message,
    runtime,
  }).catch((error) => {
    logger.warn("onUsageUpdate hook invocation failed", { error });
  });
}

function trackRunningTurnStartedAt(runtime, message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = params?.threadId || "";
  if (!threadId) {
    return;
  }
  if (method === "turn/started" || method === "turn/start") {
    runtime.activeTurnStartedAtByThreadId.set(threadId, Date.now());
    return;
  }
  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    runtime.activeTurnStartedAtByThreadId.delete(threadId);
  }
}

function trackLatestToolUsage(runtime, message) {
  const method = String(message?.method || "");
  const params = message?.params || {};
  if (method === "item/started" || method === "item/completed") {
    const item = params?.item || {};
    const itemType = String(item?.type || "");
    if (!isToolLikeItemType(itemType)) {
      return;
    }
    const threadId = String(params?.threadId || "");
    const turnId = String(params?.turnId || "");
    const itemId = String(item?.id || "");
    if (!threadId || !turnId || !itemId) {
      return;
    }
    const prefix = method === "item/started" ? "开始" : "完成";
    recordToolTrace(runtime, {
      threadId,
      turnId,
      itemId,
      summary: summarizeToolItem(itemType, item, prefix),
    });
    return;
  }

  if (isApprovalRequestEventMethod(method)) {
    const threadId = String(params?.threadId || "");
    const turnId = String(params?.turnId || "");
    const itemId = String(params?.itemId || message?.id || "");
    if (!threadId || !turnId || !itemId) {
      return;
    }
    recordToolTrace(runtime, {
      threadId,
      turnId,
      itemId,
      summary: summarizeApprovalRequest(params),
    });
  }
}

function recordToolTrace(runtime, { threadId, turnId, itemId, summary }) {
  const normalizedThreadId = String(threadId || "");
  const normalizedTurnId = String(turnId || "");
  const normalizedItemId = String(itemId || "");
  if (!normalizedThreadId || !normalizedTurnId || !normalizedItemId) {
    return;
  }
  const runKey = `${normalizedThreadId}:${normalizedTurnId}`;
  const current = runtime.toolItemIdsByRunKey.get(runKey) || new Set();
  current.add(normalizedItemId);
  runtime.toolItemIdsByRunKey.set(runKey, current);

  const toolTrace = runtime.toolTraceByRunKey.get(runKey) || [];
  if (summary && !toolTrace.includes(summary)) {
    toolTrace.push(summary);
    runtime.toolTraceByRunKey.set(runKey, toolTrace.slice(-8));
  }
}

function isToolLikeItemType(itemType) {
  return [
    "commandExecution",
    "webSearch",
    "mcpToolCall",
    "localShellCall",
  ].includes(itemType);
}

function summarizeToolItem(itemType, item, prefix = "") {
  const normalizedType = String(itemType || "");
  const label = prefix ? `${prefix}：` : "";
  if (normalizedType === "webSearch") {
    const query = firstNonEmptyString(
      item?.query,
      item?.input?.query,
      item?.arguments?.query,
      item?.payload?.query
    );
    return query ? `${label}网页搜索：${query}` : `${label}网页搜索`;
  }

  if (normalizedType === "commandExecution" || normalizedType === "localShellCall") {
    const command = firstNonEmptyString(
      item?.command,
      item?.input?.command,
      item?.arguments?.command,
      item?.payload?.command,
      item?.cmd,
      item?.input?.cmd,
      item?.shellCommand
    );
    return command ? `${label}命令执行：${truncateInline(command, 80)}` : `${label}命令执行`;
  }

  if (normalizedType === "mcpToolCall") {
    const toolName = firstNonEmptyString(
      item?.toolName,
      item?.name,
      item?.input?.toolName,
      item?.arguments?.toolName,
      item?.payload?.toolName
    );
    return toolName ? `${label}MCP 工具：${toolName}` : `${label}MCP 工具`;
  }

  return `${label}${normalizedType || "工具调用"}`;
}

function summarizeApprovalRequest(params) {
  const reason = firstNonEmptyString(params?.reason);
  const command = firstNonEmptyString(params?.command);
  const commandText = command ? `：${truncateInline(command, 80)}` : "";
  const reasonText = reason ? `（${truncateInline(reason, 40)}）` : "";
  return `等待授权${reasonText}${commandText}`;
}

function isApprovalRequestEventMethod(method) {
  return typeof method === "string" && method.endsWith("requestApproval");
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function truncateInline(text, limit = 80) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return "";
  }
  if (clean.length <= limit) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

async function deliverToFeishu(runtime, event) {
  if (event.type === "im.agent_reply") {
    const hookedText = await runtime.runAfterCodexReplyHook({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      chatId: event.payload.chatId,
      text: event.payload.text,
      event,
      runtime,
    });
    const finalizedText = applyMergeForwardReplyMarker(
      event.payload?.normalized,
      event.payload?.mode,
      hookedText
    );
    const displayText = attachmentDirectives.stripSendDirectivesForDisplay(finalizedText);
    const correctedText = correctAttachmentFailureMisdiagnosis(
      event.payload?.normalized,
      displayText,
      event.payload?.threadId || ""
    );
    const wakeupResult = bridgeWakeupService.extractAndStoreWakeupDirectives(runtime, {
      text: correctedText,
      threadId: event.payload.threadId || "",
      turnId: event.payload.turnId || "",
      chatId: event.payload.chatId || "",
      normalized: event.payload?.normalized || null,
    });
    const visibleText = stripHiddenGoalStateDirectiveForDisplay(runtime, {
      threadId: event.payload.threadId || "",
      turnId: event.payload.turnId || "",
      text: wakeupResult.visibleText,
      mode: event.payload.mode || "delta",
    });
    const attachmentResult = await attachmentDirectives.handleOutboundAttachmentDirectives(runtime, {
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      chatId: event.payload.chatId,
      text: finalizedText,
    });
    if (!attachmentResult.text && attachmentResult.sent > 0) {
      await runtime.flushAssistantReplyCardNow({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId || "",
      }).catch(() => {});
      runtime.cleanupThreadRuntimeState(event.payload.threadId || "");
      return;
    }
    await runtime.upsertAssistantReplyCard({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      chatId: event.payload.chatId,
      text: visibleText,
      mode: event.payload.mode || "delta",
      state: "streaming",
      deferFlush: !runtime.config.feishuStreamingOutput,
    });
    return;
  }

  if (event.type === "im.run_state") {
    if (event.payload.state === "streaming") {
      if (!runtime.config.feishuStreamingOutput) {
        return;
      }
      if (runtime.config.feishuCardKitStreaming !== false) {
        return;
      }
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        state: "streaming",
      });
    } else if (event.payload.state === "completed") {
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        state: "completed",
      });
    } else if (event.payload.state === "failed") {
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        text: event.payload.text || "执行失败",
        state: "failed",
      });
    }
    return;
  }

  if (event.type === "im.approval_request") {
    const approval = runtime.pendingApprovalByThreadId.get(event.payload.threadId);
    if (!approval) {
      return;
    }
    await runtime.runApprovalRequestHook({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId || "",
      approval,
      event,
      runtime,
    });
    await runtime.flushAssistantReplyCardNow({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId || "",
    }).catch((error) => {
      logger.error("failed to flush reply before approval prompt", { error });
    });
    const autoApproved = await runtime.tryAutoApproveRequest(event.payload.threadId, approval);
    if (autoApproved) {
      return;
    }
    await runtime.sendApprovalPrompt({
      threadId: event.payload.threadId,
      reason: "request",
    });
  }
}

function isTerminalTurnMessage(message) {
  const method = typeof message?.method === "string" ? message.method : "";
  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    return true;
  }
  if (method !== "error") {
    return false;
  }
  const params = message?.params || {};
  if (params?.willRetry) {
    return false;
  }
  const errorMessage = String(params?.error?.message || "");
  const errorDetails = String(params?.error?.additionalDetails || "");
  return /stream disconnected|Reconnecting/i.test(errorMessage)
    || /stream disconnected/i.test(errorDetails);
}

function correctAttachmentFailureMisdiagnosis(normalized, text, threadId = "") {
  const rawText = String(text || "");
  if (!rawText) {
    return rawText;
  }

  const receipt = normalized?.attachmentReceipt || null;
  const attachments = Array.isArray(normalized?.attachments) ? normalized.attachments : [];
  const imageAttachments = attachments.filter((attachment) => attachment?.kind === "image" && attachment?.filePath);
  const imageDelivered = Boolean(
    imageAttachments.length
    && receipt?.stages?.received?.status === "success"
    && receipt?.stages?.cached?.status === "success"
    && receipt?.stages?.delivered?.status === "success"
  );
  if (!imageDelivered) {
    return rawText;
  }

  if (!looksLikeImageMountFailureText(rawText)) {
    return rawText;
  }

  const filePath = imageAttachments[0]?.filePath || "";
  logger.warn("corrected misleading image-mount diagnosis", {
    threadId,
    messageId: normalized?.messageId || "",
    filePath,
  });

  return [
    "这次不能把原因归结为“文件不存在”。桥已经确认这张图片链路是成功的：",
    "1. 飞书图片已收到",
    `2. 图片已落盘到本地缓存：\`${filePath}\``,
    "3. 图片已作为 `localImage` 送入 Codex",
    "",
    "当前更可能是这套模型或端点没有真正处理本轮视觉输入，而不是挂载失败。",
    "如果后面我还是给不出图片里的可见细节，那就说明是当前 provider 的视觉能力未打通。",
  ].join("\n");
}

function applyMergeForwardReplyMarker(normalized, mode, text) {
  const rawText = String(text || "");
  if (!rawText) {
    return rawText;
  }
  if (String(normalized?.messageType || "").trim().toLowerCase() !== "merge_forward") {
    return rawText;
  }
  if (String(mode || "").trim() !== "completed_snapshot") {
    return rawText;
  }
  const status = String(normalized?.mergeForwardStatus || "received").trim() || "received";
  const marker = `[bridge merge_forward:v2 active | status=${status}]`;
  if (rawText.startsWith(marker)) {
    return rawText;
  }
  return `${marker}\n\n${rawText}`;
}

function stripHiddenGoalStateDirectiveForDisplay(runtime, {
  threadId = "",
  turnId = "",
  text,
  mode = "delta",
} = {}) {
  const rawText = typeof text === "string" ? text : "";
  if (!rawText) {
    return rawText;
  }

  const normalizedMode = String(mode || "").trim();
  const runKey = resolveGoalDirectiveRunKey(runtime, threadId, turnId);
  if (normalizedMode === "completed_snapshot") {
    if (runKey) {
      ensureGoalDirectiveDisplayStateMap(runtime).delete(runKey);
    }
    return rawText.replace(HIDDEN_DIRECTIVE_RE, "");
  }

  if (!runKey) {
    return rawText.replace(HIDDEN_DIRECTIVE_RE, "");
  }

  const stateMap = ensureGoalDirectiveDisplayStateMap(runtime);
  const currentState = stateMap.get(runKey) || createEmptyGoalDirectiveDisplayState();
  const nextState = createEmptyGoalDirectiveDisplayState(currentState);
  let input = `${currentState.pendingPrefix}${rawText}`;
  let visibleText = "";

  while (input) {
    if (nextState.insideDirective) {
      const endIndex = input.indexOf(HIDDEN_DIRECTIVE_END);
      if (endIndex === -1) {
        input = "";
        break;
      }
      nextState.insideDirective = false;
      input = input.slice(endIndex + HIDDEN_DIRECTIVE_END.length);
      continue;
    }

    const startMatch = findHiddenDirectiveStart(input);
    if (startMatch.index >= 0) {
      visibleText += input.slice(0, startMatch.index);
      input = input.slice(startMatch.index + startMatch.marker.length);
      nextState.insideDirective = true;
      continue;
    }

    const pendingPrefixLength = getGoalDirectivePendingPrefixLength(input);
    if (pendingPrefixLength > 0) {
      const safeLength = input.length - pendingPrefixLength;
      if (safeLength > 0) {
        visibleText += input.slice(0, safeLength);
      }
      nextState.pendingPrefix = input.slice(safeLength);
    } else {
      visibleText += input;
    }
    input = "";
  }

  if (nextState.insideDirective || nextState.pendingPrefix) {
    stateMap.set(runKey, nextState);
  } else {
    stateMap.delete(runKey);
  }
  return visibleText;
}

function resolveGoalDirectiveRunKey(runtime, threadId, turnId) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) {
    return "";
  }
  const normalizedTurnId = String(turnId || "").trim()
    || runtime?.activeTurnIdByThreadId?.get(normalizedThreadId)
    || codexMessageUtils.extractTurnIdFromRunKey(runtime?.currentRunKeyByThreadId?.get(normalizedThreadId) || "")
    || "";
  return codexMessageUtils.buildRunKey(normalizedThreadId, normalizedTurnId);
}

function ensureGoalDirectiveDisplayStateMap(runtime) {
  if (!(runtime?.hiddenGoalDirectiveStateByRunKey instanceof Map)) {
    runtime.hiddenGoalDirectiveStateByRunKey = new Map();
  }
  return runtime.hiddenGoalDirectiveStateByRunKey;
}

function createEmptyGoalDirectiveDisplayState(current = null) {
  return {
    insideDirective: Boolean(current?.insideDirective),
    pendingPrefix: typeof current?.pendingPrefix === "string" ? current.pendingPrefix : "",
  };
}

function findHiddenDirectiveStart(input) {
  const rawText = String(input || "");
  let bestIndex = -1;
  let bestMarker = "";
  HIDDEN_DIRECTIVE_START_MARKERS.forEach((marker) => {
    const index = rawText.indexOf(marker);
    if (index === -1) {
      return;
    }
    if (bestIndex === -1 || index < bestIndex) {
      bestIndex = index;
      bestMarker = marker;
    }
  });
  return {
    index: bestIndex,
    marker: bestMarker,
  };
}

function getGoalDirectivePendingPrefixLength(input) {
  const rawText = String(input || "");
  const longestMarker = HIDDEN_DIRECTIVE_START_MARKERS.reduce(
    (max, marker) => Math.max(max, marker.length),
    0
  );
  const maxLength = Math.min(rawText.length, Math.max(0, longestMarker - 1));
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = rawText.slice(-length);
    if (HIDDEN_DIRECTIVE_START_MARKERS.some((marker) => marker.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}

function looksLikeImageMountFailureText(text) {
  const rawText = String(text || "");
  if (!rawText) {
    return false;
  }
  const lower = rawText.toLowerCase();
  return [
    "no such file or directory",
    "file does not exist",
    "cannot read the image",
    "can't read the image",
    "still can't see the image",
  ].some((fragment) => lower.includes(fragment))
    || [
      "文件不存在",
      "附件文件仍然不存在",
      "读不到图",
      "看不到图",
      "没成功挂载",
      "图片还是没成功挂载",
      "我还是读不到图",
      "我看不到内容",
    ].some((fragment) => rawText.includes(fragment));
}

module.exports = {
  deliverToFeishu,
  handleCodexMessage,
  handleStopCommand,
  stripHiddenGoalStateDirectiveForDisplay,
};

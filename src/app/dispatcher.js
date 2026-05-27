const messageNormalizers = require("../presentation/message/normalizers");
const eventsRuntime = require("./codex-event-service");
const attachmentRuntime = require("../domain/attachments/attachment-service");
const attachmentDirectives = require("../domain/attachments/outbound-directive-service");
const { formatFailureText } = require("../shared/error-text");
const { createLogger } = require("../shared/logger");

const logger = createLogger("dispatcher");
const THIN_MODE_LOCAL_COMMANDS = new Set([
  "stop",
  "bind",
  "where",
  "doctor",
  "inspect_message",
  "help",
  "workspace",
  "switch",
  "remove",
  "send",
  "new",
  "model",
  "effort",
  "access",
  "profile",
  "goal",
  "appointment",
  "approve",
  "reject",
]);

async function onFeishuTextEvent(runtime, event) {
  event = await expandMergeForwardEvent(runtime, event);
  let normalized = messageNormalizers.normalizeFeishuTextEvent(event, runtime.config);
  if (!normalized) {
    return;
  }
  logger.info("received Feishu message", {
    chatId: normalized.chatId,
    messageId: normalized.messageId,
    command: normalized.command,
    messageType: normalized.messageType || "text",
    threadKey: normalized.threadKey || "",
  });

  normalized = await handleManualAttachmentDirectives(runtime, normalized);
  if (!normalized) {
    return;
  }
  normalized = coerceDirectModeCommandToMessage(normalized, runtime?.config);
  normalized = coerceThinModeCommandToMessage(normalized, runtime?.config);
  const hasThinLocalCommand = isThinBridgeMode(runtime?.config)
    && shouldHandleCommandLocallyInThinMode(normalized.command);
  const hasAttachmentPayload = normalized.command === "image_message"
    || normalized.command === "attachment_message"
    || (Array.isArray(normalized.attachments) && normalized.attachments.length > 0);
  if (!hasAttachmentPayload && hasThinLocalCommand && await runtime.dispatchTextCommand(normalized)) {
    return;
  }

  const shouldPassthrough = shouldPassthroughToCodex(normalized, runtime?.config);
  const shouldRunAppointmentPipeline = shouldRunAppointmentLocally(normalized, runtime?.config, shouldPassthrough);
  const shouldRunGoalPipeline = shouldRunGoalLocallyInThinMode(normalized, runtime?.config);
  const shouldRunPluginPipeline = shouldRunPluginRoutingLocally(normalized, runtime?.config, shouldPassthrough);
  const shouldRunLocalPipeline = (isStandardBridgeMode(runtime?.config) && !shouldPassthrough)
    || shouldRunAppointmentPipeline
    || shouldRunGoalPipeline
    || shouldRunPluginPipeline;

  if (shouldRunLocalPipeline) {
    if (
      shouldRunAppointmentPipeline
      && runtime?.config?.appointmentNaturalLanguageInterceptEnabled
      && typeof runtime.handlePotentialAppointmentMessage === "function"
    ) {
      normalized = await runtime.handlePotentialAppointmentMessage(normalized);
      if (!normalized) {
        return;
      }
    }
    if (
      shouldRunGoalPipeline
      && runtime?.config?.goalNaturalLanguageInterceptEnabled
      && typeof runtime.handlePotentialGoalMessage === "function"
    ) {
      normalized = await runtime.handlePotentialGoalMessage(normalized);
      if (!normalized) {
        return;
      }
    }
    if (
      shouldRunPluginPipeline
      && runtime?.config?.pluginRouteInterceptEnabled
      && typeof runtime.handlePotentialPluginIntentMessage === "function"
    ) {
      normalized = await runtime.handlePotentialPluginIntentMessage(normalized);
      if (!normalized) {
        return;
      }
    }
    normalized = await runtime.runBeforeMessageHook({
      event,
      normalized,
      runtime,
    });
    if (!normalized) {
      return;
    }
  }
  normalized = coerceMergeForwardMessage(event, normalized, runtime?.config);
  normalized = coerceDirectModeUnsupportedMessage(event, normalized, runtime?.config);
  if (normalized.command === "unsupported_message") {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildUnsupportedMessageText(normalized.unsupportedMessageType),
    });
    return;
  }

  if (!hasAttachmentPayload && !shouldPassthrough && await runtime.dispatchTextCommand(normalized)) {
    return;
  }

  if (!canSendToCodex(runtime)) {
    return;
  }

  const currentThreadContext = resolveCurrentThreadContext(runtime, normalized);
  const bindingKey = currentThreadContext.bindingKey;
  const workspaceRoot = currentThreadContext.workspaceRoot || "";
  const isImageMessage = normalized.command === "image_message";
  if (hasAttachmentPayload) {
    normalized = await attachmentRuntime.prepareAttachmentMessage(runtime, normalized, {
      workspaceRoot,
      expectedKind: isImageMessage ? "image" : "",
    });
    if (!normalized) {
      return;
    }
  }

  const { threadId } = workspaceRoot
    ? await runtime.resolveWorkspaceThreadState({
      bindingKey,
      workspaceRoot,
      normalized,
      autoSelectThread: true,
    })
    : { threadId: currentThreadContext.threadId || "" };

  if (threadId && runtime.activeTurnIdByThreadId.has(threadId)) {
    if (runtime.pendingApprovalByThreadId.has(threadId)) {
      const prompted = await runtime.sendApprovalPrompt({
        threadId,
        normalized,
        reason: "blocked-message",
      });
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: prompted
          ? "上一条还在等授权。我已经把授权卡重新发出来了；也可以直接发 `/codex approve` 或 `/codex reject`。"
          : "上一条还在等授权。可以直接发 `/codex approve` 允许本次请求，或发 `/codex reject` 拒绝。",
        kind: "approval",
      });
      return;
    }
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前线程还有任务在运行。请先等待完成，或发送 `/codex stop` 中断后再发新消息。",
    });
    return;
  }

  runtime.setPendingBindingContext(bindingKey, normalized);
  if (threadId) {
    runtime.setPendingThreadContext(threadId, normalized);
  }

  await runtime.addPendingReaction(bindingKey, normalized.messageId);

  try {
    const resolvedThreadId = await runtime.ensureThreadAndSendMessage({
      bindingKey,
      workspaceRoot,
      normalized,
      threadId,
    });
    runtime.movePendingReactionToThread(bindingKey, resolvedThreadId);
  } catch (error) {
    await runtime.clearPendingReactionForBinding(bindingKey);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("处理失败", error),
    });
    throw error;
  }
}

function canSendToCodex(runtime) {
  return Boolean(
    runtime
    && typeof runtime.ensureThreadAndSendMessage === "function"
    && typeof runtime.setPendingBindingContext === "function"
    && typeof runtime.setPendingThreadContext === "function"
    && typeof runtime.addPendingReaction === "function"
    && typeof runtime.movePendingReactionToThread === "function"
    && typeof runtime.clearPendingReactionForBinding === "function"
  );
}

function resolveCurrentThreadContext(runtime, normalized) {
  if (typeof runtime.getCurrentThreadContext === "function") {
    return runtime.getCurrentThreadContext(normalized) || {};
  }
  if (typeof runtime.getBindingContext === "function") {
    const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized) || {};
    return { bindingKey, workspaceRoot, threadId: "" };
  }
  return { bindingKey: "", workspaceRoot: "", threadId: "" };
}

function shouldPassthroughToCodex(normalized, config) {
  const passthroughEnabled = isThinBridgeMode(config)
    || isDirectBridgeMode(config)
    || config?.bridgePassthroughToCodex !== false;
  if (!passthroughEnabled) {
    return false;
  }

  const command = String(normalized?.command || "").trim().toLowerCase();
  if (!command) {
    return false;
  }

  if (isDirectBridgeMode(config)) {
    return true;
  }

  if (
    command === "message"
    || command === "image_message"
    || command === "attachment_message"
  ) {
    return true;
  }

  return false;
}

function isThinBridgeMode(config) {
  return getBridgeMode(config) === "thin";
}

function isStandardBridgeMode(config) {
  return getBridgeMode(config) === "standard";
}

function isDirectBridgeMode(config) {
  return getBridgeMode(config) === "direct";
}

function getBridgeMode(config) {
  return String(config?.bridgeMode || "thin").trim().toLowerCase();
}

function shouldHandleCommandLocallyInThinMode(command) {
  return THIN_MODE_LOCAL_COMMANDS.has(String(command || "").trim().toLowerCase());
}

function shouldRunAppointmentLocally(normalized, config, shouldPassthrough) {
  if (!normalized || isDirectBridgeMode(config)) {
    return false;
  }
  const command = String(normalized.command || "").trim().toLowerCase();

  if (isThinBridgeMode(config)) {
    if (command === "appointment") {
      return true;
    }
    if (command !== "message") {
      return false;
    }
    return Boolean(config?.appointmentNaturalLanguageInterceptEnabled);
  }

  if (!isStandardBridgeMode(config) || shouldPassthrough || command !== "message") {
    return false;
  }
  return Boolean(config?.appointmentNaturalLanguageInterceptEnabled);
}

function shouldRunGoalLocallyInThinMode(normalized, config) {
  if (!isThinBridgeMode(config) || !normalized) {
    return false;
  }
  const command = String(normalized.command || "").trim().toLowerCase();
  if (command !== "message") {
    return false;
  }
  return Boolean(config?.goalNaturalLanguageInterceptEnabled);
}

function shouldRunPluginRoutingLocally(_normalized, config, shouldPassthrough) {
  return isStandardBridgeMode(config)
    && !shouldPassthrough
    && Boolean(config?.pluginRouteInterceptEnabled);
}

function coerceThinModeCommandToMessage(normalized, config) {
  if (!isThinBridgeMode(config) || !normalized) {
    return normalized;
  }

  const command = String(normalized.command || "").trim().toLowerCase();
  if (!command || command === "message" || shouldHandleCommandLocallyInThinMode(command)) {
    return normalized;
  }

  return {
    ...normalized,
    command: "message",
    bridgeOriginalCommand: normalized.command,
  };
}

function coerceDirectModeCommandToMessage(normalized, config) {
  if (!isDirectBridgeMode(config) || !normalized) {
    return normalized;
  }
  const command = String(normalized.command || "").trim().toLowerCase();
  if (
    !command
    || command === "message"
    || command === "image_message"
    || command === "attachment_message"
    || command === "unsupported_message"
  ) {
    return normalized;
  }
  return {
    ...normalized,
    command: "message",
    bridgeOriginalCommand: normalized.command,
  };
}

async function expandMergeForwardEvent(runtime, event) {
  const message = getFeishuEventMessage(event);
  const messageType = String(message?.message_type || "").trim().toLowerCase();
  if (messageType !== "merge_forward") {
    return event;
  }
  if (!runtime || typeof runtime.requireFeishuAdapter !== "function") {
    return event;
  }

  try {
    const feishuAdapter = runtime.requireFeishuAdapter();
    const parentMessages = await feishuAdapter.getMessage({
      messageId: message.message_id,
    });
    const parentMessage = Array.isArray(parentMessages) ? parentMessages[0] || {} : {};
    const chatId = String(message.chat_id || parentMessage.chat_id || "").trim();
    if (!chatId) {
      return event;
    }
    const upperMessageId = String(message.message_id || "").trim();

    const forwardedItems = mergeForwardedMessageItems([
      ...collectForwardedMessageItemsFromGetResponse(parentMessages, { upperMessageId }),
      ...await collectForwardedMessageItems(feishuAdapter, { chatId, upperMessageId }),
    ]);
    if (!forwardedItems.length) {
      return withMergeForwardExpansionNote(event, {
        note: [
          "This is a merged-forwarded Feishu message. The bridge tried to expand the child messages but did not receive any readable child content.",
          "If this is a group merge-forward, confirm the bot is inside the group and has `im:message.group_msg` so it can read group history.",
          "Codex can only see the title or summary right now. If you need exact handling, open the merged-forwarded message in Feishu and resend the original text or files directly.",
        ].join(" "),
        status: "empty",
      });
    }

    const forwardedText = messageNormalizers.normalizeFeishuForwardedMessageItems(forwardedItems);
    if (!forwardedText) {
      return event;
    }

    const originalContent = parseMessageContent(message.content);
    const mergedContent = {
      ...(originalContent && typeof originalContent === "object" ? originalContent : {}),
      forwarded_items: forwardedItems,
      forwarded_text: forwardedText,
    };
    return {
      ...setFeishuEventMessage(event, {
        ...message,
        content: JSON.stringify(mergedContent),
      }),
    };
  } catch (error) {
    logger.warn("failed to expand Feishu merge_forward message", {
      messageId: message?.message_id || "",
      error,
    });
    return withMergeForwardExpansionNote(event, {
      note: [
        "This is a merged-forwarded Feishu message. The bridge tried to expand the child messages but the Feishu API request failed, so Codex cannot see the forwarded body yet.",
        "If this is a group merge-forward, confirm the bot is inside the group and has `im:message.group_msg` plus the normal message-read scope.",
        "If you need exact handling, open the merged-forwarded message in Feishu and resend the original text or files directly.",
      ].join(" "),
      status: "error",
    });
  }
}

async function collectForwardedMessageItems(feishuAdapter, { chatId, upperMessageId }) {
  const items = [];
  const seenMessageIds = new Set();
  let pageToken = "";
  let pageCount = 0;

  while (pageCount < 5) {
    const response = await feishuAdapter.listMessages({
      containerIdType: "chat",
      containerId: chatId,
      sortType: "ByCreateTimeDesc",
      pageSize: 50,
      pageToken,
    });
    const pageItems = Array.isArray(response?.items) ? response.items : [];
    for (const item of pageItems) {
      const currentMessageId = String(item?.message_id || "").trim();
      if (!currentMessageId || seenMessageIds.has(currentMessageId)) {
        continue;
      }
      seenMessageIds.add(currentMessageId);
      if (String(item?.upper_message_id || "").trim() === upperMessageId) {
        items.push(item);
      }
    }
    if (!response?.hasMore || !String(response?.pageToken || "").trim()) {
      break;
    }
    pageToken = String(response.pageToken).trim();
    pageCount += 1;
  }

  return items;
}

function collectForwardedMessageItemsFromGetResponse(messages, { upperMessageId }) {
  const items = Array.isArray(messages) ? messages : [];
  return items.filter((item) => String(item?.upper_message_id || "").trim() === upperMessageId);
}

function mergeForwardedMessageItems(items) {
  const merged = [];
  const seen = new Set();
  for (const item of items) {
    const messageId = String(item?.message_id || "").trim();
    if (!messageId || seen.has(messageId)) {
      continue;
    }
    seen.add(messageId);
    merged.push(item);
  }
  return merged;
}

function parseMessageContent(rawContent) {
  try {
    return JSON.parse(rawContent || "{}");
  } catch {
    return {};
  }
}

function withMergeForwardExpansionNote(event, { note = "", status = "" } = {}) {
  const message = getFeishuEventMessage(event);
  const originalContent = parseMessageContent(message.content);
  const nextContent = {
    ...(originalContent && typeof originalContent === "object" ? originalContent : {}),
    forwarded_expand_note: String(note || "").trim(),
    forwarded_expand_status: String(status || "").trim(),
  };
  return setFeishuEventMessage(event, {
    ...message,
    content: JSON.stringify(nextContent),
  });
}

function coerceMergeForwardMessage(event, normalized, config) {
  if (isDirectBridgeMode(config)) {
    return normalized;
  }
  const normalizedType = String(normalized?.messageType || "").trim().toLowerCase();
  const unsupportedType = String(normalized?.unsupportedMessageType || "").trim().toLowerCase();
  const eventType = String(getFeishuEventMessage(event)?.message_type || "").trim().toLowerCase();
  const isMergeForward = normalizedType === "merge_forward"
    || unsupportedType === "merge_forward"
    || eventType === "merge_forward";
  if (!isMergeForward || !normalized) {
    return normalized;
  }

  const reparsed = messageNormalizers.normalizeFeishuTextEvent(event, config || {});
  const recoveredText = String(normalized?.text || "").trim()
    || String(reparsed?.text || "").trim()
    || buildMergeForwardRecoveryText(event);
  if (normalized?.command !== "message" || normalizedType !== "merge_forward" || !String(normalized?.text || "").trim()) {
    logger.warn("coercing merge_forward message back to plain message flow", {
      messageId: normalized?.messageId || event?.message?.message_id || "",
      command: normalized?.command || "",
      messageType: normalized?.messageType || "",
      unsupportedMessageType: normalized?.unsupportedMessageType || "",
    });
  }
  return {
    ...normalized,
    ...(reparsed || {}),
    messageType: "merge_forward",
    command: "message",
    text: recoveredText,
    unsupportedMessageType: "",
    mergeForwardStatus: String(normalized?.mergeForwardStatus || reparsed?.mergeForwardStatus || "").trim() || "received",
  };
}

function buildMergeForwardRecoveryText(event) {
  const message = getFeishuEventMessage(event);
  const content = parseMessageContent(message.content);
  const title = String(content?.title || "").trim();
  const summary = String(content?.summary || "").trim();
  const lines = [
    "A Feishu merged-forward message arrived through the bridge.",
    "The bridge should keep routing this message into Codex even when child-message expansion is incomplete.",
    "If you need exact handling and the forwarded body is still missing, ask the user to expand the merged-forward message in Feishu and resend the original text or files directly.",
  ];
  if (title) {
    lines.push(`Title: ${title}`);
  }
  if (summary) {
    lines.push(`Summary: ${summary}`);
  }
  return lines.join("\n");
}

function coerceDirectModeUnsupportedMessage(event, normalized, config) {
  if (!isDirectBridgeMode(config) || !normalized || normalized.command !== "unsupported_message") {
    return normalized;
  }

  const reparsed = messageNormalizers.normalizeFeishuTextEvent(event, config || {});
  const recoveredText = String(normalized?.text || "").trim() || String(reparsed?.text || "").trim();
  const eventType = String(getFeishuEventMessage(event)?.message_type || "").trim().toLowerCase();
  return {
    ...normalized,
    ...(reparsed || {}),
    command: "message",
    messageType: String(
      normalized?.messageType
      || reparsed?.messageType
      || normalized?.unsupportedMessageType
      || eventType
      || "unknown"
    ).trim(),
    text: recoveredText,
    unsupportedMessageType: "",
  };
}

function getFeishuEventMessage(event) {
  return event?.message || event?.event?.message || {};
}

function setFeishuEventMessage(event, nextMessage) {
  if (event?.message || !event?.event) {
    return {
      ...event,
      message: nextMessage,
    };
  }
  return {
    ...event,
    event: {
      ...event.event,
      message: nextMessage,
    },
  };
}

async function handleManualAttachmentDirectives(runtime, normalized) {
  if (isDirectBridgeMode(runtime?.config)) {
    return normalized;
  }
  if (normalized?.command !== "message") {
    return normalized;
  }
  const messageType = String(normalized?.messageType || "text").trim().toLowerCase();
  if (messageType !== "text") {
    return normalized;
  }

  const directives = attachmentDirectives.extractSendDirectives(normalized.text);
  if (!directives.length) {
    return normalized;
  }

  const workspaceContext = await runtime.resolveWorkspaceContext(normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
  });
  if (!workspaceContext) {
    return null;
  }

  const result = await attachmentDirectives.handleManualAttachmentDirectives(runtime, {
    messageId: normalized.messageId,
    chatId: normalized.chatId,
    workspaceRoot: workspaceContext.workspaceRoot,
    text: normalized.text,
  });
  const nextText = String(result.text || "").trim();
  if (!nextText) {
    return null;
  }

  return {
    ...normalized,
    text: nextText,
  };
}

function buildUnsupportedMessageText(messageType) {
  const typeLabel = String(messageType || "unknown");
  if (typeLabel === "image") {
    return [
      "我收到图片了，但飞书图片解析还没接上。",
      "",
      "现在这条桥只处理文字消息，所以图片不会进入 Codex。",
      "临时办法：先把图片里的重点用文字发给我，或者在桌面端直接给 Codex 发图。",
      "",
      "我已经把“图片消息不要静默丢弃”修好了，下一步再接图片下载和多模态输入。",
    ].join("\n");
  }
  return [
    `我收到了非文本消息：\`${typeLabel}\`。`,
    "",
    "当前飞书桥暂时只处理文字消息；这类消息还不会进入 Codex。",
  ].join("\n");
}

async function onFeishuCardAction(runtime, data) {
  try {
    return await runtime.handleCardAction(data);
  } catch (error) {
    console.error(`[codex-im] failed to process card action: ${error.message}`);
    return runtime.buildCardToast(formatFailureText("处理失败", error));
  }
}

function onCodexMessage(runtime, message) {
  eventsRuntime.handleCodexMessage(runtime, message);
}

module.exports = {
  collectForwardedMessageItems,
  coerceDirectModeUnsupportedMessage,
  coerceDirectModeCommandToMessage,
  expandMergeForwardEvent,
  handleManualAttachmentDirectives,
  isDirectBridgeMode,
  coerceThinModeCommandToMessage,
  isThinBridgeMode,
  onCodexMessage,
  onFeishuCardAction,
  onFeishuTextEvent,
  shouldHandleCommandLocallyInThinMode,
  shouldPassthroughToCodex,
};

const codexMessageUtils = require("../../infra/codex/message-utils");

const RICH_TEXT_MESSAGE_TYPES = new Set([
  "interactive",
  "card",
  "share_chat",
  "share_user",
  "merge_forward",
  "forward",
]);
const NON_TEXT_CONTENT_PREVIEW_CHARS = 8000;

function normalizeFeishuTextEvent(event, config) {
  const { message, sender } = resolveFeishuEventEnvelope(event);
  if (message.message_type !== "text") {
    return normalizeFeishuNonTextEvent(message, sender, config);
  }

  const text = parseFeishuMessageText(message.content);
  if (!text) {
    return null;
  }

  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId: message.chat_id || "",
    threadKey: message.root_id || "",
    senderId: sender?.sender_id?.open_id || sender?.sender_id?.user_id || "",
    messageId: message.message_id || "",
    messageType: "text",
    text,
    command: resolveTextCommand(text, config),
    receivedAt: new Date().toISOString(),
  };
}

function normalizeFeishuNonTextEvent(message, sender, config) {
  const messageType = typeof message.message_type === "string" ? message.message_type.trim() : "";
  if (!messageType) {
    return null;
  }
  const attachments = extractFeishuMessageAttachments(messageType, message.content);
  const extractedText = parseFeishuNonTextMessageText(messageType, message.content);
  const senderId = sender?.sender_id?.open_id || sender?.sender_id?.user_id || "";
  const mergeForwardMeta = extractMergeForwardMeta(messageType, message.content);
  const command = resolveFeishuNonTextCommand(messageType, extractedText, attachments, config);
  const text = shouldUseStructuredNonTextText(messageType, extractedText, attachments)
    ? buildStructuredNonTextMessageText({
      messageType,
      rawContent: message.content,
      extractedText,
      mergeForwardMeta,
      chatId: message.chat_id || "",
      threadKey: message.root_id || "",
      senderId,
      messageId: message.message_id || "",
    })
    : extractedText;
  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId: message.chat_id || "",
    threadKey: message.root_id || "",
    senderId,
    messageId: message.message_id || "",
    messageType,
    text,
    command,
    attachments,
    ...mergeForwardMeta,
    receivedAt: new Date().toISOString(),
  };
}

function resolveFeishuEventEnvelope(event) {
  if (event?.message || event?.sender) {
    return {
      message: event?.message || {},
      sender: event?.sender || {},
    };
  }
  return {
    message: event?.event?.message || {},
    sender: event?.event?.sender || {},
  };
}

function resolveTextCommand(text, config) {
  if (isDirectBridgeMode(config)) {
    return "message";
  }
  return parseCommand(text);
}

function normalizeFeishuForwardedMessageItems(items = []) {
  const forwardedItems = Array.isArray(items) ? items : [];
  if (!forwardedItems.length) {
    return "";
  }
  const sections = [];
  for (const item of forwardedItems) {
    const block = formatForwardedMessageItem(item);
    if (block) {
      sections.push(block);
    }
  }
  return sections.join("\n\n").trim();
}

function extractCardAction(data) {
  const action = data?.action || {};
  const value = action.value || {};
  if (!value.kind) {
    console.log("[codex-im] card callback action missing kind", {
      action,
      hasValue: !!action.value,
    });
    return null;
  }

  if (value.kind === "approval") {
    return {
      kind: value.kind,
      decision: value.decision,
      scope: value.scope || "once",
      requestId: value.requestId,
      threadId: value.threadId,
    };
  }
  if (value.kind === "panel") {
    const selectedValue = extractCardSelectedValue(action, value);
    return {
      kind: value.kind,
      action: value.action || "",
      selectedValue,
    };
  }
  if (value.kind === "thread") {
    return {
      kind: value.kind,
      action: value.action || "",
      threadId: value.threadId || "",
    };
  }
  if (value.kind === "workspace") {
    return {
      kind: value.kind,
      action: value.action || "",
      workspaceRoot: value.workspaceRoot || "",
    };
  }
  if (value.kind === "appointment") {
    return {
      kind: value.kind,
      action: value.action || "",
      draftId: value.draftId || "",
      chatScopeKey: value.chatScopeKey || "",
    };
  }
  return null;
}

function normalizeCardActionContext(data, config) {
  const messageId = normalizeIdentifier(data?.context?.open_message_id);
  const chatId = extractCardChatId(data);
  const senderId = normalizeIdentifier(data?.operator?.open_id);

  if (!chatId || !messageId || !senderId) {
    console.log("[codex-im] card callback missing required context", {
      context_open_message_id: data?.context?.open_message_id,
      context_open_chat_id: data?.context?.open_chat_id,
      operator_open_id: data?.operator?.open_id,
    });
    return null;
  }

  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId,
    threadKey: "",
    senderId,
    messageId,
    text: "",
    command: "",
    receivedAt: new Date().toISOString(),
  };
}

function mapCodexMessageToImEvent(message) {
  return codexMessageUtils.mapCodexMessageToImEvent(message);
}

function parseFeishuMessageText(rawContent) {
  const parsed = parseFeishuMessageContent(rawContent);
  return typeof parsed.text === "string" ? parsed.text.trim() : "";
}

function parseFeishuMessageContent(rawContent) {
  try {
    return JSON.parse(rawContent || "{}");
  } catch {
    return {};
  }
}

function extractFeishuMessageAttachments(messageType, rawContent) {
  const parsed = parseFeishuMessageContent(rawContent);
  if (messageType === "image") {
    const imageKey = normalizeIdentifier(parsed.image_key || parsed.imageKey || parsed.file_key || parsed.fileKey);
    return imageKey
      ? [{
        kind: "image",
        resourceKey: imageKey,
        resourceType: "image",
      }]
      : [];
  }
  if (messageType === "post") {
    return extractPostImageKeys(parsed).map((resourceKey) => ({
      kind: "image",
      resourceKey,
      resourceType: "image",
    }));
  }
  if (messageType === "file") {
    const resourceKey = normalizeIdentifier(parsed.file_key || parsed.fileKey);
    return resourceKey
      ? [{
        kind: "file",
        resourceKey,
        resourceType: "file",
        fileName: normalizeIdentifier(parsed.file_name || parsed.fileName || parsed.name),
        fileSize: normalizeNumber(parsed.file_size || parsed.fileSize || parsed.size),
        fileType: normalizeIdentifier(parsed.file_type || parsed.fileType),
      }]
      : [];
  }
  if (messageType === "audio" || messageType === "voice") {
    const resourceKey = normalizeIdentifier(parsed.file_key || parsed.fileKey);
    return resourceKey
      ? [{
        kind: "audio",
        resourceKey,
        resourceType: "file",
        fileName: normalizeIdentifier(parsed.file_name || parsed.fileName || parsed.name) || "audio.opus",
        fileSize: normalizeNumber(parsed.file_size || parsed.fileSize || parsed.size),
        fileType: normalizeIdentifier(parsed.file_type || parsed.fileType),
        duration: normalizeNumber(parsed.duration),
      }]
      : [];
  }
  if (messageType === "media") {
    const resourceKey = normalizeIdentifier(parsed.file_key || parsed.fileKey || parsed.media_key || parsed.mediaKey);
    return resourceKey
      ? [{
        kind: "audio",
        resourceKey,
        resourceType: "media",
        fileName: normalizeIdentifier(parsed.file_name || parsed.fileName || parsed.name) || "media.mp4",
        fileSize: normalizeNumber(parsed.file_size || parsed.fileSize || parsed.size),
        fileType: normalizeIdentifier(parsed.file_type || parsed.fileType) || "mp4",
        duration: normalizeNumber(parsed.duration),
      }]
      : [];
  }
  return [];
}

function parseFeishuNonTextMessageText(messageType, rawContent) {
  const parsed = parseFeishuMessageContent(rawContent);
  if (messageType === "post") {
    return extractPostPlainText(parsed).trim();
  }
  if (messageType === "merge_forward") {
    const forwardedText = normalizeIdentifier(parsed.forwarded_text);
    if (forwardedText) {
      return forwardedText;
    }
    if (Array.isArray(parsed.forwarded_items)) {
      const summarized = normalizeFeishuForwardedMessageItems(parsed.forwarded_items);
      if (summarized) {
        return summarized;
      }
    }
  }
  if (RICH_TEXT_MESSAGE_TYPES.has(messageType)) {
    return extractRichMessageText(parsed).trim();
  }
  return "";
}

function extractMergeForwardMeta(messageType, rawContent) {
  if (messageType !== "merge_forward") {
    return {};
  }
  const parsed = parseFeishuMessageContent(rawContent);
  const forwardedText = normalizeIdentifier(parsed.forwarded_text);
  const forwardedItems = Array.isArray(parsed.forwarded_items) ? parsed.forwarded_items : [];
  const forwardedExpandStatus = normalizeIdentifier(parsed.forwarded_expand_status);
  const mergeForwardStatus = forwardedExpandStatus || (
    forwardedText || forwardedItems.length ? "expanded" : "received"
  );
  return {
    mergeForwardStatus,
    mergeForwardTitle: normalizeIdentifier(parsed.title),
    mergeForwardSummary: normalizeIdentifier(parsed.summary),
    mergeForwardExpandNote: normalizeIdentifier(parsed.forwarded_expand_note),
  };
}

function resolveFeishuNonTextCommand(messageType, text, attachments, config) {
  const hasText = Boolean(String(text || "").trim());
  if (hasText) {
    // Slash commands should only be executed from direct text/post input.
    // Forwarded cards and shared entities are user content, not bridge control.
    return messageType === "post" ? resolveTextCommand(text, config) : "message";
  }
  if (attachments.some((attachment) => attachment?.kind === "image")) {
    return "image_message";
  }
  if (attachments.length) {
    return "attachment_message";
  }
  return "message";
}

function shouldUseStructuredNonTextText(messageType, text, attachments) {
  if (attachments.length) {
    return false;
  }
  if (messageType === "post" && String(text || "").trim()) {
    return false;
  }
  return true;
}

function buildStructuredNonTextMessageText({
  messageType,
  rawContent,
  extractedText = "",
  mergeForwardMeta = {},
  chatId = "",
  threadKey = "",
  senderId = "",
  messageId = "",
}) {
  const lines = [];
  const normalizedExtractedText = neutralizeBridgeDirectives(String(extractedText || "").trim());
  if (normalizedExtractedText) {
    lines.push(normalizedExtractedText);
    lines.push("");
  }
  lines.push("[System note: A Feishu/Lark non-text message arrived through the bridge and should be treated as user-provided context.]");
  lines.push(`Message type: ${messageType || "unknown"}`);
  lines.push(`Message ID: ${messageId || "unknown"}`);
  lines.push(`Chat ID: ${chatId || "unknown"}`);
  if (threadKey) {
    lines.push(`Thread key: ${threadKey}`);
  }
  if (senderId) {
    lines.push(`Sender: ${senderId}`);
  }
  if (messageType === "merge_forward") {
    const status = normalizeIdentifier(mergeForwardMeta?.mergeForwardStatus);
    const title = normalizeIdentifier(mergeForwardMeta?.mergeForwardTitle);
    const summary = normalizeIdentifier(mergeForwardMeta?.mergeForwardSummary);
    const expandNote = normalizeIdentifier(mergeForwardMeta?.mergeForwardExpandNote);
    if (status) {
      lines.push(`Merge-forward status: ${status}`);
    }
    if (title && !normalizedExtractedText.includes(title)) {
      lines.push(`Merge-forward title: ${title}`);
    }
    if (summary) {
      lines.push(`Merge-forward summary: ${summary}`);
    }
    if (expandNote) {
      lines.push(`Bridge note: ${expandNote}`);
    }
  }

  const preview = buildNonTextContentPreview(rawContent);
  if (preview) {
    lines.push("");
    lines.push("Content preview:");
    lines.push(preview);
  }
  return lines.join("\n").trim();
}

function buildNonTextContentPreview(rawContent) {
  const parsed = parseMaybeJson(rawContent);
  const source = parsed || String(rawContent || "").trim();
  if (!source) {
    return "";
  }
  let text = "";
  if (typeof source === "string") {
    text = source;
  } else {
    try {
      text = JSON.stringify(source, null, 2);
    } catch {
      text = String(rawContent || "").trim();
    }
  }
  return truncateNonTextPreview(neutralizeBridgeDirectives(text));
}

function formatForwardedMessageItem(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  const type = normalizeIdentifier(item.msg_type || item.message_type || item.type) || "unknown";
  const contentText = extractForwardedItemContentText(item);
  const senderName = extractForwardedItemSenderName(item);
  const timestamp = normalizeIdentifier(item.create_time || item.createTime);
  const lines = [];
  lines.push(`Forwarded item (${type})`);
  if (senderName) {
    lines.push(`Sender: ${senderName}`);
  }
  if (timestamp) {
    lines.push(`Created: ${timestamp}`);
  }
  if (contentText) {
    lines.push("");
    lines.push(contentText);
  }
  return lines.join("\n").trim();
}

function extractForwardedItemContentText(item) {
  const rawBody = item?.body?.content;
  const parsedBody = parseFeishuMessageContent(rawBody);
  const messageType = normalizeIdentifier(item?.msg_type || item?.message_type || item?.type).toLowerCase();
  if (messageType === "text") {
    return neutralizeBridgeDirectives(parseFeishuMessageText(rawBody));
  }
  if (messageType === "post") {
    return neutralizeBridgeDirectives(extractPostPlainText(parsedBody).trim());
  }
  if (RICH_TEXT_MESSAGE_TYPES.has(messageType)) {
    const richText = normalizeFeishuForwardedSummary(parsedBody);
    if (richText) {
      return richText;
    }
    return neutralizeBridgeDirectives(extractRichMessageText(parsedBody).trim());
  }
  const fallback = buildNonTextContentPreview(rawBody);
  return fallback ? neutralizeBridgeDirectives(fallback) : "";
}

function normalizeFeishuForwardedSummary(parsedBody) {
  if (!parsedBody || typeof parsedBody !== "object") {
    return "";
  }
  const summaryText = extractRichMessageText(parsedBody).trim();
  return summaryText ? neutralizeBridgeDirectives(summaryText) : "";
}

function extractForwardedItemSenderName(item) {
  const sender = item?.sender || {};
  return normalizeIdentifier(
    sender?.name
      || sender?.sender_name
      || sender?.id
      || sender?.sender_id
  );
}

function neutralizeBridgeDirectives(text) {
  return String(text || "")
    .replace(/\[\[codex-feishu-send:/g, "[codex-feishu-send:")
    .replace(/\[\[yuan-feishu-send:/g, "[yuan-feishu-send:");
}

function truncateNonTextPreview(text) {
  const source = String(text || "");
  if (source.length <= NON_TEXT_CONTENT_PREVIEW_CHARS) {
    return source;
  }
  return `${source.slice(0, NON_TEXT_CONTENT_PREVIEW_CHARS)}\n[...truncated...]`;
}

function extractRichMessageText(parsed) {
  const fragments = [];
  collectRichTextFragments(parsed, fragments, new Set());
  return compactRichTextFragments(fragments);
}

function collectRichTextFragments(value, fragments, seen) {
  if (!value) {
    return;
  }
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value);
    if (parsed && parsed !== value) {
      collectRichTextFragments(parsed, fragments, seen);
      return;
    }
    const clean = value.trim();
    if (clean && !looksLikeOpaqueResourceValue(clean)) {
      fragments.push(clean);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRichTextFragments(item, fragments, seen);
    }
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);

  const tag = normalizeIdentifier(value.tag).toLowerCase();
  const candidateKeys = tag === "markdown"
    ? ["content", "text", "title"]
    : ["text", "content", "title", "subtitle", "desc", "description"];
  for (const key of candidateKeys) {
    const item = value[key];
    if (typeof item === "string" && item.trim() && !looksLikeOpaqueResourceValue(item)) {
      fragments.push(item.trim());
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (["url", "href", "image_key", "imageKey", "file_key", "fileKey", "open_id", "openId"].includes(key)) {
      continue;
    }
    if (child && typeof child === "object") {
      collectRichTextFragments(child, fragments, seen);
    }
  }
}

function parseMaybeJson(value) {
  const clean = String(value || "").trim();
  if (!(clean.startsWith("{") || clean.startsWith("["))) {
    return null;
  }
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function looksLikeOpaqueResourceValue(value) {
  const clean = String(value || "").trim();
  return (
    /^img_[A-Za-z0-9_-]{8,}$/.test(clean)
    || /^file_[A-Za-z0-9_-]{8,}$/.test(clean)
    || /^om_[A-Za-z0-9_-]{8,}$/.test(clean)
  );
}

function compactRichTextFragments(fragments) {
  const result = [];
  for (const fragment of fragments) {
    const clean = String(fragment || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) {
      continue;
    }
    if (result.some((existing) => existing === clean || existing.includes(clean))) {
      continue;
    }
    result.push(clean);
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}

function extractPostPlainText(parsed) {
  const content = findPostContentRows(parsed);
  if (Array.isArray(content)) {
    const lines = content
      .map((row) => extractPostText(row).trimEnd())
      .filter((line) => line.trim());
    if (lines.length) {
      return lines.join("\n").replace(/\n{3,}/g, "\n\n");
    }
  }
  return extractPostText(parsed).trim();
}

function findPostContentRows(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value?.content)) {
    return value.content;
  }
  if (value.post && typeof value.post === "object") {
    for (const localeValue of Object.values(value.post)) {
      const rows = findPostContentRows(localeValue);
      if (rows) {
        return rows;
      }
    }
  }
  return null;
}

function extractPostImageKeys(value, result = []) {
  if (!value) {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractPostImageKeys(item, result);
    }
    return dedupeStrings(result);
  }
  if (typeof value !== "object") {
    return result;
  }

  const tag = normalizeIdentifier(value.tag).toLowerCase();
  const imageKey = normalizeIdentifier(
    value.image_key
      || value.imageKey
      || value.file_key
      || value.fileKey
      || (tag === "img" ? value.key : "")
  );
  if (imageKey) {
    result.push(imageKey);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      extractPostImageKeys(child, result);
    }
  }
  return dedupeStrings(result);
}

function extractPostText(value, fragments = []) {
  if (!value) {
    return fragments.join("").replace(/\n{3,}/g, "\n\n");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractPostText(item, fragments);
    }
    return fragments.join("").replace(/\n{3,}/g, "\n\n");
  }
  if (typeof value !== "object") {
    return fragments.join("").replace(/\n{3,}/g, "\n\n");
  }

  const tag = normalizeIdentifier(value.tag).toLowerCase();
  if (tag === "text" && typeof value.text === "string") {
    fragments.push(value.text);
  } else if ((tag === "a" || tag === "at") && typeof value.text === "string") {
    fragments.push(value.text);
  } else if (tag === "br") {
    fragments.push("\n");
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      extractPostText(child, fragments);
    }
  }
  return fragments.join("").replace(/\n{3,}/g, "\n\n");
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseCommand(text) {
  const normalized = text.trim().toLowerCase();
  const prefixes = ["/codex "];
  const exactPrefixes = ["/codex"];
  const goalPrefixes = ["/goal "];
  const goalExactPrefixes = ["/goal"];
  const appointmentPrefixes = ["/预约 ", "/appoint "];
  const appointmentExactPrefixes = ["/预约", "/appoint"];

  const exactCommands = {
    stop: ["stop"],
    where: ["where"],
    doctor: ["doctor"],
    inspect_message: ["message"],
    help: ["help"],
    workspace: ["workspace"],
    remove: ["remove"],
    send: ["send"],
    new: ["new"],
    model: ["model"],
    effort: ["effort"],
    access: ["access"],
    profile: ["profile"],
    skill: ["skill"],
    plugin: ["plugin"],
    score: ["score"],
    eval: ["eval"],
    approve: ["approve", "approve workspace"],
    reject: ["reject"],
  };

  for (const [command, suffixes] of Object.entries(exactCommands)) {
    if (matchesExactCommand(normalized, suffixes)) {
      return command;
    }
  }

  if (matchesPrefixCommand(normalized, "switch")) {
    return "switch";
  }
  if (matchesPrefixCommand(normalized, "remove")) {
    return "remove";
  }
  if (matchesPrefixCommand(normalized, "send")) {
    return "send";
  }
  if (matchesPrefixCommand(normalized, "bind")) {
    return "bind";
  }
  if (matchesPrefixCommand(normalized, "model")) {
    return "model";
  }
  if (matchesPrefixCommand(normalized, "effort")) {
    return "effort";
  }
  if (matchesPrefixCommand(normalized, "access")) {
    return "access";
  }
  if (matchesPrefixCommand(normalized, "profile")) {
    return "profile";
  }
  if (matchesPrefixCommand(normalized, "skill")) {
    return "skill";
  }
  if (matchesPrefixCommand(normalized, "plugin")) {
    return "plugin";
  }
  if (matchesPrefixCommand(normalized, "score")) {
    return "score";
  }
  if (matchesPrefixCommand(normalized, "eval")) {
    return "eval";
  }
  if (normalized.startsWith("/codexplugin")) {
    return "plugin";
  }
  if (prefixes.some((prefix) => normalized.startsWith(prefix))) {
    return "unknown_command";
  }
  if (exactPrefixes.includes(normalized)) {
    return "unknown_command";
  }
  if (goalExactPrefixes.includes(normalized)) {
    return "goal";
  }
  if (goalPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return "goal";
  }
  if (appointmentExactPrefixes.includes(normalized)) {
    return "appointment";
  }
  if (appointmentPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return "appointment";
  }
  if (text.trim()) {
    return "message";
  }

  return "";
}

function isDirectBridgeMode(config = {}) {
  return String(config.bridgeMode || "thin").trim().toLowerCase() === "direct";
}

function matchesExactCommand(text, suffixes) {
  return suffixes.some((suffix) => text === `/codex ${suffix}`);
}

function matchesPrefixCommand(text, command) {
  return text.startsWith(`/codex ${command} `);
}

function extractCardChatId(data) {
  return normalizeIdentifier(data?.context?.open_chat_id);
}

function extractCardSelectedValue(action, value) {
  if (typeof action?.option?.value === "string" && action.option.value.trim()) {
    return action.option.value.trim();
  }
  if (typeof action?.option === "string" && action.option.trim()) {
    return action.option.trim();
  }
  return typeof value?.selectedValue === "string" ? value.selectedValue.trim() : "";
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

module.exports = {
  extractCardAction,
  mapCodexMessageToImEvent,
  normalizeCardActionContext,
  normalizeFeishuForwardedMessageItems,
  normalizeFeishuTextEvent,
};



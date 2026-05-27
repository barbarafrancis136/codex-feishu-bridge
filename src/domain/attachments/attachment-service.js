const fs = require("fs");
const path = require("path");
const { isSafeTextFile } = require("../../shared/media-types");
const { createLogger } = require("../../shared/logger");

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_TEXT_PREVIEW_CHARS = 12000;
const RECEIPT_STAGE_SUCCESS = "success";
const RECEIPT_STAGE_FAILED = "failed";
const RECEIPT_STAGE_PENDING = "pending";
const logger = createLogger("attachments");

async function prepareAttachmentMessage(runtime, normalized, { workspaceRoot = "", expectedKind = "" } = {}) {
  const receipt = createAttachmentReceipt(normalized, { expectedKind });
  const pendingAttachments = extractPendingAttachments(normalized, expectedKind);
  logger.info("attachment message received", {
    messageId: normalized?.messageId || "",
    command: normalized?.command || "",
    expectedKind,
    workspaceRoot,
    attachmentCount: Array.isArray(normalized?.attachments) ? normalized.attachments.length : 0,
    pendingCount: pendingAttachments.length,
    attachmentKinds: summarizeAttachmentKinds(normalized?.attachments || []),
  });
  if (!pendingAttachments.length) {
    await sendAttachmentReceipt(runtime, normalized, markAttachmentReceiptFailure(receipt, {
      stage: "cached",
      detail: "飞书消息到了，但桥没有从事件里解析出可下载的资源键。",
      error: new Error("No attachment resource key found in Feishu event"),
    }));
    return null;
  }

  try {
    const downloaded = [];
    for (const attachment of pendingAttachments) {
      const filePath = buildAttachmentCachePath(runtime.config, normalized, attachment);
      const result = await runtime.requireFeishuAdapter().downloadMessageResource({
        messageId: normalized.messageId,
        fileKey: attachment.resourceKey,
        type: attachment.resourceType || attachment.kind,
        filePath,
      });
      const resolvedFilePath = result.filePath || filePath;
      const stats = fs.statSync(resolvedFilePath);
      assertCachedAttachmentSize(runtime.config, attachment, resolvedFilePath, stats.size);
      assertCachedAttachmentReadable(resolvedFilePath, stats.size);
      const contentType = normalizeHeader(result.headers, "content-type") || inferDefaultContentType(attachment);
      const downloadedAttachment = await buildDownloadedAttachment({
        attachment,
        filePath: resolvedFilePath,
        size: stats.size,
        contentType,
        workspaceRoot,
      });
      downloaded.push(downloadedAttachment);
      logger.info("attachment cached locally", {
        messageId: normalized?.messageId || "",
        kind: downloadedAttachment.kind,
        resourceKey: downloadedAttachment.resourceKey,
        filePath: downloadedAttachment.filePath,
        size: downloadedAttachment.size,
        contentType: downloadedAttachment.contentType,
      });
    }
    const preparedMessage = buildAttachmentNormalizedMessage({
      normalized,
      downloaded,
      receipt: markAttachmentReceiptCached(receipt, downloaded),
    });
    logger.info("attachment prepared for codex", summarizePreparedAttachmentMessage(normalized, preparedMessage));
    return preparedMessage;
  } catch (error) {
    logger.error("attachment preparation failed", {
      messageId: normalized?.messageId || "",
      command: normalized?.command || "",
      expectedKind,
      workspaceRoot,
      error,
    });
    await sendAttachmentReceipt(runtime, normalized, markAttachmentReceiptFailure(receipt, {
      stage: "cached",
      detail: "附件下载或本地可读性校验失败，当前实例还不能稳定读取这个文件。",
      error,
    }));
    return null;
  }
}

function extractPendingAttachments(normalized, expectedKind = "") {
  const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
  return attachments.filter((attachment) => {
    if (!attachment?.resourceKey || attachment.filePath) {
      return false;
    }
    return expectedKind ? attachment.kind === expectedKind : true;
  });
}

function buildAttachmentCachePath(config, normalized, attachment) {
  const rootDir = config.attachmentsDir
    || path.join(process.env.HOME || "", ".codex-feishu-bridge", "attachments");
  const day = normalizeDay(normalized.receivedAt);
  const messageId = sanitizePathPart(normalized.messageId || "message");
  const resourceKey = sanitizePathPart(attachment.resourceKey || attachment.kind || "attachment");
  const fileName = sanitizePathPart(attachment.fileName || "");
  const inferredExtension = inferAttachmentExtension(attachment);
  const suffix = fileName
    ? `-${ensureFileNameExtension(fileName, inferredExtension)}`
    : inferredExtension;
  return path.join(rootDir, day, `${messageId}-${resourceKey}${suffix}`);
}

function normalizeDay(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function sanitizePathPart(value) {
  const normalized = String(value || "").trim();
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96) || "item";
}

function ensureFileNameExtension(fileName, extension) {
  if (!extension || fileName.toLowerCase().endsWith(extension.toLowerCase())) {
    return fileName;
  }
  return `${fileName}${extension}`;
}

function inferAttachmentExtension(attachment) {
  const kind = String(attachment?.kind || "").trim().toLowerCase();
  const fileName = String(attachment?.fileName || "").trim();
  const fromName = path.extname(fileName);
  if (fromName) {
    return fromName.toLowerCase();
  }
  if (kind === "image") {
    return ".jpg";
  }
  if (kind === "audio") {
    return ".opus";
  }
  return ".bin";
}

function assertCachedAttachmentSize(config, attachment, filePath, size) {
  const maxBytes = attachment.kind === "image"
    ? Number(config.maxImageBytes || 0)
    : Number(config.maxAttachmentBytes || 0);
  if (maxBytes > 0 && size > maxBytes) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup; the caller still gets the size-limit error.
    }
    throw new Error(`${attachment.kind || "attachment"} is too large: ${size} bytes > ${maxBytes} bytes`);
  }
}

function assertCachedAttachmentReadable(filePath, size) {
  const fd = fs.openSync(filePath, "r");
  try {
    if (size > 0) {
      const sample = Buffer.alloc(1);
      fs.readSync(fd, sample, 0, 1, 0);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeHeader(headers, name) {
  if (!headers || typeof headers !== "object") {
    return "";
  }
  const direct = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  if (typeof direct === "string") {
    return direct;
  }
  return Array.isArray(direct) ? direct.join(", ") : "";
}

async function buildDownloadedAttachment({ attachment, filePath, size, contentType, workspaceRoot }) {
  const downloaded = {
    ...attachment,
    filePath,
    size,
    contentType,
    workspaceRoot,
  };
  if (attachment.kind === "file" && isSafeTextFile(filePath, contentType) && size <= MAX_TEXT_PREVIEW_BYTES) {
    downloaded.textPreview = await readTextPreview(filePath);
  }
  if (attachment.kind === "audio") {
    downloaded.transcript = "";
    downloaded.transcriptionStatus = "not_configured";
  }
  return downloaded;
}

async function readTextPreview(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return text.length > MAX_TEXT_PREVIEW_CHARS
    ? `${text.slice(0, MAX_TEXT_PREVIEW_CHARS)}\n[...truncated...]`
    : text;
}

function buildAttachmentNormalizedMessage({ normalized, downloaded, receipt }) {
  const imageAttachments = downloaded.filter((attachment) => attachment.kind === "image");
  const nonImageAttachments = downloaded.filter((attachment) => attachment.kind !== "image");
  const userText = normalizeUserAttachmentText(normalized.text, downloaded);
  const notes = buildAttachmentSystemNotes(downloaded);
  const text = [userText, "", ...notes].filter(Boolean).join("\n");

  return {
    ...normalized,
    text,
    command: "message",
    attachments: [
      ...preserveNonDownloadedAttachments(normalized.attachments, downloaded),
      ...downloaded,
    ],
    imageContext: imageAttachments[0]
      ? {
        filePath: imageAttachments[0].filePath,
        size: imageAttachments[0].size,
        contentType: imageAttachments[0].contentType,
        mode: "native",
      }
      : undefined,
    attachmentContext: nonImageAttachments.length ? nonImageAttachments : undefined,
    attachmentReceipt: receipt,
  };
}

function buildAttachmentSystemNotes(downloaded) {
  return downloaded.map((attachment) => {
    if (attachment.kind === "image") {
      return "[System note: A Feishu/Lark user sent an image. The bridge successfully downloaded the original image to local private cache, verified that the file exists and is readable, and attached it to this Codex turn as a native image input. Look at the attached image directly. Do not claim the file is missing, unreadable, or not mounted unless the tool input itself explicitly fails. If you still cannot describe visible details from the image, say the current model or provider may not actually support visual inspection in this run.]";
    }
    const lines = [
      `[System note: A Feishu/Lark user sent a ${attachment.kind}. The bridge downloaded it to local private cache and is passing metadata as text because the Codex app-server input shape is only confirmed for text and localImage.]`,
      `Local path: ${attachment.filePath}`,
      `File name: ${attachment.fileName || path.basename(attachment.filePath)}`,
      `Size: ${attachment.size} bytes`,
      `Content type: ${attachment.contentType || "unknown"}`,
    ];
    if (attachment.kind === "audio") {
      lines.push("Transcription: not configured in this bridge version.");
    }
    if (attachment.textPreview) {
      lines.push("", "Text preview:", attachment.textPreview);
    }
    return lines.join("\n");
  });
}

function normalizeUserAttachmentText(text, downloaded) {
  const normalized = String(text || "").trim();
  if (normalized) {
    return normalized;
  }
  if (downloaded.some((attachment) => attachment.kind === "image")) {
    return "Please inspect this image.";
  }
  if (downloaded.some((attachment) => attachment.kind === "audio")) {
    return "Please process this audio attachment.";
  }
  return "Please process this file attachment.";
}

function preserveNonDownloadedAttachments(attachments, downloaded) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  const downloadedKeys = new Set(downloaded.map((attachment) => attachment.resourceKey).filter(Boolean));
  return attachments.filter((attachment) => attachment.filePath || !downloadedKeys.has(attachment.resourceKey));
}

function inferDefaultContentType(attachment) {
  if (attachment.kind === "image") {
    return "image/png";
  }
  if (attachment.kind === "audio") {
    return "audio/opus";
  }
  return "application/octet-stream";
}

function createAttachmentReceipt(normalized, { expectedKind = "" } = {}) {
  const attachments = Array.isArray(normalized?.attachments) ? normalized.attachments : [];
  const counts = summarizeAttachmentKinds(attachments);
  const subject = resolveAttachmentReceiptSubject({ counts, expectedKind, command: normalized?.command });
  return {
    subject,
    items: attachments.map((attachment) => ({
      kind: String(attachment?.kind || "").trim() || "attachment",
      resourceKey: String(attachment?.resourceKey || "").trim(),
      fileName: String(attachment?.fileName || "").trim(),
      filePath: String(attachment?.filePath || "").trim(),
      size: Number(attachment?.size || 0),
      contentType: String(attachment?.contentType || "").trim(),
    })),
    stages: {
      received: {
        status: RECEIPT_STAGE_SUCCESS,
        detail: buildReceiptReceivedDetail({ counts, expectedKind, command: normalized?.command, subject }),
      },
      cached: {
        status: RECEIPT_STAGE_PENDING,
        detail: "等待下载并验证当前实例可读。",
      },
      delivered: {
        status: RECEIPT_STAGE_PENDING,
        detail: "等待交给 Codex。",
      },
    },
  };
}

function markAttachmentReceiptCached(receipt, downloaded) {
  const items = mergeReceiptItemsWithDownloaded(receipt?.items, downloaded);
  return {
    ...receipt,
    items,
    stages: {
      ...receipt.stages,
      cached: {
        status: RECEIPT_STAGE_SUCCESS,
        detail: buildReceiptCachedDetail(items),
      },
      delivered: {
        status: RECEIPT_STAGE_PENDING,
        detail: "本地文件已就绪，等待送入 Codex。",
      },
    },
  };
}

function markAttachmentReceiptDelivered(receipt, { error = null } = {}) {
  if (error) {
    return {
      ...receipt,
      stages: {
        ...receipt.stages,
        delivered: {
          status: RECEIPT_STAGE_FAILED,
          detail: "附件已经落盘，但送入 Codex 失败。",
          errorMessage: String(error?.message || error || "").trim(),
        },
      },
    };
  }

  return {
    ...receipt,
    stages: {
      ...receipt.stages,
      delivered: {
        status: RECEIPT_STAGE_SUCCESS,
        detail: buildReceiptDeliveredDetail(receipt?.items || []),
      },
    },
  };
}

function markAttachmentReceiptFailure(receipt, { stage = "cached", detail = "", error = null } = {}) {
  const errorMessage = String(error?.message || error || "").trim();
  const nextStages = {
    ...receipt.stages,
  };

  nextStages[stage] = {
    status: RECEIPT_STAGE_FAILED,
    detail: detail || (stage === "cached" ? "附件处理失败。" : "送入 Codex 失败。"),
    errorMessage,
  };

  if (stage === "cached") {
    nextStages.delivered = {
      status: RECEIPT_STAGE_PENDING,
      detail: "因为本地文件未准备好，尚未送入 Codex。",
    };
  }

  return {
    ...receipt,
    stages: nextStages,
  };
}

function buildAttachmentReceiptText(receipt) {
  const stages = receipt?.stages || {};
  const received = stages.received || {};
  const cached = stages.cached || {};
  const delivered = stages.delivered || {};
  const filePaths = (receipt?.items || [])
    .map((item) => String(item?.filePath || "").trim())
    .filter(Boolean)
    .slice(0, 2);
  const errorMessage = received.errorMessage || cached.errorMessage || delivered.errorMessage || "";
  const lines = [
    `**${receipt?.subject || "附件"}处理回执**`,
    `- ${receipt?.subject || "附件"}已接收：${formatReceiptStageStatus(received.status)}`,
    `- ${receipt?.subject || "附件"}已落盘：${formatReceiptStageStatus(cached.status)}`,
    `- ${receipt?.subject || "附件"}已送入 Codex：${formatReceiptStageStatus(delivered.status)}`,
    "",
    `- 接收说明：${received.detail || "无"}`,
    `- 落盘说明：${cached.detail || "无"}`,
    `- 送入说明：${delivered.detail || "无"}`,
  ];

  if (filePaths.length === 1) {
    lines.push(`- 本地缓存：\`${filePaths[0]}\``);
  } else if (filePaths.length > 1) {
    lines.push(`- 本地缓存：\`${filePaths.join("`, `")}\``);
  }

  if (errorMessage) {
    lines.push(`- 错误：${errorMessage}`);
  }

  return lines.join("\n");
}

async function sendAttachmentReceipt(runtime, normalized, receipt) {
  if (!runtime?.sendInfoCardMessage || !normalized?.chatId || !receipt) {
    return null;
  }
  logger.info("sending attachment receipt", summarizeReceiptLogMeta(normalized, receipt));
  try {
    const response = await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildAttachmentReceiptText(receipt),
    });
    logger.info("attachment receipt sent", summarizeReceiptLogMeta(normalized, receipt));
    return response;
  } catch (error) {
    logger.warn("failed to send attachment receipt", {
      ...summarizeReceiptLogMeta(normalized, receipt),
      error,
    });
    return null;
  }
}

function summarizePreparedAttachmentMessage(normalized, prepared) {
  const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments : [];
  const imageAttachments = attachments.filter((attachment) => attachment?.kind === "image" && attachment?.filePath);
  const nonImageAttachments = attachments.filter((attachment) => attachment?.kind !== "image" && attachment?.filePath);
  return {
    messageId: normalized?.messageId || "",
    command: normalized?.command || "",
    attachmentCount: attachments.length,
    imageCount: imageAttachments.length,
    nonImageCount: nonImageAttachments.length,
    hasImageContext: Boolean(prepared?.imageContext?.filePath),
    hasAttachmentContext: Array.isArray(prepared?.attachmentContext) && prepared.attachmentContext.length > 0,
    imagePaths: imageAttachments.map((attachment) => attachment.filePath).slice(0, 3),
  };
}

function summarizeReceiptLogMeta(normalized, receipt) {
  return {
    messageId: normalized?.messageId || "",
    chatId: normalized?.chatId || "",
    subject: receipt?.subject || "",
    receivedStatus: receipt?.stages?.received?.status || "",
    cachedStatus: receipt?.stages?.cached?.status || "",
    deliveredStatus: receipt?.stages?.delivered?.status || "",
  };
}

function summarizeAttachmentKinds(attachments) {
  return (Array.isArray(attachments) ? attachments : []).reduce((counts, attachment) => {
    const kind = String(attachment?.kind || "").trim() || "attachment";
    counts.total += 1;
    if (kind === "image") {
      counts.image += 1;
    } else if (kind === "audio") {
      counts.audio += 1;
    } else if (kind === "file") {
      counts.file += 1;
    } else {
      counts.other += 1;
    }
    return counts;
  }, {
    total: 0,
    image: 0,
    audio: 0,
    file: 0,
    other: 0,
  });
}

function resolveAttachmentReceiptSubject({ counts, expectedKind, command }) {
  if (counts.image > 0 && counts.total === counts.image) {
    return "图片";
  }
  if (counts.audio > 0 && counts.total === counts.audio) {
    return "音频";
  }
  if (counts.file > 0 && counts.total === counts.file) {
    return "文件";
  }
  if (expectedKind === "image" || command === "image_message") {
    return "图片";
  }
  return "附件";
}

function buildReceiptReceivedDetail({ counts, expectedKind, command, subject }) {
  if (counts.image > 0 && counts.total === counts.image) {
    return `飞书事件已收到 ${counts.image} 张图片。`;
  }
  if (counts.audio > 0 && counts.total === counts.audio) {
    return `飞书事件已收到 ${counts.audio} 个音频附件。`;
  }
  if (counts.file > 0 && counts.total === counts.file) {
    return `飞书事件已收到 ${counts.file} 个文件附件。`;
  }
  if (counts.total > 0) {
    return `飞书事件已收到 ${counts.total} 个附件。`;
  }
  if (expectedKind === "image" || command === "image_message") {
    return "飞书事件已收到图片消息。";
  }
  return `飞书事件已收到${subject}消息。`;
}

function mergeReceiptItemsWithDownloaded(receiptItems, downloaded) {
  const downloadedByKey = new Map((Array.isArray(downloaded) ? downloaded : [])
    .map((attachment) => [String(attachment?.resourceKey || ""), attachment]));
  const sourceItems = Array.isArray(receiptItems) ? receiptItems : [];
  const merged = sourceItems.map((item) => {
    const matched = downloadedByKey.get(String(item?.resourceKey || "")) || null;
    return matched
      ? {
        ...item,
        filePath: String(matched.filePath || "").trim(),
        size: Number(matched.size || 0),
        contentType: String(matched.contentType || "").trim(),
        fileName: String(matched.fileName || item.fileName || "").trim(),
      }
      : item;
  });

  if (merged.length) {
    return merged;
  }

  return (Array.isArray(downloaded) ? downloaded : []).map((attachment) => ({
    kind: String(attachment?.kind || "").trim() || "attachment",
    resourceKey: String(attachment?.resourceKey || "").trim(),
    fileName: String(attachment?.fileName || "").trim(),
    filePath: String(attachment?.filePath || "").trim(),
    size: Number(attachment?.size || 0),
    contentType: String(attachment?.contentType || "").trim(),
  }));
}

function buildReceiptCachedDetail(items) {
  const readableItems = (Array.isArray(items) ? items : []).filter((item) => String(item?.filePath || "").trim());
  if (!readableItems.length) {
    return "文件已下载，但还没有拿到可展示的本地路径。";
  }
  if (readableItems.length === 1) {
    return `已下载到本地缓存并验证当前实例可读：\`${readableItems[0].filePath}\``;
  }
  return `已下载到本地缓存并验证当前实例可读，共 ${readableItems.length} 个文件。`;
}

function buildReceiptDeliveredDetail(items) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const hasImage = normalizedItems.some((item) => item?.kind === "image");
  const hasNonImage = normalizedItems.some((item) => item?.kind && item.kind !== "image");
  if (hasImage && hasNonImage) {
    return "图片已作为 localImage 输入，其余附件已作为文本元信息一起交给 Codex。";
  }
  if (hasImage) {
    return "桥已把图片作为 localImage 输入交给 Codex。";
  }
  return "桥已把附件内容或元信息随本轮消息交给 Codex。";
}

function formatReceiptStageStatus(status) {
  if (status === RECEIPT_STAGE_SUCCESS) {
    return "成功";
  }
  if (status === RECEIPT_STAGE_FAILED) {
    return "失败";
  }
  return "未开始";
}

module.exports = {
  buildAttachmentReceiptText,
  createAttachmentReceipt,
  markAttachmentReceiptCached,
  markAttachmentReceiptDelivered,
  markAttachmentReceiptFailure,
  prepareAttachmentMessage,
  sendAttachmentReceipt,
};

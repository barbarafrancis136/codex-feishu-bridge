const fs = require("fs");
const path = require("path");
const { createLogger } = require("../../shared/logger");
const logger = createLogger("feishu-adapter");
const FEISHU_RETRY_MAX_ATTEMPTS = normalizePositiveInt(process.env.CODEX_IM_FEISHU_RETRY_MAX_ATTEMPTS, 3);
const FEISHU_RETRY_BASE_DELAY_MS = normalizePositiveInt(process.env.CODEX_IM_FEISHU_RETRY_BASE_DELAY_MS, 300);

// Feishu SDK adapter and compatibility helpers
class FeishuClientAdapter {
  constructor(client) {
    this.client = client;
  }

  async sendFileMessage({
    chatId,
    fileName,
    fileBuffer,
    fileType = "stream",
    msgType = "file",
    duration = null,
    replyToMessageId = "",
    replyInThread = false,
  }) {
    const fileKey = await this.uploadFile({
      fileName,
      fileBuffer,
      fileType,
      duration,
    });
    if (!fileKey) {
      throw new Error("Feishu file upload did not return a file_key");
    }

    return this.sendResourceMessage({
      chatId,
      replyToMessageId,
      replyInThread,
      msgType,
      content: JSON.stringify({ file_key: fileKey }),
    });
  }

  async sendImageMessage({ chatId, imageBuffer, replyToMessageId = "", replyInThread = false }) {
    const imageKey = await this.uploadImage({ imageBuffer });
    if (!imageKey) {
      throw new Error("Feishu image upload did not return an image_key");
    }

    return this.sendResourceMessage({
      chatId,
      replyToMessageId,
      replyInThread,
      msgType: "image",
      content: JSON.stringify({ image_key: imageKey }),
    });
  }

  async sendResourceMessage({ chatId, replyToMessageId = "", replyInThread = false, msgType, content }) {
    if (replyToMessageId) {
      const replyMessage = resolveReplyMessageMethod(this.client);
      return callWithRetry(() => replyMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
        path: {
          message_id: normalizeMessageId(replyToMessageId),
        },
        data: {
          msg_type: msgType,
          content,
          reply_in_thread: replyInThread,
        },
      }), { operation: "message.reply" });
    }

    const createMessage = resolveCreateMessageMethod(this.client);
    return callWithRetry(() => createMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content,
      },
    }), { operation: "message.create" });
  }

  async sendInteractiveCard({ chatId, card, replyToMessageId = "", replyInThread = false }) {
    if (replyToMessageId) {
      const replyMessage = resolveReplyMessageMethod(this.client);
      return replyMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
        path: {
          message_id: normalizeMessageId(replyToMessageId),
        },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: replyInThread,
        },
      });
    }

    const createMessage = resolveCreateMessageMethod(this.client);
    return createMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  }

  async sendTextMessage({ chatId, text, replyToMessageId = "", replyInThread = false }) {
    return this.sendResourceMessage({
      chatId,
      replyToMessageId,
      replyInThread,
      msgType: "text",
      content: JSON.stringify({ text: String(text || "") }),
    });
  }

  async patchInteractiveCard({ messageId, card }) {
    const patchMessage = resolvePatchMessageMethod(this.client);
    return callWithRetry(() => patchMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    }), { operation: "message.patch" });
  }

  async createCardEntity({ card }) {
    const createCard = resolveCreateCardMethod(this.client);
    const response = await createCard.call(this.client.cardkit?.v1?.card || this.client.cardkit?.card || this.client, {
      data: {
        type: "card_json",
        data: JSON.stringify(card),
      },
    });
    assertFeishuBusinessOk(response, "card.create");
    const cardId = normalizeIdentifier(response?.data?.card_id || response?.card_id);
    if (!cardId) {
      throw new Error("Feishu CardKit card.create did not return card_id");
    }
    return cardId;
  }

  async sendCardByCardId({ chatId, cardId, replyToMessageId = "", replyInThread = false }) {
    const content = JSON.stringify({
      type: "card",
      data: { card_id: cardId },
    });
    if (replyToMessageId) {
      const replyMessage = resolveReplyMessageMethod(this.client);
      return replyMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
        path: {
          message_id: normalizeMessageId(replyToMessageId),
        },
        data: {
          msg_type: "interactive",
          content,
          reply_in_thread: replyInThread,
        },
      });
    }

    const createMessage = resolveCreateMessageMethod(this.client);
    return createMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content,
      },
    });
  }

  async sendTextByChatId({ chatId, text, replyToMessageId = "", replyInThread = false }) {
    return this.sendTextMessage({
      chatId,
      text,
      replyToMessageId,
      replyInThread,
    });
  }

  async streamCardContent({ cardId, elementId, content, sequence }) {
    const updateContent = resolveCardElementContentMethod(this.client);
    const response = await updateContent.call(
      this.client.cardkit?.v1?.cardElement || this.client.cardkit?.cardElement || this.client,
      {
        path: {
          card_id: cardId,
          element_id: elementId,
        },
        data: {
          content,
          sequence,
        },
      }
    );
    assertFeishuBusinessOk(response, "cardElement.content");
    return response;
  }

  async updateCardKitCard({ cardId, card, sequence }) {
    const updateCard = resolveUpdateCardMethod(this.client);
    const response = await updateCard.call(this.client.cardkit?.v1?.card || this.client.cardkit?.card || this.client, {
      path: {
        card_id: cardId,
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify(card),
        },
        sequence,
      },
    });
    assertFeishuBusinessOk(response, "card.update");
    return response;
  }

  async setCardStreamingMode({ cardId, streamingMode, sequence }) {
    const updateSettings = resolveCardSettingsMethod(this.client);
    const response = await updateSettings.call(this.client.cardkit?.v1?.card || this.client.cardkit?.card || this.client, {
      path: {
        card_id: cardId,
      },
      data: {
        settings: JSON.stringify({ streaming_mode: Boolean(streamingMode) }),
        sequence,
      },
    });
    assertFeishuBusinessOk(response, "card.settings");
    return response;
  }

  async createReaction({ messageId, emojiType }) {
    const createReaction = resolveCreateReactionMethod(this.client);
    return createReaction.call(
      this.client.im?.v1?.messageReaction || this.client.im?.messageReaction || this.client,
      {
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      }
    );
  }

  async deleteReaction({ messageId, reactionId }) {
    const deleteReaction = resolveDeleteReactionMethod(this.client);
    return deleteReaction.call(
      this.client.im?.v1?.messageReaction || this.client.im?.messageReaction || this.client,
      {
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      }
    );
  }

  async getMessage({ messageId, userIdType = "open_id" } = {}) {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId) {
      throw new Error("Feishu message.get requires messageId");
    }
    const getMessage = resolveGetMessageMethod(this.client);
    const response = await callWithRetry(() => getMessage.call(
      this.client.im?.v1?.message || this.client.im?.message || this.client,
      {
        params: {
          user_id_type: normalizeIdentifier(userIdType) || "open_id",
        },
        path: {
          message_id: normalizedMessageId,
        },
      }
    ), { operation: "message.get" });
    assertFeishuBusinessOk(response, "message.get");
    return Array.isArray(response?.data?.items) ? response.data.items : [];
  }

  async listMessages({
    containerIdType,
    containerId,
    sortType = "ByCreateTimeDesc",
    pageSize = 50,
    pageToken = "",
  } = {}) {
    const normalizedContainerIdType = normalizeIdentifier(containerIdType);
    const normalizedContainerId = normalizeIdentifier(containerId);
    if (!normalizedContainerIdType || !normalizedContainerId) {
      throw new Error("Feishu message.list requires containerIdType and containerId");
    }
    const listMessages = resolveListMessagesMethod(this.client);
    const response = await callWithRetry(() => listMessages.call(
      this.client.im?.v1?.message || this.client.im?.message || this.client,
      {
        params: {
          container_id_type: normalizedContainerIdType,
          container_id: normalizedContainerId,
          sort_type: sortType,
          page_size: normalizePageSize(pageSize),
          ...(normalizeIdentifier(pageToken) ? { page_token: normalizeIdentifier(pageToken) } : {}),
        },
      }
    ), { operation: "message.list" });
    assertFeishuBusinessOk(response, "message.list");
    return {
      items: Array.isArray(response?.data?.items) ? response.data.items : [],
      hasMore: response?.data?.has_more === true,
      pageToken: normalizeIdentifier(response?.data?.page_token),
    };
  }

  async uploadFile({ fileName, fileBuffer, fileType = "stream", duration = null }) {
    const createFile = resolveCreateFileMethod(this.client);
    const data = {
      file_type: normalizeFeishuFileType(fileType),
      file_name: normalizeFileName(fileName),
      file: fileBuffer,
    };
    const normalizedDuration = Number(duration || 0);
    if (Number.isFinite(normalizedDuration) && normalizedDuration > 0) {
      data.duration = normalizedDuration;
    }
    const response = await callWithRetry(() => createFile.call(this.client.im?.v1?.file || this.client.im?.file || this.client, {
      data,
    }), { operation: "file.create" });
    return normalizeIdentifier(response?.file_key || response?.data?.file_key);
  }

  async uploadImage({ imageBuffer }) {
    const createImage = resolveCreateImageMethod(this.client);
    const response = await callWithRetry(() => createImage.call(this.client.im?.v1?.image || this.client.im?.image || this.client, {
      data: {
        image_type: "message",
        image: imageBuffer,
      },
    }), { operation: "image.create" });
    return normalizeIdentifier(response?.image_key || response?.data?.image_key);
  }

  async downloadMessageResource({ messageId, fileKey, type, filePath = "" }) {
    const normalizedMessageId = normalizeMessageId(messageId);
    const normalizedFileKey = normalizeIdentifier(fileKey);
    const normalizedType = normalizeIdentifier(type);
    if (!normalizedMessageId || !normalizedFileKey || !normalizedType) {
      throw new Error("Feishu messageResource.get requires messageId, fileKey, and type");
    }

    const getResource = resolveGetMessageResourceMethod(this.client);
    const response = await getResource.call(
      this.client.im?.v1?.messageResource || this.client.im?.messageResource || this.client,
      {
        params: {
          type: normalizedType,
        },
        path: {
          message_id: normalizedMessageId,
          file_key: normalizedFileKey,
        },
      }
    );

    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      await response.writeFile(filePath);
    }

    return {
      filePath,
      headers: response.headers || {},
      getReadableStream: response.getReadableStream,
    };
  }
}

function resolveCreateMessageMethod(client) {
  const fn = client?.im?.v1?.message?.create || client?.im?.message?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.create");
  }
  return fn;
}

function resolveReplyMessageMethod(client) {
  const fn = client?.im?.v1?.message?.reply || client?.im?.message?.reply;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.reply");
  }
  return fn;
}

function resolvePatchMessageMethod(client) {
  const fn = client?.im?.v1?.message?.patch || client?.im?.message?.patch;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.patch");
  }
  return fn;
}

function resolveGetMessageMethod(client) {
  const fn = client?.im?.v1?.message?.get || client?.im?.message?.get;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.get");
  }
  return fn;
}

function resolveListMessagesMethod(client) {
  const fn = client?.im?.v1?.message?.list || client?.im?.message?.list;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.list");
  }
  return fn;
}

function resolveCreateCardMethod(client) {
  const fn = client?.cardkit?.v1?.card?.create || client?.cardkit?.card?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing cardkit.card.create");
  }
  return fn;
}

function resolveUpdateCardMethod(client) {
  const fn = client?.cardkit?.v1?.card?.update || client?.cardkit?.card?.update;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing cardkit.card.update");
  }
  return fn;
}

function resolveCardSettingsMethod(client) {
  const fn = client?.cardkit?.v1?.card?.settings || client?.cardkit?.card?.settings;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing cardkit.card.settings");
  }
  return fn;
}

function resolveCardElementContentMethod(client) {
  const fn = client?.cardkit?.v1?.cardElement?.content || client?.cardkit?.cardElement?.content;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing cardkit.cardElement.content");
  }
  return fn;
}

function resolveCreateFileMethod(client) {
  const fn = client?.im?.v1?.file?.create || client?.im?.file?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing file.create");
  }
  return fn;
}

function resolveCreateImageMethod(client) {
  const fn = client?.im?.v1?.image?.create || client?.im?.image?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing image.create");
  }
  return fn;
}

function resolveGetMessageResourceMethod(client) {
  const fn = client?.im?.v1?.messageResource?.get || client?.im?.messageResource?.get;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing messageResource.get");
  }
  return fn;
}

function normalizeMessageId(messageId) {
  const normalized = typeof messageId === "string" ? messageId.trim() : "";
  if (!normalized) {
    return "";
  }
  return normalized.split(":")[0];
}

function resolveCreateReactionMethod(client) {
  const fn = client?.im?.v1?.messageReaction?.create || client?.im?.messageReaction?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing messageReaction.create");
  }
  return fn;
}

function resolveDeleteReactionMethod(client) {
  const fn = client?.im?.v1?.messageReaction?.delete || client?.im?.messageReaction?.delete;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing messageReaction.delete");
  }
  return fn;
}

function extractCardChatId(data) {
  return normalizeIdentifier(data?.context?.open_chat_id);
}

function patchWsClientForCardCallbacks(wsClient) {
  if (!wsClient || typeof wsClient.handleEventData !== "function") {
    return;
  }

  const originalHandleEventData = wsClient.handleEventData.bind(wsClient);
  wsClient.handleEventData = (data) => {
    const headers = Array.isArray(data?.headers) ? data.headers : [];
    const messageType = headers.find((header) => header?.key === "type")?.value;
    if (messageType === "card") {
      const patchedData = {
        ...data,
        headers: headers.map((header) => (
          header?.key === "type" ? { ...header, value: "event" } : header
        )),
      };
      return originalHandleEventData(patchedData);
    }
    return originalHandleEventData(data);
  };
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function assertFeishuBusinessOk(response, apiName) {
  const code = Number(response?.code || 0);
  if (Number.isFinite(code) && code !== 0) {
    const message = normalizeIdentifier(response?.msg) || normalizeIdentifier(response?.message) || "unknown error";
    throw new Error(`Feishu ${apiName} failed: ${code} ${message}`);
  }
}

function normalizeFileName(fileName) {
  return typeof fileName === "string" && fileName.trim() ? fileName.trim() : "file";
}

function normalizeFeishuFileType(fileType) {
  const normalized = typeof fileType === "string" && fileType.trim() ? fileType.trim() : "stream";
  return normalized.replace(/[^a-zA-Z0-9_-]/g, "") || "stream";
}

function normalizePageSize(value) {
  const pageSize = Number(value || 0);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 50;
  }
  return Math.max(1, Math.min(200, Math.floor(pageSize)));
}

async function callWithRetry(fn, { operation = "feishu.request" } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= FEISHU_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableFeishuError(error);
      const finalAttempt = attempt >= FEISHU_RETRY_MAX_ATTEMPTS;
      if (!retryable || finalAttempt) {
        throw error;
      }
      const delayMs = FEISHU_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
      logger.warn("feishu request failed, retrying", {
        operation,
        attempt,
        delayMs,
        error,
      });
      await sleep(delayMs);
    }
  }
  throw lastError || new Error(`Feishu ${operation} failed`);
}

function isRetryableFeishuError(error) {
  const text = `${error?.message || ""} ${error?.code || ""}`.toLowerCase();
  if (
    text.includes("timeout")
    || text.includes("timed out")
    || text.includes("econnreset")
    || text.includes("eai_again")
    || text.includes("socket hang up")
    || text.includes("rate limit")
    || text.includes("too many requests")
    || text.includes("429")
    || text.includes("5xx")
  ) {
    return true;
  }
  const status = Number(error?.response?.status || error?.status || 0);
  if (Number.isFinite(status) && (status === 429 || status >= 500)) {
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePositiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

module.exports = {
  FeishuClientAdapter,
  extractCardChatId,
  patchWsClientForCardCallbacks,
};

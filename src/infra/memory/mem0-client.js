const axios = require("axios");

class Mem0Client {
  constructor({
    baseUrl,
    apiKey,
    userIdPrefix = "feishu",
    enabled = false,
    searchLimit = 5,
    timeoutMs = 15000,
  } = {}) {
    this.enabled = Boolean(enabled && baseUrl && apiKey);
    this.baseUrl = String(baseUrl || "").replace(/\/+$/g, "");
    this.apiKey = String(apiKey || "").trim();
    this.userIdPrefix = String(userIdPrefix || "feishu").trim() || "feishu";
    this.searchLimit = Number.isFinite(searchLimit) && searchLimit > 0 ? Math.floor(searchLimit) : 5;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 15000;
  }

  isEnabled() {
    return this.enabled;
  }

  buildUserId(senderId) {
    const normalizedSenderId = String(senderId || "").trim();
    if (!normalizedSenderId) {
      return "";
    }
    return `${this.userIdPrefix}:${normalizedSenderId}`;
  }

  async searchMemories({ userId, query }) {
    if (!this.enabled || !userId || !query) {
      return [];
    }

    const response = await axios.post(
      `${this.baseUrl}/v3/memories/search/`,
      {
        query,
        user_id: userId,
        limit: this.searchLimit,
      },
      {
        headers: this.buildHeaders(),
        timeout: this.timeoutMs,
      }
    );

    return normalizeMemoryList(response?.data);
  }

  async addMemories({ userId, messages, metadata = {} }) {
    if (!this.enabled || !userId || !Array.isArray(messages) || !messages.length) {
      return null;
    }

    return axios.post(
      `${this.baseUrl}/v3/memories/add/`,
      {
        messages,
        user_id: userId,
        metadata,
      },
      {
        headers: this.buildHeaders(),
        timeout: this.timeoutMs,
      }
    );
  }

  buildHeaders() {
    return {
      Authorization: `Token ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }
}

function normalizeMemoryList(payload) {
  const candidates = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.memories)
      ? payload.memories
      : Array.isArray(payload)
        ? payload
        : [];

  return candidates
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      return String(
        item.memory
        || item.text
        || item.content
        || item.summary
        || ""
      ).trim();
    })
    .filter(Boolean);
}

module.exports = {
  Mem0Client,
};

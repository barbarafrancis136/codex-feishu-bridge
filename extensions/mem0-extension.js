const { Mem0Client } = require("../src/infra/memory/mem0-client");

const DEFAULT_QUERY_PREFIX = [
  "你可以参考下面这些和用户长期偏好、历史事实相关的记忆。",
  "只有在确实相关时才使用；不要把它们当作绝对事实。",
  "",
].join("\n");

const mem0 = new Mem0Client({
  enabled: readBooleanEnv("MEM0_ENABLED", true),
  baseUrl: process.env.MEM0_BASE_URL || "https://api.mem0.ai",
  apiKey: process.env.MEM0_API_KEY || "",
  userIdPrefix: process.env.MEM0_USER_ID_PREFIX || "feishu",
  searchLimit: readIntEnv("MEM0_SEARCH_LIMIT", 5),
  timeoutMs: readIntEnv("MEM0_TIMEOUT_MS", 15000),
});

module.exports = {
  hooks: {
    beforeMessage: async ({ normalized }) => {
      if (!mem0.isEnabled()) {
        return normalized;
      }
      if (!shouldEnrichIncomingMessage(normalized)) {
        return normalized;
      }

      const userId = mem0.buildUserId(normalized.senderId);
      if (!userId) {
        return normalized;
      }

      try {
        const memories = await mem0.searchMemories({
          userId,
          query: normalized.text,
        });
        if (!memories.length) {
          return normalized;
        }

        return {
          ...normalized,
          text: [
            `${DEFAULT_QUERY_PREFIX}${memories.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
            "",
            "下面是用户当前这条新消息：",
            normalized.text,
          ].join("\n"),
        };
      } catch {
        return normalized;
      }
    },
    afterCodexReply: async ({ event, text }) => {
      if (!mem0.isEnabled()) {
        return String(text || "");
      }
      if (String(event?.payload?.mode || "") !== "completed_snapshot") {
        return String(text || "");
      }

      const chatContext = event?.payload?.normalized || null;
      const senderId = chatContext?.senderId || "";
      const userMessage = chatContext?.text || "";
      const assistantMessage = String(text || "").trim();
      const userId = mem0.buildUserId(senderId);
      if (!userId || !userMessage || !assistantMessage) {
        return String(text || "");
      }

      try {
        await mem0.addMemories({
          userId,
          messages: [
            { role: "user", content: userMessage },
            { role: "assistant", content: assistantMessage },
          ],
          metadata: {
            source: "codex-feishu-bridge",
            provider: "feishu",
            chat_id: chatContext?.chatId || "",
            workspace_id: chatContext?.workspaceId || "",
          },
        });
      } catch {
        return String(text || "");
      }

      return String(text || "");
    },
  },
};

function shouldEnrichIncomingMessage(normalized) {
  const command = String(normalized?.command || "").trim();
  if (!command || command !== "message") {
    return false;
  }
  const text = String(normalized?.text || "").trim();
  return !!text;
}

function readBooleanEnv(name, defaultValue) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(raw);
}

function readIntEnv(name, defaultValue) {
  const parsed = Number.parseInt(String(process.env[name] || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

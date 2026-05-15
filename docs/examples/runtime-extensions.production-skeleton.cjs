"use strict";

function createStructuredLogger(scope) {
  const normalizedScope = String(scope || "extension").trim() || "extension";
  return {
    info: (message, meta) => writeLog("info", normalizedScope, message, meta),
    warn: (message, meta) => writeLog("warn", normalizedScope, message, meta),
    error: (message, meta) => writeLog("error", normalizedScope, message, meta),
  };
}

function writeLog(level, scope, message, meta) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: String(message || "log"),
  };
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    payload.meta = meta;
  }
  const text = safeJson(payload);
  if (level === "error") {
    console.error(text);
    return;
  }
  if (level === "warn") {
    console.warn(text);
    return;
  }
  console.log(text);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{\"level\":\"warn\",\"scope\":\"extension\",\"msg\":\"failed to serialize log\"}";
  }
}

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function textEnv(name, fallback = "") {
  const raw = String(process.env[name] || "").trim();
  return raw || fallback;
}

const logger = createStructuredLogger("extensions.private-skeleton");
const ENABLED = boolEnv("CODEX_IM_EXT_HOOKS_ENABLED", true);
const TAG = textEnv("CODEX_IM_EXT_REPLY_TAG", "");
const APPROVAL_AUDIT = boolEnv("CODEX_IM_EXT_APPROVAL_AUDIT", true);
const USAGE_AUDIT = boolEnv("CODEX_IM_EXT_USAGE_AUDIT", false);

module.exports = {
  codexProfiles: {
    displayNames: {},
    profiles: {},
    beforeSwitchCodexAppServerProfile: async () => {},
    getProfileHelpLines: () => [],
    getProfileNote: () => "",
  },
  hooks: {
    beforeMessage: async ({ normalized }) => {
      if (!ENABLED) {
        return normalized;
      }
      try {
        if (!normalized || typeof normalized !== "object") {
          return normalized;
        }
        return normalized;
      } catch (error) {
        logger.warn("beforeMessage hook failed, fallback to original", { error: error?.message || String(error) });
        return normalized;
      }
    },
    afterCodexReply: async ({ text, threadId }) => {
      if (!ENABLED) {
        return text;
      }
      try {
        if (!TAG) {
          return text;
        }
        return `${String(text || "")}\n\n${TAG}`;
      } catch (error) {
        logger.warn("afterCodexReply hook failed, fallback to original", {
          threadId,
          error: error?.message || String(error),
        });
        return text;
      }
    },
    onApprovalRequest: async ({ threadId, approval }) => {
      if (!ENABLED || !APPROVAL_AUDIT) {
        return;
      }
      try {
        logger.info("approval request observed", {
          threadId,
          requestId: approval?.requestId || "",
          reason: approval?.reason || "",
        });
      } catch (error) {
        logger.warn("onApprovalRequest hook failed", { error: error?.message || String(error) });
      }
    },
    onUsageUpdate: async ({ threadId, usage }) => {
      if (!ENABLED || !USAGE_AUDIT) {
        return;
      }
      try {
        logger.info("usage update observed", {
          threadId,
          inputTokens: Number(usage?.inputTokens || 0),
          outputTokens: Number(usage?.outputTokens || 0),
        });
      } catch (error) {
        logger.warn("onUsageUpdate hook failed", { error: error?.message || String(error) });
      }
    },
  },
};

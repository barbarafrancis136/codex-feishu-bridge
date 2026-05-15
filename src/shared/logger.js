function createLogger(scope = "app") {
  const normalizedScope = String(scope || "app").trim() || "app";
  return {
    debug: (message, meta) => writeLog("debug", normalizedScope, message, meta),
    info: (message, meta) => writeLog("info", normalizedScope, message, meta),
    warn: (message, meta) => writeLog("warn", normalizedScope, message, meta),
    error: (message, meta) => writeLog("error", normalizedScope, message, meta),
  };
}

function writeLog(level, scope, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: normalizeMessage(message),
  };
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    entry.meta = sanitizeMeta(meta);
  }
  const serialized = safeJson(entry);
  if (level === "error") {
    console.error(serialized);
    return;
  }
  if (level === "warn") {
    console.warn(serialized);
    return;
  }
  console.log(serialized);
}

function normalizeMessage(message) {
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }
  return String(message || "log");
}

function sanitizeMeta(meta) {
  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) {
      continue;
    }
    clean[key] = sanitizeValue(value);
  }
  return clean;
}

function sanitizeValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  return value;
}

function safeJson(payload) {
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      scope: "logger",
      msg: "failed to serialize log payload",
    });
  }
}

module.exports = {
  createLogger,
};

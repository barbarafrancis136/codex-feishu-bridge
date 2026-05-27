const path = require("path");
const os = require("os");

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const ALLOWED_ACCESS_MODES = new Set(["default", "full-access"]);
const ALLOWED_BRIDGE_MODES = new Set(["thin", "standard", "direct"]);

function readConfig() {
  const mode = process.argv[2] || "";

  return {
    mode,
    bridgeMode: readBridgeModeEnv("CODEX_IM_BRIDGE_MODE"),
    bridgePassthroughToCodex: readBooleanEnv("CODEX_IM_BRIDGE_PASSTHROUGH_TO_CODEX", true),
    workspaceAllowlist: readListEnv("CODEX_IM_WORKSPACE_ALLOWLIST"),
    codexEndpoint: process.env.CODEX_IM_CODEX_ENDPOINT || "",
    codexCommand: process.env.CODEX_IM_CODEX_COMMAND || "",
    codexAppServerProfile: readTextEnv("CODEX_IM_CODEX_APP_SERVER_PROFILE"),
    defaultCodexModel: readTextEnv("CODEX_IM_DEFAULT_CODEX_MODEL"),
    defaultCodexEffort: readTextEnv("CODEX_IM_DEFAULT_CODEX_EFFORT"),
    defaultCodexAccessMode: readAccessModeEnv("CODEX_IM_DEFAULT_CODEX_ACCESS_MODE"),
    instanceLabel: readTextEnv("CODEX_IM_INSTANCE_LABEL") || "default",
    feishu: {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
    },
    defaultWorkspaceId: process.env.CODEX_IM_DEFAULT_WORKSPACE_ID || "default",
    feishuStreamingOutput: readBooleanEnv("CODEX_IM_FEISHU_STREAMING_OUTPUT", true),
    feishuCardKitStreaming: readBooleanEnv("CODEX_IM_FEISHU_CARDKIT_STREAMING", true),
    feishuPlainTextFallback: readBooleanEnv("CODEX_IM_FEISHU_PLAIN_TEXT_FALLBACK", false),
    skillRoot: readTextEnv("CODEX_IM_SKILL_ROOT")
      || path.join(os.homedir(), ".codex", "skills"),
    pluginRoot: readTextEnv("CODEX_IM_PLUGIN_ROOT")
      || path.join(os.homedir(), "plugins"),
    marketplaceRoot: readTextEnv("CODEX_IM_MARKETPLACE_ROOT")
      || path.join(os.homedir(), ".agents", "plugins"),
    codexRpcTimeoutMs: readPositiveIntEnv("CODEX_IM_CODEX_RPC_TIMEOUT_MS", 45000),
    codexTurnStartTimeoutMs: readPositiveIntEnv("CODEX_IM_CODEX_TURN_START_TIMEOUT_MS", 60000),
    staleTurnTimeoutMs: readPositiveIntEnv("CODEX_IM_STALE_TURN_TIMEOUT_MS", 30 * 60 * 1000),
    attachmentsDir: resolveAttachmentsDir(),
    maxImageBytes: readPositiveIntEnv("CODEX_IM_MAX_IMAGE_BYTES", 10 * 1024 * 1024),
    maxAttachmentBytes: readPositiveIntEnv("CODEX_IM_MAX_ATTACHMENT_BYTES", 100 * 1024 * 1024),
    sessionsFile: process.env.CODEX_IM_SESSIONS_FILE
      || path.join(os.homedir(), ".codex-im", "sessions.json"),
    morningBriefingEnabled: readBooleanEnv("CODEX_IM_MORNING_BRIEFING_ENABLED", false),
    morningBriefingCron: readTextEnv("CODEX_IM_MORNING_BRIEFING_CRON") || "0 8 * * *",
    morningBriefingTimezone: readTextEnv("CODEX_IM_MORNING_BRIEFING_TIMEZONE") || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    morningBriefingChatId: readTextEnv("CODEX_IM_MORNING_BRIEFING_CHAT_ID"),
    morningBriefingWorkspaceRoot: readTextEnv("CODEX_IM_MORNING_BRIEFING_WORKSPACE_ROOT"),
    morningBriefingModel: readTextEnv("CODEX_IM_MORNING_BRIEFING_MODEL"),
    morningBriefingEffort: readTextEnv("CODEX_IM_MORNING_BRIEFING_EFFORT"),
    morningBriefingAccessMode: readAccessModeEnv("CODEX_IM_MORNING_BRIEFING_ACCESS_MODE"),
    morningBriefingPromptFile: readTextEnv("CODEX_IM_MORNING_BRIEFING_PROMPT_FILE"),
    morningBriefingTitle: readTextEnv("CODEX_IM_MORNING_BRIEFING_TITLE") || "飞书财经晨报",
    appointmentReminderEnabled: readBooleanEnv("CODEX_IM_APPOINTMENT_REMINDER_ENABLED", false),
    appointmentNaturalLanguageInterceptEnabled: readBooleanEnv("CODEX_IM_APPOINTMENT_NL_INTERCEPT_ENABLED", false),
    goalNaturalLanguageInterceptEnabled: readBooleanEnv("CODEX_IM_GOAL_NL_INTERCEPT_ENABLED", true),
    appointmentReminderTimezone: readTextEnv("CODEX_IM_APPOINTMENT_TIMEZONE")
      || Intl.DateTimeFormat().resolvedOptions().timeZone
      || "Asia/Shanghai",
    appointmentReminderScanIntervalSec: readPositiveIntEnv("CODEX_IM_APPOINTMENT_SCAN_INTERVAL_SEC", 60),
    pluginRouteInterceptEnabled: readBooleanEnv("CODEX_IM_PLUGIN_ROUTE_INTERCEPT_ENABLED", false),
    nativeAutomationAvailable: readBooleanEnv("CODEX_IM_NATIVE_AUTOMATION_AVAILABLE", false),
    nativeWakeToFeishuAvailable: readBooleanEnv("CODEX_IM_NATIVE_WAKE_TO_FEISHU_AVAILABLE", false),
    bridgeWakeupEnabled: readBooleanEnv("CODEX_IM_BRIDGE_WAKEUP_ENABLED", true),
    bridgeWakeupScanIntervalSec: readPositiveIntEnv("CODEX_IM_BRIDGE_WAKEUP_SCAN_INTERVAL_SEC", 15),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readBooleanEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }
  return defaultValue;
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveIntEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function readAccessModeEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return ALLOWED_ACCESS_MODES.has(value) ? value : "";
}

function readBridgeModeEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return ALLOWED_BRIDGE_MODES.has(value) ? value : "thin";
}

function resolveAttachmentsDir() {
  const explicit = readTextEnv("CODEX_IM_ATTACHMENTS_DIR");
  if (explicit) {
    return explicit;
  }

  const snapCommonDir = path.join(os.homedir(), "snap", "codex", "common");
  if (isAccessibleDirectory(snapCommonDir)) {
    return path.join(snapCommonDir, ".codex-feishu-attachments");
  }

  return path.join(os.homedir(), ".codex-feishu-bridge", "attachments");
}

function isAccessibleDirectory(targetPath) {
  try {
    return require("fs").statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { readConfig, resolveAttachmentsDir };

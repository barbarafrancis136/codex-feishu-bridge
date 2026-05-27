const { buildBindingMetadata } = require("../infra/codex/message-utils");
const { createLogger } = require("../shared/logger");
const { resolveMorningBriefingPrompt } = require("./prompt");

const logger = createLogger("morning-briefing");
const MORNING_BINDING_KEY = "__morning_briefing__";

function shouldEnableMorningBriefing(config = {}) {
  return Boolean(config.morningBriefingEnabled && config.morningBriefingWorkspaceRoot);
}

async function runMorningBriefing(runtime, { manual = false } = {}) {
  if (!shouldEnableMorningBriefing(runtime.config)) {
    logger.info("morning briefing skipped", { reason: "disabled_or_missing_workspace" });
    return { ok: false, skipped: true, reason: "disabled_or_missing_workspace" };
  }

  const workspaceRoot = String(runtime.config.morningBriefingWorkspaceRoot || "").trim();
  const chatId = resolveMorningBriefingChatId(runtime);
  if (!chatId) {
    logger.warn("morning briefing skipped", { reason: "missing_chat_id" });
    return { ok: false, skipped: true, reason: "missing_chat_id" };
  }

  const stats = await runtime.resolveWorkspaceStats(workspaceRoot);
  if (!stats.exists || !stats.isDirectory) {
    logger.warn("morning briefing skipped", {
      reason: "workspace_unreachable",
      workspaceRoot,
    });
    return { ok: false, skipped: true, reason: "workspace_unreachable" };
  }

  const normalized = buildMorningNormalizedContext(runtime, {
    chatId,
    workspaceRoot,
    manual,
  });
  const prompt = resolveMorningBriefingPrompt(runtime.config);
  applyMorningCodexParams(runtime, workspaceRoot);

  runtime.setPendingBindingContext(MORNING_BINDING_KEY, normalized);

  const { threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey: MORNING_BINDING_KEY,
    workspaceRoot,
    normalized,
    autoSelectThread: false,
  });

  const resolvedThreadId = await runtime.ensureThreadAndSendMessage({
    bindingKey: MORNING_BINDING_KEY,
    workspaceRoot,
    normalized: {
      ...normalized,
      text: prompt,
    },
    threadId,
  });

  logger.info("morning briefing dispatched", {
    manual,
    workspaceRoot,
    chatId,
    threadId: resolvedThreadId,
  });

  return {
    ok: true,
    threadId: resolvedThreadId,
    workspaceRoot,
    chatId,
  };
}

function applyMorningCodexParams(runtime, workspaceRoot) {
  const nextParams = {};
  if (runtime.config.morningBriefingModel) {
    nextParams.model = runtime.config.morningBriefingModel;
  }
  if (runtime.config.morningBriefingEffort) {
    nextParams.effort = runtime.config.morningBriefingEffort;
  }
  if (runtime.config.morningBriefingAccessMode) {
    nextParams.accessMode = runtime.config.morningBriefingAccessMode;
  }
  if (!Object.keys(nextParams).length) {
    return;
  }
  runtime.sessionStore.setCodexParamsForWorkspace(MORNING_BINDING_KEY, workspaceRoot, nextParams);
}

function startMorningBriefingScheduler(runtime) {
  if (!shouldEnableMorningBriefing(runtime.config)) {
    return null;
  }

  const schedule = parseDailyCron(runtime.config.morningBriefingCron);
  const timezone = String(runtime.config.morningBriefingTimezone || "").trim();
  if (!schedule) {
    logger.warn("morning briefing scheduler disabled", {
      reason: "invalid_cron",
      cron: runtime.config.morningBriefingCron,
    });
    return null;
  }

  let timer = null;

  const scheduleNext = () => {
    const delayMs = computeNextDelayMs(schedule, timezone);
    timer = setTimeout(async () => {
      try {
        await runMorningBriefing(runtime, { manual: false });
      } catch (error) {
        logger.error("morning briefing run failed", { error });
      } finally {
        scheduleNext();
      }
    }, delayMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  };

  scheduleNext();
  logger.info("morning briefing scheduler started", {
    cron: runtime.config.morningBriefingCron,
    timezone: runtime.config.morningBriefingTimezone,
  });
  return timer;
}

function resolveMorningBriefingChatId(runtime) {
  const explicit = String(runtime.config.morningBriefingChatId || "").trim();
  if (explicit) {
    return explicit;
  }

  let latestChatId = "";
  let latestUpdatedAt = 0;
  const bindings = runtime.sessionStore.state?.bindings || {};
  for (const binding of Object.values(bindings)) {
    const chatId = String(binding?.chatId || "").trim();
    const updatedAt = Date.parse(String(binding?.updatedAt || ""));
    if (!chatId) {
      continue;
    }
    if (!latestChatId || (Number.isFinite(updatedAt) && updatedAt > latestUpdatedAt)) {
      latestChatId = chatId;
      latestUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : latestUpdatedAt;
    }
  }
  return latestChatId;
}

function buildMorningNormalizedContext(runtime, { chatId, workspaceRoot, manual }) {
  const now = new Date();
  const messageTextPrefix = manual ? "[manual morning briefing]" : "[scheduled morning briefing]";
  return {
    command: "message",
    text: [
      `${messageTextPrefix}`,
      "",
      `标题：${runtime.config.morningBriefingTitle || "飞书晨报"}`,
      `日期：${formatDateForPrompt(now)}`,
      "",
      "请直接输出晨报正文。",
    ].join("\n"),
    chatId,
    messageId: "",
    messageType: "text",
    threadKey: "",
    senderId: "system:morning-briefing",
    workspaceId: runtime.config.defaultWorkspaceId || "default",
    attachments: [],
    metadata: {
      source: "morning-briefing",
      workspaceRoot,
      manual,
    },
  };
}

function parseDailyCron(rawValue) {
  const raw = String(rawValue || "").trim();
  const match = raw.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!match) {
    return null;
  }
  const minute = Number.parseInt(match[1], 10);
  const hour = Number.parseInt(match[2], 10);
  if (
    !Number.isInteger(minute) || minute < 0 || minute > 59
    || !Number.isInteger(hour) || hour < 0 || hour > 23
  ) {
    return null;
  }
  return { hour, minute };
}

function computeNextDelayMs({ hour, minute }) {
  const now = new Date();
  const timezone = arguments[1];

  if (timezone) {
    const currentMinute = truncateToMinute(now);
    for (let offset = 1; offset <= 60 * 48; offset += 1) {
      const candidate = new Date(currentMinute.getTime() + offset * 60 * 1000);
      const zonedParts = getZonedDateParts(candidate, timezone);
      if (!zonedParts) {
        break;
      }
      if (zonedParts.hour === hour && zonedParts.minute === minute) {
        return Math.max(1000, candidate.getTime() - now.getTime());
      }
    }
  }

  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return Math.max(1000, next.getTime() - now.getTime());
}

function truncateToMinute(value) {
  const next = new Date(value);
  next.setSeconds(0, 0);
  return next;
}

function getZonedDateParts(value, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const partMap = {};
    for (const part of formatter.formatToParts(value)) {
      if (part.type !== "literal") {
        partMap[part.type] = part.value;
      }
    }
    return {
      year: Number.parseInt(partMap.year || "", 10),
      month: Number.parseInt(partMap.month || "", 10),
      day: Number.parseInt(partMap.day || "", 10),
      hour: Number.parseInt(partMap.hour || "", 10),
      minute: Number.parseInt(partMap.minute || "", 10),
      second: Number.parseInt(partMap.second || "", 10),
    };
  } catch (error) {
    logger.warn("invalid morning briefing timezone; falling back to server local time", {
      timezone,
      error,
    });
    return null;
  }
}

function formatDateForPrompt(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = {
  MORNING_BINDING_KEY,
  buildMorningNormalizedContext,
  runMorningBriefing,
  shouldEnableMorningBriefing,
  startMorningBriefingScheduler,
  resolveMorningBriefingChatId,
  parseDailyCron,
  computeNextDelayMs,
};

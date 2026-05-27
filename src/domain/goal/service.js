const { createLogger } = require("../../shared/logger");

const logger = createLogger("goal");

const GOAL_MODE_MARKERS = [
  /goal\s*模式/i,
  /\bgoal\s*mode\b/i,
  /当成目标/,
  /作为目标/,
  /按目标模式/,
];

const GENERIC_GOAL_TEXT = "持续完成当前用户请求，直到完成";

function handlePotentialGoalMessage(runtime, normalized) {
  if (normalized?.command !== "message" || !normalized?.text || !runtime?.sessionStore) {
    return Promise.resolve(normalized);
  }

  const binding = resolveGoalBinding(runtime, normalized);
  if (!binding.bindingKey) {
    return Promise.resolve(normalized);
  }

  const currentGoal = binding.workspaceRoot
    ? runtime.sessionStore.getGoalForWorkspace(binding.bindingKey, binding.workspaceRoot)
    : runtime.sessionStore.getChatGoal(binding.bindingKey);
  const currentGoalState = binding.workspaceRoot
    ? runtime.sessionStore.getGoalStateForWorkspace(binding.bindingKey, binding.workspaceRoot)
    : runtime.sessionStore.getChatGoalState(binding.bindingKey);

  const parsed = parseNaturalLanguageGoalIntent(normalized.text, { currentGoal });
  if (!parsed.intentDetected) {
    return Promise.resolve(normalized);
  }

  const nextGoal = parsed.goal || currentGoal || GENERIC_GOAL_TEXT;
  const goalChanged = normalizeText(nextGoal) !== normalizeText(currentGoal);

  if (binding.workspaceRoot) {
    runtime.sessionStore.setGoalForWorkspace(binding.bindingKey, binding.workspaceRoot, nextGoal);
  } else {
    runtime.sessionStore.setChatGoal(binding.bindingKey, nextGoal);
  }

  if (shouldRefreshBootstrapState(currentGoalState, { goalChanged, parsed })) {
    const bootstrapState = buildBootstrapGoalState(parsed);
    if (binding.workspaceRoot) {
      runtime.sessionStore.setGoalStateForWorkspace(binding.bindingKey, binding.workspaceRoot, bootstrapState);
    } else {
      runtime.sessionStore.setChatGoalState(binding.bindingKey, bootstrapState);
    }
  }

  logger.info("goal bootstrapped from natural language", {
    bindingKey: binding.bindingKey,
    workspaceRoot: binding.workspaceRoot,
    goalChanged,
    goalText: nextGoal,
    messageId: normalized.messageId || "",
  });

  return Promise.resolve({
    ...normalized,
    goalBootstrap: {
      goal: nextGoal,
      scope: binding.workspaceRoot ? "project" : "chat",
      changed: goalChanged,
    },
  });
}

function parseNaturalLanguageGoalIntent(text, { currentGoal = "" } = {}) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    return { intentDetected: false, goal: "" };
  }

  const explicitGoal = extractExplicitGoal(rawText);
  if (explicitGoal) {
    return {
      intentDetected: true,
      goal: explicitGoal,
      activationRequested: true,
      explicitGoal: true,
      usedFallbackGoal: false,
    };
  }

  const hasGoalModeMarker = GOAL_MODE_MARKERS.some((pattern) => pattern.test(rawText));
  if (!hasGoalModeMarker) {
    return { intentDetected: false, goal: "" };
  }

  const derivedGoal = deriveGoalFromActivationText(rawText);
  return {
    intentDetected: true,
    goal: derivedGoal || normalizeText(currentGoal) || GENERIC_GOAL_TEXT,
    activationRequested: true,
    explicitGoal: Boolean(derivedGoal),
    usedFallbackGoal: !derivedGoal && !normalizeText(currentGoal),
  };
}

function extractExplicitGoal(text) {
  const normalized = String(text || "").trim();
  const colonMatch = normalized.match(/^(?:当前)?目标(?:(?:是|为)\s*|[：:]\s*|\s+)(.+)$/i);
  if (colonMatch?.[1]) {
    return cleanupGoalText(colonMatch[1]);
  }

  const quotedMatch = normalized.match(/(?:把|将)(.+?)(?:当成|作为)目标/i);
  if (quotedMatch?.[1]) {
    return cleanupGoalText(quotedMatch[1]);
  }

  const asGoalMatch = normalized.match(/以(.+?)为目标/i);
  if (asGoalMatch?.[1]) {
    return cleanupGoalText(asGoalMatch[1]);
  }

  return "";
}

function deriveGoalFromActivationText(text) {
  let candidate = String(text || "").trim();
  candidate = candidate.replace(/^(?:好|好的|行|继续|全部继续|那|然后|对|嗯)[，,。.\s]*/i, "");
  candidate = candidate.replace(/按\s*goal\s*模式(?:去做|来做|继续|推进|执行)?/ig, " ");
  candidate = candidate.replace(/用\s*goal\s*模式(?:去做|来做|继续|推进|执行)?/ig, " ");
  candidate = candidate.replace(/goal\s*模式/ig, " ");
  candidate = candidate.replace(/\bgoal\s*mode\b/ig, " ");
  candidate = candidate.replace(/(?:当成|作为)目标/ig, " ");
  candidate = candidate.replace(/[，,。.!！?？;；:：]+/g, " ");
  candidate = candidate.replace(/\s+/g, " ").trim();
  return cleanupGoalText(candidate);
}

function cleanupGoalText(text) {
  const normalized = normalizeText(text)
    .replace(/^(?:当前)?目标(?:是|为)?\s*/i, "")
    .replace(/^(?:就是|先|请|把|将)\s*/i, "")
    .replace(/[\s，,。.!！?？;；:：]*(?:按|用)\s*goal\s*模式(?:去做|来做|继续|推进|执行)?$/ig, "")
    .replace(/\s*(?:直到完成|一直做完)?\s*$/i, (match) => match)
    .trim();
  if (!normalized) {
    return "";
  }
  const significantLength = normalized.replace(/[\s，,。.!！?？;；:："'“”‘’`]/g, "").length;
  return significantLength >= 3 ? normalized : "";
}

function buildBootstrapGoalState(parsed) {
  const summary = parsed.usedFallbackGoal
    ? "已根据这条消息激活 goal 模式。"
    : "已从最新用户消息中提取并写入目标。";
  return {
    status: "active",
    stage: parsed.explicitGoal ? "目标已接收" : "goal 模式已激活",
    nextStep: "继续按当前目标推进最直接的下一步",
    summary,
  };
}

function shouldRefreshBootstrapState(currentGoalState, { goalChanged, parsed }) {
  if (goalChanged) {
    return true;
  }
  if (parsed.activationRequested && isTerminalGoalState(currentGoalState)) {
    return true;
  }
  return !hasGoalState(currentGoalState);
}

function hasGoalState(goalState) {
  const state = goalState && typeof goalState === "object" ? goalState : {};
  return Boolean(
    normalizeText(state.status)
    || normalizeText(state.stage)
    || normalizeText(state.nextStep || state.next_step)
    || normalizeText(state.summary)
  );
}

function isTerminalGoalState(goalState) {
  const status = normalizeText(goalState?.status).toLowerCase();
  return status === "blocked" || status === "completed";
}

function resolveGoalBinding(runtime, normalized) {
  if (typeof runtime?.getBindingContext === "function") {
    const binding = runtime.getBindingContext(normalized) || {};
    return {
      bindingKey: normalizeText(binding.bindingKey),
      workspaceRoot: normalizeText(binding.workspaceRoot),
    };
  }
  if (typeof runtime?.getCurrentThreadContext === "function") {
    const binding = runtime.getCurrentThreadContext(normalized) || {};
    return {
      bindingKey: normalizeText(binding.bindingKey),
      workspaceRoot: normalizeText(binding.workspaceRoot),
    };
  }
  return { bindingKey: "", workspaceRoot: "" };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  GENERIC_GOAL_TEXT,
  handlePotentialGoalMessage,
  parseNaturalLanguageGoalIntent,
};

const { normalizeEvolutionPayload } = require("../../infra/memory/evolving-memory-store");

const GOAL_STATE_DIRECTIVE_RE = /\[\[codex-goal-state:(.*?)\]\]/gs;
const MEMORY_EVOLUTION_DIRECTIVE_RE = /\[\[codex-memory-evolution:(.*?)\]\]/gs;

function parseAndPersistReplyDirectives({
  event,
  runtime,
  text,
  structuredStore = null,
  memoryUserId = "",
} = {}) {
  const rawText = String(text || "");
  const goalMatches = Array.from(rawText.matchAll(GOAL_STATE_DIRECTIVE_RE));
  const memoryMatches = Array.from(rawText.matchAll(MEMORY_EVOLUTION_DIRECTIVE_RE));

  const chatContext = event?.payload?.normalized || null;
  const bindingKey = chatContext && runtime?.sessionStore?.buildBindingKey
    ? runtime.sessionStore.buildBindingKey(chatContext)
    : "";
  const workspaceRoot = resolveWorkspaceRootForDirective(runtime, bindingKey, chatContext);

  const latestGoalDirective = normalizeGoalStatePayload(goalMatches[goalMatches.length - 1]?.[1] || "");
  if (bindingKey && latestGoalDirective && !isDirectBridgeMode(runtime)) {
    persistGoalStateDirective(runtime, {
      bindingKey,
      workspaceRoot,
      goalState: latestGoalDirective,
    });
  }

  const latestMemoryDirective = normalizeMemoryEvolutionPayload(memoryMatches[memoryMatches.length - 1]?.[1] || "");
  if (memoryUserId && structuredStore?.isEnabled?.() && hasMemoryEvolution(latestMemoryDirective)) {
    structuredStore.applyEvolution({
      userId: memoryUserId,
      evolution: latestMemoryDirective,
      metadata: {
        source: "codex-1",
      },
    });
  }

  const cleanedText = stripReplyDirectives(rawText);
  return {
    cleanedText,
    assistantMessage: cleanedText,
    goalState: latestGoalDirective,
    memoryEvolution: latestMemoryDirective,
  };
}

function stripReplyDirectives(text) {
  return String(text || "")
    .replace(GOAL_STATE_DIRECTIVE_RE, "")
    .replace(MEMORY_EVOLUTION_DIRECTIVE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveWorkspaceRootForDirective(runtime, bindingKey, chatContext) {
  const chatWorkspaceRoot = String(chatContext?.workspaceRoot || "").trim();
  if (chatWorkspaceRoot) {
    return chatWorkspaceRoot;
  }
  if (!bindingKey) {
    return "";
  }
  if (typeof runtime?.resolveWorkspaceRootForBinding === "function") {
    return String(runtime.resolveWorkspaceRootForBinding(bindingKey) || "").trim();
  }
  if (typeof runtime?.sessionStore?.getActiveWorkspaceRoot === "function") {
    return String(runtime.sessionStore.getActiveWorkspaceRoot(bindingKey) || "").trim();
  }
  return "";
}

function normalizeGoalStatePayload(rawDirective) {
  const payloadText = String(rawDirective || "").trim();
  if (!payloadText) {
    return null;
  }
  try {
    const parsed = JSON.parse(payloadText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const normalized = {
      status: normalizeInlineValue(parsed.status).toLowerCase(),
      stage: normalizeInlineValue(parsed.stage),
      nextStep: normalizeInlineValue(parsed.nextStep || parsed.next_step),
      summary: normalizeInlineValue(parsed.summary),
    };
    return normalized.status || normalized.stage || normalized.nextStep || normalized.summary
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function normalizeMemoryEvolutionPayload(rawDirective) {
  const payloadText = String(rawDirective || "").trim();
  if (!payloadText) {
    return null;
  }
  try {
    const parsed = JSON.parse(payloadText);
    return normalizeEvolutionPayload(parsed);
  } catch {
    return null;
  }
}

function hasMemoryEvolution(evolution) {
  return !!(
    evolution
    && (
      (Array.isArray(evolution.upserts) && evolution.upserts.length > 0)
      || (Array.isArray(evolution.deleteKeys) && evolution.deleteKeys.length > 0)
      || normalizeInlineValue(evolution.profileSummary)
    )
  );
}

function persistGoalStateDirective(runtime, { bindingKey, workspaceRoot, goalState }) {
  if (workspaceRoot && typeof runtime?.sessionStore?.setGoalStateForWorkspace === "function") {
    runtime.sessionStore.setGoalStateForWorkspace(bindingKey, workspaceRoot, goalState);
    return;
  }
  if (typeof runtime?.sessionStore?.setChatGoalState === "function") {
    runtime.sessionStore.setChatGoalState(bindingKey, goalState);
  }
}

function normalizeInlineValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isDirectBridgeMode(runtime) {
  return String(runtime?.config?.bridgeMode || "").trim().toLowerCase() === "direct";
}

module.exports = {
  parseAndPersistReplyDirectives,
  stripReplyDirectives,
  normalizeGoalStatePayload,
  normalizeMemoryEvolutionPayload,
};

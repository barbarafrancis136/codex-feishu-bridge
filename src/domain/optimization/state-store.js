const fs = require("fs");
const { ensureOptimizationStateDir, resolveOptimizationStatePaths } = require("./paths");

class OptimizationStateStore {
  constructor({ sessionsFile }) {
    this.sessionsFile = sessionsFile;
    this.paths = resolveOptimizationStatePaths(sessionsFile);
    ensureOptimizationStateDir(sessionsFile);
  }

  getLatestScore() {
    return readJsonFile(this.paths.latestScore, null);
  }

  setLatestScore(value) {
    writeJsonFile(this.paths.latestScore, value);
    return value;
  }

  getPreviousScore() {
    return readJsonFile(this.paths.previousScore, null);
  }

  setPreviousScore(value) {
    writeJsonFile(this.paths.previousScore, value);
    return value;
  }

  getWeeklySummary() {
    return normalizeWeeklySummary(readJsonFile(this.paths.weeklySummary, null));
  }

  setWeeklySummary(value) {
    const next = normalizeWeeklySummary(value);
    writeJsonFile(this.paths.weeklySummary, next);
    return next;
  }

  getEffectiveState() {
    return normalizeEffectiveState(readJsonFile(this.paths.effectiveState, null));
  }

  setEffectiveState(value) {
    const next = normalizeEffectiveState(value);
    writeJsonFile(this.paths.effectiveState, next);
    return next;
  }

  getRollbackState() {
    return normalizeEffectiveState(readJsonFile(this.paths.rollbackState, null));
  }

  setRollbackState(value) {
    const next = normalizeEffectiveState(value);
    writeJsonFile(this.paths.rollbackState, next);
    return next;
  }

  getProjectDurableMemory() {
    return normalizeMemoryCollection(readJsonFile(this.paths.projectDurableMemory, null), "project");
  }

  setProjectDurableMemory(value) {
    const next = normalizeMemoryCollection(value, "project");
    writeJsonFile(this.paths.projectDurableMemory, next);
    return next;
  }

  getGlobalDurableMemory() {
    return normalizeMemoryCollection(readJsonFile(this.paths.globalDurableMemory, null), "global");
  }

  setGlobalDurableMemory(value) {
    const next = normalizeMemoryCollection(value, "global");
    writeJsonFile(this.paths.globalDurableMemory, next);
    return next;
  }

  getGlobalPromotionCandidates() {
    return normalizeMemoryCollection(readJsonFile(this.paths.globalPromotionCandidates, null), "candidate");
  }

  setGlobalPromotionCandidates(value) {
    const next = normalizeMemoryCollection(value, "candidate");
    writeJsonFile(this.paths.globalPromotionCandidates, next);
    return next;
  }
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return cloneValue(fallback);
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return cloneValue(fallback);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeWeeklySummary(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    weekKey: normalizeString(input.weekKey),
    updatedAt: normalizeString(input.updatedAt),
    runCount: normalizeNumber(input.runCount, 0),
    lastMode: normalizeString(input.lastMode),
    lastSurface: normalizeString(input.lastSurface),
    policies: normalizeObjectMap(input.policies, normalizeWeeklyPolicy),
    promotionTrackers: normalizeObjectMap(input.promotionTrackers, normalizePromotionTracker),
    audit: normalizeAudit(input.audit),
  };
}

function normalizeWeeklyPolicy(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    policyKey: normalizeString(input.policyKey),
    summary: normalizeString(input.summary),
    applyNotes: normalizeString(input.applyNotes),
    stableSignals: normalizeStringArray(input.stableSignals),
    hitWeeks: normalizeNumber(input.hitWeeks, 0),
    coldWeeks: normalizeNumber(input.coldWeeks, 0),
    lastScore: normalizeNumber(input.lastScore, 0),
    lastRuleScore: normalizeNumber(input.lastRuleScore, 0),
    lastLlmScore: normalizeNumber(input.lastLlmScore, 0),
    lastDelta: normalizeNumber(input.lastDelta, 0),
    lastHitWeek: normalizeString(input.lastHitWeek),
    lastColdWeek: normalizeString(input.lastColdWeek),
    regression: Boolean(input.regression),
    effective: Boolean(input.effective),
    state: normalizeString(input.state),
    updatedAt: normalizeString(input.updatedAt),
  };
}

function normalizePromotionTracker(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    policyKey: normalizeString(input.policyKey),
    workspaceRoot: normalizeString(input.workspaceRoot),
    instanceLabel: normalizeString(input.instanceLabel),
    consecutiveEffectiveWeeks: normalizeNumber(input.consecutiveEffectiveWeeks, 0),
    lastEffectiveWeek: normalizeString(input.lastEffectiveWeek),
    lastObservedWeek: normalizeString(input.lastObservedWeek),
    updatedAt: normalizeString(input.updatedAt),
  };
}

function normalizeEffectiveState(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    updatedAt: normalizeString(input.updatedAt),
    source: normalizeString(input.source),
    previousUpdatedAt: normalizeString(input.previousUpdatedAt),
    projectSummaries: normalizeStringArray(input.projectSummaries),
    globalSummaries: normalizeStringArray(input.globalSummaries),
    routing: normalizeRouting(input.routing),
    notes: normalizeStringArray(input.notes),
    governance: normalizeGovernance(input.governance),
  };
}

function normalizeRouting(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    minRouteScore: normalizeNumber(input.minRouteScore, 2),
    ambiguousScoreGap: normalizeNumber(input.ambiguousScoreGap, 1),
  };
}

function normalizeGovernance(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    weekly: normalizeAudit(input.weekly),
    project: normalizeAudit(input.project),
    global: normalizeAudit(input.global),
    candidate: normalizeAudit(input.candidate),
  };
}

function normalizeAudit(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    lastCompactedAt: normalizeString(input.lastCompactedAt),
    dedupedItems: normalizeNumber(input.dedupedItems, 0),
    trimmedItems: normalizeNumber(input.trimmedItems, 0),
    trimmedSignals: normalizeNumber(input.trimmedSignals, 0),
    cappedPolicies: normalizeNumber(input.cappedPolicies, 0),
    itemCount: normalizeNumber(input.itemCount, 0),
    maxItems: normalizeNumber(input.maxItems, 0),
    storagePressure: normalizeString(input.storagePressure) || "normal",
    notes: normalizeStringArray(input.notes),
  };
}

function normalizeMemoryCollection(raw, kind) {
  const input = raw && typeof raw === "object" ? raw : {};
  const items = Array.isArray(input.items)
    ? input.items.map((item) => normalizeMemoryRecord(item, kind)).filter(Boolean)
    : [];
  return {
    version: 1,
    updatedAt: normalizeString(input.updatedAt),
    items,
    audit: normalizeAudit(input.audit),
  };
}

function normalizeMemoryRecord(raw, kind) {
  const input = raw && typeof raw === "object" ? raw : {};
  const policyKey = normalizeString(input.policyKey);
  const summary = normalizeString(input.summary);
  const workspaceRoot = normalizeString(input.workspaceRoot);
  const instanceLabel = normalizeString(input.instanceLabel);
  const state = normalizeString(input.state) || defaultMemoryState(kind);
  if (!policyKey || !summary) {
    return null;
  }
  return {
    memoryId: normalizeString(input.memoryId) || normalizeString(input.candidateId),
    candidateId: normalizeString(input.candidateId),
    policyKey,
    workspaceRoot,
    instanceLabel,
    summary,
    applyNotes: normalizeString(input.applyNotes),
    stableSignals: normalizeStringArray(input.stableSignals),
    sourceProjects: normalizeStringArray(input.sourceProjects),
    hitWeeks: normalizeNumber(input.hitWeeks, 0),
    coldWeeks: normalizeNumber(input.coldWeeks, 0),
    strength: normalizeNumber(input.strength, 0),
    lastHitWeek: normalizeString(input.lastHitWeek),
    lastColdWeek: normalizeString(input.lastColdWeek),
    updatedAt: normalizeString(input.updatedAt),
    lastUpdatedAt: normalizeString(input.lastUpdatedAt),
    state,
    regression: Boolean(input.regression),
  };
}

function defaultMemoryState(kind) {
  if (kind === "candidate") {
    return "candidate";
  }
  return "active";
}

function normalizeObjectMap(raw, normalizer) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = normalizeString(key);
    if (!normalizedKey) {
      continue;
    }
    out[normalizedKey] = normalizer(value);
  }
  return out;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => normalizeString(item)).filter(Boolean);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cloneValue(value) {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  OptimizationStateStore,
};

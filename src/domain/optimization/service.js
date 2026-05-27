const crypto = require("crypto");
const path = require("path");
const { OptimizationStateStore } = require("./state-store");
const optimizationScores = require("../../../scripts/run-optimization-scores");

const DEFAULT_EFFECTIVE_SCORE = 70;
const DEFAULT_COLD_SCORE = 50;
const PROJECT_PROMOTION_STREAK = 3;
const PROJECT_COOLING_START = 4;
const PROJECT_DELETE_AFTER = 6;
const GLOBAL_DEMOTE_AFTER = 6;
const MAX_WEEKLY_POLICIES = 24;
const MAX_PROJECT_MEMORY_ITEMS_PER_SCOPE = 24;
const MAX_GLOBAL_MEMORY_ITEMS = 24;
const MAX_GLOBAL_CANDIDATES = 32;
const MAX_STABLE_SIGNALS = 8;
const MAX_SOURCE_PROJECTS = 8;
const MAX_WEEKLY_PROMOTION_TRACKERS = 48;
const STORAGE_PRESSURE_HIGH_WATERMARK = 0.75;

function createOptimizationManager({ sessionsFile, instanceLabel = "default" }) {
  const store = new OptimizationStateStore({ sessionsFile });

  return {
    store,
    async handleCommand({ surface, normalized, runtime }) {
      return handleOptimizationCommand(store, {
        surface,
        normalized,
        runtime,
        instanceLabel,
      });
    },
    async handleRollback({ surface, normalized, runtime }) {
      return handleRollbackCommand(store, { surface, normalized, runtime, instanceLabel });
    },
    async buildDoctorSection({ runtime, bindingKey = "", workspaceRoot = "" } = {}) {
      return buildDoctorSection(store, { runtime, bindingKey, workspaceRoot, instanceLabel });
    },
    async buildMessagePrefix({ runtime, normalized } = {}) {
      return buildMessagePrefix(store, { runtime, normalized, instanceLabel });
    },
    getRoutingHints() {
      return getRoutingHints(store);
    },
    getMemorySummary({ runtime, bindingKey = "", workspaceRoot = "" } = {}) {
      return buildMemorySummary(store, { runtime, bindingKey, workspaceRoot, instanceLabel });
    },
    async promoteGlobal(candidateId) {
      return promoteGlobalCandidate(store, candidateId, instanceLabel);
    },
    async rejectGlobal(targetId) {
      return rejectGlobalMemory(store, targetId, instanceLabel);
    },
  };
}

async function handleOptimizationCommand(store, { surface, normalized, runtime, instanceLabel }) {
  const context = runtime.getBindingContext(normalized);
  const mode = parseOptimizationCommandMode(normalized.text, surface);

  if (mode.action === "memory") {
    const text = buildMemorySummary(store, {
      runtime,
      bindingKey: context.bindingKey,
      workspaceRoot: context.workspaceRoot,
      instanceLabel,
    });
    return sendOptimizationText(runtime, normalized, text);
  }

  if (mode.action === "rollback") {
    return handleRollbackCommand(store, {
      surface,
      normalized,
      runtime,
      instanceLabel,
    });
  }

  if (mode.action === "promote" && mode.scope === "global") {
    const result = await promoteGlobalCandidate(store, mode.targetId, instanceLabel);
    return sendOptimizationText(runtime, normalized, result.message);
  }

  if (mode.action === "reject" && mode.scope === "global") {
    const result = await rejectGlobalMemory(store, mode.targetId, instanceLabel);
    return sendOptimizationText(runtime, normalized, result.message);
  }

  const assessment = await runScoreAssessment(mode.mode);
  const nextReport = updateOptimizationState(store, {
    assessment,
    surface,
    normalized,
    runtime,
    bindingKey: context.bindingKey,
    workspaceRoot: context.workspaceRoot,
    instanceLabel,
  });
  return sendOptimizationText(runtime, normalized, nextReport.text);
}

async function handleRollbackCommand(store, { surface, normalized, runtime, instanceLabel }) {
  const effectiveState = store.getEffectiveState();
  const rollbackState = store.getRollbackState();
  if (!rollbackState || !rollbackState.updatedAt) {
    return sendOptimizationText(runtime, normalized, formatSimpleMessage(surface, "没有可回滚的有效态。"));
  }
  store.setEffectiveState({
    ...rollbackState,
    source: `${surface}:rollback`,
    previousUpdatedAt: effectiveState.updatedAt || "",
    updatedAt: new Date().toISOString(),
  });
  return sendOptimizationText(runtime, normalized, formatRollbackMessage(surface, rollbackState));
}

async function runScoreAssessment(mode) {
  const normalizedMode = String(mode || "all").trim().toLowerCase();
  const engine = ensureOptimizationScoreEngine();
  return engine.runOptimizationScores(normalizedMode);
}

function ensureOptimizationScoreEngine() {
  if (!optimizationScores || typeof optimizationScores.runOptimizationScores !== "function") {
    throw new Error("optimization score engine is unavailable");
  }
  return optimizationScores;
}

function parseOptimizationCommandMode(text, surface) {
  const raw = String(text || "").trim();
  const prefix = surface === "eval" ? "/codex eval" : "/codex score";
  const remainder = raw.toLowerCase().startsWith(prefix)
    ? raw.slice(prefix.length).trim()
    : "";
  const tokens = remainder ? remainder.split(/\s+/).filter(Boolean) : [];
  const [first = "", second = "", third = ""] = tokens;
  if (!first) {
    return { action: "run", mode: "all", scope: "", targetId: "" };
  }
  if (["system", "bridge", "bot", "all"].includes(first)) {
    return { action: "run", mode: first, scope: "", targetId: "" };
  }
  if (first === "rollback") {
    return { action: "rollback", mode: "", scope: "", targetId: "" };
  }
  if (first === "memory") {
    return { action: "memory", mode: "", scope: "", targetId: "" };
  }
  if (first === "promote" && second === "global" && third) {
    return { action: "promote", mode: "", scope: "global", targetId: third };
  }
  if (first === "reject" && second === "global" && third) {
    return { action: "reject", mode: "", scope: "global", targetId: third };
  }
  return { action: "run", mode: first, scope: "", targetId: "" };
}

function updateOptimizationState(store, {
  assessment,
  surface,
  normalized,
  runtime,
  bindingKey,
  workspaceRoot,
  instanceLabel,
}) {
  const now = new Date().toISOString();
  const previousScore = store.getLatestScore();
  const latestScore = buildScoreSnapshot(assessment, {
    surface,
    bindingKey,
    workspaceRoot,
    instanceLabel,
    now,
    previousScore,
  });
  if (previousScore) {
    store.setPreviousScore(previousScore);
  }
  store.setLatestScore(latestScore);

  const weeklySummary = compactWeeklySummary(mergeWeeklySummary(store.getWeeklySummary(), latestScore), { now });
  store.setWeeklySummary(weeklySummary);

  const projectUpdate = updateProjectDurableMemory(store.getProjectDurableMemory(), weeklySummary, latestScore, {
    instanceLabel,
    workspaceRoot,
    now,
  });
  store.setProjectDurableMemory(projectUpdate.memory);

  const candidateUpdate = updateGlobalCandidates(store.getGlobalPromotionCandidates(), projectUpdate.memory, {
    now,
  });
  store.setGlobalPromotionCandidates(candidateUpdate.memory);

  const globalUpdate = updateGlobalDurableMemory(store.getGlobalDurableMemory(), candidateUpdate.memory, {
    now,
  });
  store.setGlobalDurableMemory(globalUpdate.memory);

  const effectiveState = buildEffectiveState({
    latestScore,
    weeklySummary,
    projectMemory: projectUpdate.memory.items,
    projectAudit: projectUpdate.memory.audit,
    globalMemory: globalUpdate.memory.items,
    globalAudit: globalUpdate.memory.audit,
    candidateMemory: candidateUpdate.memory.items,
    candidateAudit: candidateUpdate.memory.audit,
    previousEffectiveState: store.getEffectiveState(),
    now,
  });
  const previousEffective = store.getEffectiveState();
  if (previousEffective?.updatedAt) {
    store.setRollbackState(previousEffective);
  }
  store.setEffectiveState(effectiveState);

  return {
    text: buildAssessmentText({
      surface,
      latestScore,
      weeklySummary,
      projectMemory: projectUpdate.memory.items,
      projectAudit: projectUpdate.memory.audit,
      globalMemory: globalUpdate.memory.items,
      globalAudit: globalUpdate.memory.audit,
      candidateMemory: candidateUpdate.memory.items,
      candidateAudit: candidateUpdate.memory.audit,
      effectiveState,
      previousScore,
    }),
  };
}

function buildScoreSnapshot(assessment, { surface, bindingKey, workspaceRoot, instanceLabel, now, previousScore }) {
  const score = Number(assessment?.score || 0);
  const ruleScore = Number(assessment?.ruleScore ?? score);
  const llmScore = Number(assessment?.llmScore ?? score);
  const delta = Number.isFinite(Number(previousScore?.score)) ? score - Number(previousScore.score) : score;
  const results = Array.isArray(assessment?.results) ? assessment.results : [];
  const sourceLabel = `${surface || "score"}:${assessment?.mode || "all"}`;
  return {
    version: 1,
    kind: surface || "score",
    mode: assessment?.mode || "all",
    source: sourceLabel,
    instanceLabel,
    workspaceRoot,
    bindingKey,
    score,
    ruleScore,
    llmScore,
    delta,
    weekKey: buildWeekKey(new Date(now)),
    createdAt: now,
    checks: results.map((item) => ({
      policyKey: normalizePolicyKey(item.policyKey || item.name || item.title || assessment?.mode || "all"),
      title: String(item.title || item.name || item.policyKey || "").trim(),
      score: Number(item.score || 0),
      ruleScore: Number(item.ruleScore ?? item.score ?? 0),
      llmScore: Number(item.llmScore ?? item.score ?? 0),
      summary: String(item.summary || item.description || "").trim(),
      applyNotes: String(item.applyNotes || "").trim(),
      stableSignals: limitStrings(normalizeList(item.stableSignals), MAX_STABLE_SIGNALS),
      regression: Boolean(item.regression),
      effective: Boolean(item.effective ?? (Number(item.score || 0) >= DEFAULT_EFFECTIVE_SCORE)),
    })),
    summary: String(assessment?.summary || "").trim(),
    title: String(assessment?.title || assessment?.mode || "optimization").trim(),
  };
}

function mergeWeeklySummary(previousWeekly, latestScore) {
  const currentWeek = latestScore.weekKey;
  const weekKey = String(previousWeekly?.weekKey || "");
  const isSameWeek = weekKey === currentWeek;
  const policies = isSameWeek ? normalizeObject(previousWeekly?.policies) : {};
  const promotionTrackers = normalizeObject(previousWeekly?.promotionTrackers);
  const next = {
    version: 1,
    weekKey: currentWeek,
    updatedAt: latestScore.createdAt,
    runCount: isSameWeek ? Number(previousWeekly?.runCount || 0) + 1 : 1,
    lastMode: latestScore.mode,
    lastSurface: latestScore.kind,
    policies: { ...policies },
    promotionTrackers: { ...promotionTrackers },
  };

  for (const check of latestScore.checks) {
    const previousPolicy = policies[check.policyKey] || createEmptyWeeklyPolicy(check.policyKey);
    const effective = Boolean(check.effective && !check.regression);
    const alreadyHitThisWeek = previousPolicy.lastHitWeek === currentWeek;
    const alreadyColdThisWeek = previousPolicy.lastColdWeek === currentWeek;
    const hitWeeks = effective
      ? (alreadyHitThisWeek ? Number(previousPolicy.hitWeeks || 0) : Number(previousPolicy.hitWeeks || 0) + 1)
      : Number(previousPolicy.hitWeeks || 0);
    const coldWeeks = effective
      ? 0
      : (alreadyColdThisWeek ? Number(previousPolicy.coldWeeks || 0) : Number(previousPolicy.coldWeeks || 0) + 1);
    next.policies[check.policyKey] = {
      ...previousPolicy,
      policyKey: check.policyKey,
      summary: check.summary || previousPolicy.summary || latestScore.summary || latestScore.title,
      applyNotes: check.applyNotes || previousPolicy.applyNotes || "",
      stableSignals: limitStrings([...((previousPolicy.stableSignals || [])), ...check.stableSignals], MAX_STABLE_SIGNALS),
      hitWeeks,
      coldWeeks,
      lastScore: check.score,
      lastRuleScore: check.ruleScore,
      lastLlmScore: check.llmScore,
      lastDelta: latestScore.delta,
      lastHitWeek: effective ? currentWeek : previousPolicy.lastHitWeek || "",
      lastColdWeek: effective ? "" : currentWeek,
      regression: Boolean(check.regression),
      effective,
      state: effective ? "effective" : "cooling",
      updatedAt: latestScore.createdAt,
    };

    const trackerKey = buildPromotionTrackerKey(
      check.policyKey,
      latestScore.workspaceRoot,
      latestScore.instanceLabel
    );
    next.promotionTrackers[trackerKey] = updatePromotionTracker(
      next.promotionTrackers[trackerKey],
      {
        policyKey: check.policyKey,
        workspaceRoot: latestScore.workspaceRoot,
        instanceLabel: latestScore.instanceLabel,
        effective,
        regression: Boolean(check.regression),
        currentWeek,
        updatedAt: latestScore.createdAt,
      }
    );
  }

  return compactWeeklySummary(next, { now: latestScore.createdAt });
}

function updateProjectDurableMemory(previousMemory, weeklySummary, latestScore, { instanceLabel, workspaceRoot, now }) {
  const items = Array.isArray(previousMemory?.items) ? previousMemory.items.slice() : [];
  const weekPolicies = weeklySummary?.policies || {};
  const promotionTrackers = weeklySummary?.promotionTrackers || {};
  const activeWorkspaceRoot = String(workspaceRoot || "").trim();

  for (const [policyKey, policy] of Object.entries(weekPolicies)) {
    if (!activeWorkspaceRoot) {
      continue;
    }
    const index = items.findIndex((item) => item.policyKey === policyKey
      && item.workspaceRoot === activeWorkspaceRoot
      && item.instanceLabel === instanceLabel);
    const effective = Boolean(policy.effective && !policy.regression);
    const trackerKey = buildPromotionTrackerKey(policyKey, activeWorkspaceRoot, instanceLabel);
    const tracker = promotionTrackers[trackerKey] || null;
    const promotionStreak = Math.max(
      Number(policy.hitWeeks || 0),
      Number(tracker?.consecutiveEffectiveWeeks || 0)
    );
    if (index < 0) {
      if (!effective || promotionStreak < PROJECT_PROMOTION_STREAK) {
        continue;
      }
      items.push({
        memoryId: buildMemoryId("project", policyKey, activeWorkspaceRoot, instanceLabel),
        policyKey,
        workspaceRoot: activeWorkspaceRoot,
        instanceLabel,
        summary: policy.summary || latestScore.summary || latestScore.title,
        applyNotes: policy.applyNotes || "",
        stableSignals: limitStrings(policy.stableSignals || [], MAX_STABLE_SIGNALS),
        hitWeeks: Math.max(PROJECT_PROMOTION_STREAK, promotionStreak),
        coldWeeks: 0,
        strength: 70,
        lastHitWeek: policy.lastHitWeek || latestScore.weekKey,
        lastColdWeek: "",
        lastUpdatedAt: now,
        state: "active",
        regression: Boolean(policy.regression),
      });
      continue;
    }

    const current = items[index];
    const next = { ...current };
    next.summary = policy.summary || next.summary;
    next.applyNotes = policy.applyNotes || next.applyNotes;
    next.stableSignals = limitStrings([...(next.stableSignals || []), ...(policy.stableSignals || [])], MAX_STABLE_SIGNALS);
    next.lastUpdatedAt = now;
    next.regression = Boolean(policy.regression);
    if (effective) {
      const alreadyHitThisWeek = next.lastHitWeek === latestScore.weekKey;
      next.hitWeeks = alreadyHitThisWeek ? Number(next.hitWeeks || 0) : Number(next.hitWeeks || 0) + 1;
      next.coldWeeks = 0;
      next.lastHitWeek = policy.lastHitWeek || latestScore.weekKey;
      next.strength = clampNumber(Number(next.strength || 0) + 10, 0, 100);
      if (next.state === "candidate" && next.hitWeeks >= PROJECT_PROMOTION_STREAK) {
        next.state = "active";
        next.strength = Math.max(Number(next.strength || 0), 70);
      }
      if (next.state === "cooling") {
        next.state = "active";
      }
    } else {
      const alreadyColdThisWeek = next.lastColdWeek === latestScore.weekKey;
      next.coldWeeks = alreadyColdThisWeek ? Number(next.coldWeeks || 0) : Number(next.coldWeeks || 0) + 1;
      next.lastColdWeek = latestScore.weekKey;
      next.strength = clampNumber(Number(next.strength || 0) - 15, 0, 100);
      if (next.coldWeeks >= PROJECT_DELETE_AFTER) {
        items.splice(index, 1);
        continue;
      }
      if (next.coldWeeks >= PROJECT_COOLING_START) {
        next.state = "cooling";
      }
    }
    items[index] = next;
  }

  return {
    memory: compactProjectMemoryCollection({
      version: 1,
      updatedAt: now,
      items,
    }, { now }),
  };
}

function updateGlobalCandidates(previousCandidates, projectMemory, { now }) {
  const items = Array.isArray(previousCandidates?.items) ? previousCandidates.items.slice() : [];
  const activeProjectsByPolicy = groupActiveProjectMemoryByPolicy(projectMemory);
  for (const [policyKey, projects] of Object.entries(activeProjectsByPolicy)) {
    if (projects.length < 2) {
      continue;
    }
    const sourceProjects = uniqueStrings(projects.map((item) => item.workspaceRoot));
    const summary = projects[0]?.summary || "";
    const existingIndex = items.findIndex((item) => item.policyKey === policyKey);
    const nextRecord = {
      ...(existingIndex >= 0 ? items[existingIndex] : createEmptyGlobalCandidate(policyKey)),
      candidateId: existingIndex >= 0 ? items[existingIndex].candidateId : buildMemoryId("candidate", policyKey, sourceProjects.join(","), "global"),
      policyKey,
      summary,
      sourceProjects: limitStrings(sourceProjects, MAX_SOURCE_PROJECTS),
      strength: clampNumber((existingIndex >= 0 ? Number(items[existingIndex].strength || 60) : 60) + 5, 0, 100),
      coldWeeks: 0,
      lastHitWeek: projects[0]?.lastHitWeek || "",
      updatedAt: now,
      state: "candidate",
    };
    if (existingIndex >= 0) {
      items[existingIndex] = nextRecord;
    } else {
      items.push(nextRecord);
    }
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    const stillActive = activeProjectsByPolicy[candidate.policyKey]?.length >= 2;
    if (stillActive) {
      continue;
    }
    candidate.coldWeeks = Number(candidate.coldWeeks || 0) + 1;
    candidate.updatedAt = now;
    if (candidate.coldWeeks >= GLOBAL_DEMOTE_AFTER) {
      items.splice(index, 1);
    }
  }

  return {
    memory: compactCandidateMemoryCollection({
      version: 1,
      updatedAt: now,
      items,
    }, { now }),
  };
}

function updateGlobalDurableMemory(previousGlobal, candidateMemory, { now }) {
  const items = Array.isArray(previousGlobal?.items) ? previousGlobal.items.slice() : [];
  const candidates = Array.isArray(candidateMemory?.items) ? candidateMemory.items : [];
  const activeCandidatePolicyKeys = new Set(candidates.map((item) => item.policyKey).filter(Boolean));
  for (const candidate of candidates) {
    const activeMatch = items.findIndex((item) => item.policyKey === candidate.policyKey);
    if (activeMatch < 0) {
      continue;
    }
    const current = items[activeMatch];
    const next = { ...current };
    next.summary = candidate.summary || next.summary;
    next.sourceProjects = uniqueStrings([...(next.sourceProjects || []), ...(candidate.sourceProjects || [])]);
    next.coldWeeks = Number(next.coldWeeks || 0) + 1;
    next.lastHitWeek = candidate.lastHitWeek || next.lastHitWeek;
    next.updatedAt = now;
    if (next.state === "pending_demote") {
      items[activeMatch] = next;
      continue;
    }
    if (candidate.coldWeeks === 0) {
      next.coldWeeks = 0;
      next.strength = clampNumber(Number(next.strength || 0) + 10, 0, 100);
    }
    if (next.coldWeeks >= GLOBAL_DEMOTE_AFTER) {
      next.state = "pending_demote";
    }
    items[activeMatch] = next;
  }

  for (const item of items) {
    if (item.state === "pending_demote" || activeCandidatePolicyKeys.has(item.policyKey)) {
      continue;
    }
    item.coldWeeks = Number(item.coldWeeks || 0) + 1;
    item.strength = clampNumber(Number(item.strength || 0) - 15, 0, 100);
    item.updatedAt = now;
    if (item.coldWeeks >= GLOBAL_DEMOTE_AFTER) {
      item.state = "pending_demote";
    }
  }

  return {
    memory: compactGlobalMemoryCollection({
      version: 1,
      updatedAt: now,
      items,
    }, { now }),
  };
}

function buildEffectiveState({
  latestScore,
  weeklySummary,
  projectMemory,
  projectAudit,
  globalMemory,
  globalAudit,
  candidateMemory,
  candidateAudit,
  previousEffectiveState,
  now,
}) {
  const projectSummaries = projectMemory
    .filter((item) => item.state === "active")
    .map((item) => summarizeMemoryItem("project", item));
  const globalSummaries = globalMemory
    .filter((item) => item.state === "active")
    .map((item) => summarizeMemoryItem("global", item));
  return {
    version: 1,
    updatedAt: now,
    source: `${latestScore.kind}:${latestScore.mode}`,
    previousUpdatedAt: previousEffectiveState?.updatedAt || "",
    projectSummaries,
    globalSummaries,
    governance: {
      weekly: weeklySummary.audit,
      project: projectAudit,
      global: globalAudit,
      candidate: candidateAudit,
    },
    routing: {
      minRouteScore: 2,
      ambiguousScoreGap: 1,
    },
    notes: [
      `week:${weeklySummary.weekKey || latestScore.weekKey}`,
      `project:${projectSummaries.length}`,
      `global:${globalSummaries.length}`,
      `candidate:${Array.isArray(candidateMemory) ? candidateMemory.length : 0}`,
    ],
  };
}

function buildAssessmentText({
  surface,
  latestScore,
  weeklySummary,
  projectMemory,
  projectAudit,
  globalMemory,
  globalAudit,
  candidateMemory,
  candidateAudit,
  effectiveState,
  previousScore,
}) {
  const lines = [
    `**${surface === "eval" ? "Eval" : "Score"} 更新**`,
    `- 当前分数：${formatScore(latestScore.score)}`,
    `- 规则分：${formatScore(latestScore.ruleScore)}`,
    `- LLM 分：${formatScore(latestScore.llmScore)}`,
    `- 上次分数：${previousScore ? formatScore(previousScore.score) : "n/a"}`,
    `- 周期：${latestScore.weekKey}`,
    `- 本周运行：${weeklySummary.runCount}`,
    "",
    "**生效态**",
    `- project active：${projectMemory.filter((item) => item.state === "active").length}`,
    `- project cooling：${projectMemory.filter((item) => item.state === "cooling").length}`,
    `- global active：${globalMemory.filter((item) => item.state === "active").length}`,
    `- global pending_demote：${globalMemory.filter((item) => item.state === "pending_demote").length}`,
    `- global candidates：${candidateMemory.length}`,
    "",
    "**治理**",
    `- weekly ${formatAuditSummary(weeklySummary.audit, MAX_WEEKLY_POLICIES)}`,
    `- project ${formatAuditSummary(projectAudit, MAX_PROJECT_MEMORY_ITEMS_PER_SCOPE)}`,
    `- global ${formatAuditSummary(globalAudit, MAX_GLOBAL_MEMORY_ITEMS)}`,
    `- candidates ${formatAuditSummary(candidateAudit, MAX_GLOBAL_CANDIDATES)}`,
    "",
    "**摘要**",
    ...effectiveState.projectSummaries.map((item) => `- ${item}`),
    ...effectiveState.globalSummaries.map((item) => `- ${item}`),
  ];
  return lines.join("\n");
}

function buildDoctorSection(store, { runtime, bindingKey, workspaceRoot, instanceLabel }) {
  const latestScore = store.getLatestScore();
  const previousScore = store.getPreviousScore();
  const weeklySummary = store.getWeeklySummary();
  const effectiveState = store.getEffectiveState();
  const rollbackState = store.getRollbackState();
  const projectMemory = store.getProjectDurableMemory();
  const globalMemory = store.getGlobalDurableMemory();
  const candidates = store.getGlobalPromotionCandidates();
  const statePaths = store.paths;

  const currentProjectMemory = projectMemory.items.filter((item) => item.instanceLabel === instanceLabel && (!workspaceRoot || item.workspaceRoot === workspaceRoot));

  return [
    "",
    "**优化记忆**",
    `- state dir：\`${statePaths.dir}\``,
    `- latest-score：${formatTimestamp(latestScore?.createdAt)}`,
    `- previous-score：${formatTimestamp(previousScore?.createdAt)}`,
    `- weekly-summary：${weeklySummary.weekKey || "empty"}`,
    `- effective-state：${formatTimestamp(effectiveState?.updatedAt)}`,
    `- rollback-state：${formatTimestamp(rollbackState?.updatedAt)}`,
    `- project durable：${currentProjectMemory.length}`,
    `- global durable：${globalMemory.items.length}`,
    `- global candidates：${candidates.items.length}`,
    `- weekly audit：${formatAuditSummary(weeklySummary.audit, MAX_WEEKLY_POLICIES)}`,
    `- project audit：${formatAuditSummary(projectMemory.audit, MAX_PROJECT_MEMORY_ITEMS_PER_SCOPE)}`,
    `- global audit：${formatAuditSummary(globalMemory.audit, MAX_GLOBAL_MEMORY_ITEMS)}`,
    `- candidates audit：${formatAuditSummary(candidates.audit, MAX_GLOBAL_CANDIDATES)}`,
    `- routing min score：${effectiveState.routing.minRouteScore}`,
    `- routing gap：${effectiveState.routing.ambiguousScoreGap}`,
    `- rollback：${rollbackState?.updatedAt ? "available" : "empty"}`,
  ].join("\n");
}

function buildMessagePrefix(store, { runtime, normalized, instanceLabel }) {
  const context = runtime.getBindingContext(normalized);
  const projectMemory = store.getProjectDurableMemory();
  const globalMemory = store.getGlobalDurableMemory();
  const activeProjectSummaries = projectMemory.items
    .filter((item) => item.state === "active" && item.instanceLabel === instanceLabel && (!context.workspaceRoot || item.workspaceRoot === context.workspaceRoot))
    .map((item) => summarizeMemoryItem("project", item));
  const activeGlobalSummaries = globalMemory.items
    .filter((item) => item.state === "active")
    .map((item) => summarizeMemoryItem("global", item));
  if (!activeProjectSummaries.length && !activeGlobalSummaries.length) {
    return "";
  }
  return [
    "<feishu-optimization-memory>",
    ...activeProjectSummaries.map((item) => `[project] ${item}`),
    ...activeGlobalSummaries.map((item) => `[global] ${item}`),
    "</feishu-optimization-memory>",
    "",
  ].join("\n");
}

function buildMemorySummary(store, { runtime, bindingKey, workspaceRoot, instanceLabel }) {
  const weeklySummary = store.getWeeklySummary();
  const projectMemory = store.getProjectDurableMemory();
  const globalMemory = store.getGlobalDurableMemory();
  const candidates = store.getGlobalPromotionCandidates();
  const projectItems = projectMemory.items.filter((item) => item.instanceLabel === instanceLabel && (!workspaceRoot || item.workspaceRoot === workspaceRoot));
  const activeProjectItems = projectItems.filter((item) => item.state === "active");
  const coolingProjectItems = projectItems.filter((item) => item.state === "cooling");
  const activeGlobalItems = globalMemory.items.filter((item) => item.state === "active");
  const pendingGlobalItems = globalMemory.items.filter((item) => item.state === "pending_demote");
  const lines = [
    "**优化记忆状态**",
    `- 项目活跃：${activeProjectItems.length}`,
    `- 项目降温：${coolingProjectItems.length}`,
    `- 全局活跃：${activeGlobalItems.length}`,
    `- 全局待降级：${pendingGlobalItems.length}`,
    `- 全局候选：${candidates.items.length}`,
    `- weekly audit：${formatAuditSummary(weeklySummary.audit, MAX_WEEKLY_POLICIES)}`,
    `- project audit：${formatAuditSummary(projectMemory.audit, MAX_PROJECT_MEMORY_ITEMS_PER_SCOPE)}`,
    `- global audit：${formatAuditSummary(globalMemory.audit, MAX_GLOBAL_MEMORY_ITEMS)}`,
    `- candidate audit：${formatAuditSummary(candidates.audit, MAX_GLOBAL_CANDIDATES)}`,
    "",
    "**项目内**",
    ...projectItems.map((item) => formatMemoryItemLine("project", item)),
    "",
    "**全局**",
    ...globalMemory.items.map((item) => formatMemoryItemLine("global", item)),
    "",
    "**候选**",
    ...candidates.items.map((item) => formatMemoryItemLine("candidate", item)),
  ];
  return lines.filter(Boolean).join("\n");
}

function compactWeeklySummary(summary, { now } = {}) {
  const source = summary && typeof summary === "object" ? summary : {};
  const policies = normalizeObject(source.policies);
  const promotionTrackers = compactPromotionTrackers(source.promotionTrackers);
  const entries = Object.entries(policies).map(([policyKey, policy]) => {
    const stableSignals = uniqueStrings(policy.stableSignals);
    const limitedSignals = limitStrings(stableSignals, MAX_STABLE_SIGNALS);
    return {
      ...policy,
      policyKey,
      summary: trimText(policy.summary, 240),
      applyNotes: trimText(policy.applyNotes, 240),
      stableSignals: limitedSignals,
      _trimmedSignals: Math.max(0, stableSignals.length - limitedSignals.length),
    };
  });
  entries.sort(compareWeeklyPolicyRecords);
  const kept = entries.slice(0, MAX_WEEKLY_POLICIES);
  const trimmedItems = Math.max(0, entries.length - kept.length);
  const trimmedSignals = entries.reduce((total, item) => total + Number(item._trimmedSignals || 0), 0);
  const nextPolicies = {};
  for (const item of kept) {
    const { _trimmedSignals, ...policy } = item;
    nextPolicies[policy.policyKey] = policy;
  }
  return {
    version: 1,
    weekKey: normalizeString(source.weekKey),
    updatedAt: normalizeString(source.updatedAt) || now || "",
    runCount: Number(source.runCount || 0),
    lastMode: normalizeString(source.lastMode),
    lastSurface: normalizeString(source.lastSurface),
    policies: nextPolicies,
    promotionTrackers,
    audit: buildAuditRecord({
      lastCompactedAt: now || normalizeString(source.updatedAt),
      dedupedItems: 0,
      trimmedItems,
      trimmedSignals,
      cappedPolicies: trimmedItems,
      itemCount: kept.length,
      maxItems: MAX_WEEKLY_POLICIES,
      notes: [`source:${entries.length}`],
    }),
  };
}

function compactPromotionTrackers(rawTrackers) {
  const trackers = Object.entries(normalizeObject(rawTrackers))
    .map(([key, tracker]) => ({
      key,
      tracker: normalizePromotionTracker(tracker),
    }))
    .filter((item) => item.tracker.policyKey);
  trackers.sort((left, right) => {
    const streakDiff = compareNumbersDesc(
      left.tracker.consecutiveEffectiveWeeks,
      right.tracker.consecutiveEffectiveWeeks
    );
    if (streakDiff) {
      return streakDiff;
    }
    return compareStringsDesc(left.tracker.updatedAt, right.tracker.updatedAt);
  });

  const limited = trackers.slice(0, MAX_WEEKLY_PROMOTION_TRACKERS);
  const next = {};
  for (const item of limited) {
    next[item.key] = item.tracker;
  }
  return next;
}

function normalizePromotionTracker(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    policyKey: normalizeString(input.policyKey),
    workspaceRoot: normalizeString(input.workspaceRoot),
    instanceLabel: normalizeString(input.instanceLabel),
    consecutiveEffectiveWeeks: Number(input.consecutiveEffectiveWeeks || 0),
    lastEffectiveWeek: normalizeString(input.lastEffectiveWeek),
    lastObservedWeek: normalizeString(input.lastObservedWeek),
    updatedAt: normalizeString(input.updatedAt),
  };
}

function updatePromotionTracker(previousTracker, {
  policyKey,
  workspaceRoot,
  instanceLabel,
  effective,
  regression,
  currentWeek,
  updatedAt,
}) {
  const current = normalizePromotionTracker(previousTracker);
  const next = {
    ...current,
    policyKey: normalizeString(policyKey),
    workspaceRoot: normalizeString(workspaceRoot),
    instanceLabel: normalizeString(instanceLabel),
    updatedAt: normalizeString(updatedAt),
    lastObservedWeek: currentWeek,
  };

  if (effective && !regression) {
    if (next.lastEffectiveWeek === currentWeek) {
      return next;
    }
    next.consecutiveEffectiveWeeks = isConsecutiveWeek(next.lastEffectiveWeek, currentWeek)
      ? Number(next.consecutiveEffectiveWeeks || 0) + 1
      : 1;
    next.lastEffectiveWeek = currentWeek;
    return next;
  }

  if (next.lastObservedWeek !== currentWeek) {
    next.consecutiveEffectiveWeeks = 0;
  } else {
    next.consecutiveEffectiveWeeks = 0;
  }
  return next;
}

function buildPromotionTrackerKey(policyKey, workspaceRoot, instanceLabel) {
  return [
    normalizeString(policyKey),
    normalizeString(workspaceRoot),
    normalizeString(instanceLabel) || "default",
  ].join("::");
}

function isConsecutiveWeek(previousWeekKey, currentWeekKey) {
  const previousDate = weekKeyToDate(previousWeekKey);
  const currentDate = weekKeyToDate(currentWeekKey);
  if (!previousDate || !currentDate) {
    return false;
  }
  const diffWeeks = Math.round((currentDate.getTime() - previousDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return diffWeeks === 1;
}

function weekKeyToDate(weekKey) {
  const match = /^(\d{4})-W(\d{2})$/.exec(normalizeString(weekKey));
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(week) || week <= 0) {
    return null;
  }
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + ((week - 1) * 7));
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

function compactProjectMemoryCollection(collection, { now } = {}) {
  return compactMemoryCollection(collection, {
    kind: "project",
    now,
    maxItems: MAX_PROJECT_MEMORY_ITEMS_PER_SCOPE,
    scopeKey: (item) => `${item.workspaceRoot || "__global__"}::${item.instanceLabel || "default"}`,
    itemKey: (item) => `${item.policyKey}::${item.workspaceRoot || ""}::${item.instanceLabel || ""}`,
    compare: compareProjectMemoryRecords,
  });
}

function compactGlobalMemoryCollection(collection, { now } = {}) {
  return compactMemoryCollection(collection, {
    kind: "global",
    now,
    maxItems: MAX_GLOBAL_MEMORY_ITEMS,
    itemKey: (item) => item.policyKey,
    compare: compareGlobalMemoryRecords,
  });
}

function compactCandidateMemoryCollection(collection, { now } = {}) {
  return compactMemoryCollection(collection, {
    kind: "candidate",
    now,
    maxItems: MAX_GLOBAL_CANDIDATES,
    itemKey: (item) => item.policyKey,
    compare: compareCandidateMemoryRecords,
  });
}

function compactMemoryCollection(collection, { kind, now, maxItems, scopeKey, itemKey, compare }) {
  const sourceItems = Array.isArray(collection?.items) ? collection.items : [];
  let dedupedItems = 0;
  let trimmedSignals = 0;
  const merged = new Map();
  for (const rawItem of sourceItems) {
    const item = normalizeMemoryRecordForOptimization(rawItem, kind);
    if (!item) {
      continue;
    }
    const key = itemKey(item);
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, mergeMemoryRecords(kind, existing, item, compare));
      dedupedItems += 1;
    } else {
      merged.set(key, item);
    }
  }

  const grouped = new Map();
  for (const item of merged.values()) {
    const key = scopeKey ? scopeKey(item) : "__all__";
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(item);
  }

  let trimmedItems = 0;
  const kept = [];
  for (const items of grouped.values()) {
    items.sort(compare);
    if (items.length > maxItems) {
      trimmedItems += items.length - maxItems;
    }
    kept.push(...items.slice(0, maxItems));
  }
  kept.sort(compare);

  const cleaned = kept.map((item) => {
    const result = sanitizeMemoryRecord(item);
    trimmedSignals += result.trimmedSignals;
    return result.item;
  });
  const effectiveMaxItems = scopeKey ? maxItems * Math.max(1, grouped.size) : maxItems;

  return {
    version: 1,
    updatedAt: normalizeString(collection?.updatedAt) || now || "",
    items: cleaned,
    audit: buildAuditRecord({
      lastCompactedAt: now || normalizeString(collection?.updatedAt),
      dedupedItems,
      trimmedItems,
      trimmedSignals,
      itemCount: cleaned.length,
      maxItems: effectiveMaxItems,
      notes: scopeKey ? [`scopes:${grouped.size}`] : [`items:${sourceItems.length}`],
    }),
  };
}

function sanitizeMemoryRecord(item) {
  const stableSignals = uniqueStrings(item.stableSignals);
  const limitedSignals = limitStrings(stableSignals, MAX_STABLE_SIGNALS);
  const sourceProjects = uniqueStrings(item.sourceProjects);
  const limitedSourceProjects = limitStrings(sourceProjects, MAX_SOURCE_PROJECTS);
  return {
    item: {
      ...item,
      summary: trimText(item.summary, 240),
      applyNotes: trimText(item.applyNotes, 240),
      stableSignals: limitedSignals,
      sourceProjects: limitedSourceProjects,
    },
    trimmedSignals: Math.max(0, stableSignals.length - limitedSignals.length)
      + Math.max(0, sourceProjects.length - limitedSourceProjects.length),
  };
}

function normalizeMemoryRecordForOptimization(raw, kind) {
  const input = raw && typeof raw === "object" ? raw : {};
  const policyKey = normalizeString(input.policyKey);
  const summary = normalizeString(input.summary);
  if (!policyKey || !summary) {
    return null;
  }
  return {
    memoryId: normalizeString(input.memoryId) || normalizeString(input.candidateId),
    candidateId: normalizeString(input.candidateId),
    policyKey,
    workspaceRoot: normalizeString(input.workspaceRoot),
    instanceLabel: normalizeString(input.instanceLabel),
    summary,
    applyNotes: normalizeString(input.applyNotes),
    stableSignals: uniqueStrings(input.stableSignals),
    sourceProjects: uniqueStrings(input.sourceProjects),
    hitWeeks: Number(input.hitWeeks || 0),
    coldWeeks: Number(input.coldWeeks || 0),
    strength: Number(input.strength || 0),
    lastHitWeek: normalizeString(input.lastHitWeek),
    lastColdWeek: normalizeString(input.lastColdWeek),
    updatedAt: normalizeString(input.updatedAt) || normalizeString(input.lastUpdatedAt),
    lastUpdatedAt: normalizeString(input.lastUpdatedAt),
    state: normalizeString(input.state) || defaultMemoryState(kind),
    regression: Boolean(input.regression),
  };
}

function mergeMemoryRecords(kind, current, incoming, compare) {
  const primary = compare(incoming, current) < 0 ? incoming : current;
  const secondary = primary === current ? incoming : current;
  const primaryState = String(primary.state || "").trim();
  const secondaryState = String(secondary.state || "").trim();
  const preferCooling = primaryState === "active" || primaryState === "candidate";
  return {
    ...secondary,
    ...primary,
    memoryId: primary.memoryId || secondary.memoryId || primary.candidateId || secondary.candidateId,
    candidateId: primary.candidateId || secondary.candidateId || primary.memoryId || secondary.memoryId,
    policyKey: primary.policyKey || secondary.policyKey,
    workspaceRoot: primary.workspaceRoot || secondary.workspaceRoot,
    instanceLabel: primary.instanceLabel || secondary.instanceLabel,
    summary: primary.summary || secondary.summary,
    applyNotes: primary.applyNotes || secondary.applyNotes,
    stableSignals: uniqueStrings([...(secondary.stableSignals || []), ...(primary.stableSignals || [])]),
    sourceProjects: uniqueStrings([...(secondary.sourceProjects || []), ...(primary.sourceProjects || [])]),
    hitWeeks: Math.max(Number(primary.hitWeeks || 0), Number(secondary.hitWeeks || 0)),
    coldWeeks: preferCooling
      ? Math.min(Number(primary.coldWeeks || 0), Number(secondary.coldWeeks || 0))
      : Math.max(Number(primary.coldWeeks || 0), Number(secondary.coldWeeks || 0)),
    strength: Math.max(Number(primary.strength || 0), Number(secondary.strength || 0)),
    lastHitWeek: latestString(primary.lastHitWeek, secondary.lastHitWeek),
    lastColdWeek: latestString(primary.lastColdWeek, secondary.lastColdWeek),
    updatedAt: latestString(primary.updatedAt, secondary.updatedAt),
    lastUpdatedAt: latestString(primary.lastUpdatedAt, secondary.lastUpdatedAt, primary.updatedAt, secondary.updatedAt),
    state: primaryState || secondaryState,
    regression: Boolean(primary.regression || secondary.regression),
  };
}

function compareProjectMemoryRecords(a, b) {
  const stateDiff = compareNumbersDesc(memoryStateRank("project", a.state), memoryStateRank("project", b.state));
  if (stateDiff) {
    return stateDiff;
  }
  const strengthDiff = compareNumbersDesc(a.strength, b.strength);
  if (strengthDiff) {
    return strengthDiff;
  }
  const hitDiff = compareNumbersDesc(a.hitWeeks, b.hitWeeks);
  if (hitDiff) {
    return hitDiff;
  }
  const coldDiff = compareNumbersAsc(a.coldWeeks, b.coldWeeks);
  if (coldDiff) {
    return coldDiff;
  }
  const updatedDiff = compareStringsDesc(a.updatedAt || a.lastUpdatedAt, b.updatedAt || b.lastUpdatedAt);
  if (updatedDiff) {
    return updatedDiff;
  }
  return compareStringsAsc(a.policyKey, b.policyKey);
}

function compareGlobalMemoryRecords(a, b) {
  const stateDiff = compareNumbersDesc(memoryStateRank("global", a.state), memoryStateRank("global", b.state));
  if (stateDiff) {
    return stateDiff;
  }
  const strengthDiff = compareNumbersDesc(a.strength, b.strength);
  if (strengthDiff) {
    return strengthDiff;
  }
  const coldDiff = compareNumbersAsc(a.coldWeeks, b.coldWeeks);
  if (coldDiff) {
    return coldDiff;
  }
  const hitDiff = compareStringsDesc(a.lastHitWeek, b.lastHitWeek);
  if (hitDiff) {
    return hitDiff;
  }
  const updatedDiff = compareStringsDesc(a.updatedAt || a.lastUpdatedAt, b.updatedAt || b.lastUpdatedAt);
  if (updatedDiff) {
    return updatedDiff;
  }
  return compareStringsAsc(a.policyKey, b.policyKey);
}

function compareCandidateMemoryRecords(a, b) {
  const strengthDiff = compareNumbersDesc(a.strength, b.strength);
  if (strengthDiff) {
    return strengthDiff;
  }
  const sourceDiff = compareNumbersDesc(Array.isArray(a.sourceProjects) ? a.sourceProjects.length : 0, Array.isArray(b.sourceProjects) ? b.sourceProjects.length : 0);
  if (sourceDiff) {
    return sourceDiff;
  }
  const coldDiff = compareNumbersAsc(a.coldWeeks, b.coldWeeks);
  if (coldDiff) {
    return coldDiff;
  }
  const hitDiff = compareStringsDesc(a.lastHitWeek, b.lastHitWeek);
  if (hitDiff) {
    return hitDiff;
  }
  const updatedDiff = compareStringsDesc(a.updatedAt || a.lastUpdatedAt, b.updatedAt || b.lastUpdatedAt);
  if (updatedDiff) {
    return updatedDiff;
  }
  return compareStringsAsc(a.policyKey, b.policyKey);
}

function compareWeeklyPolicyRecords(a, b) {
  const effectiveDiff = compareNumbersDesc(Boolean(a.effective), Boolean(b.effective));
  if (effectiveDiff) {
    return effectiveDiff;
  }
  const regressionDiff = compareNumbersAsc(Boolean(a.regression), Boolean(b.regression));
  if (regressionDiff) {
    return regressionDiff;
  }
  const hitDiff = compareNumbersDesc(a.hitWeeks, b.hitWeeks);
  if (hitDiff) {
    return hitDiff;
  }
  const scoreDiff = compareNumbersDesc(a.lastScore, b.lastScore);
  if (scoreDiff) {
    return scoreDiff;
  }
  const llmDiff = compareNumbersDesc(a.lastLlmScore, b.lastLlmScore);
  if (llmDiff) {
    return llmDiff;
  }
  const updatedDiff = compareStringsDesc(a.updatedAt, b.updatedAt);
  if (updatedDiff) {
    return updatedDiff;
  }
  return compareStringsAsc(a.policyKey, b.policyKey);
}

function memoryStateRank(kind, state) {
  const value = String(state || "").trim();
  if (kind === "project") {
    if (value === "active") return 3;
    if (value === "cooling") return 2;
    return 0;
  }
  if (kind === "global") {
    if (value === "active") return 2;
    if (value === "pending_demote") return 1;
    return 0;
  }
  return 0;
}

function buildAuditRecord({ lastCompactedAt, dedupedItems = 0, trimmedItems = 0, trimmedSignals = 0, cappedPolicies = 0, itemCount = 0, maxItems = 0, notes = [] } = {}) {
  const normalizedItemCount = Number(itemCount || 0);
  const normalizedMaxItems = Number(maxItems || 0);
  const ratio = normalizedMaxItems > 0 ? normalizedItemCount / normalizedMaxItems : 0;
  const storagePressure = trimmedItems > 0 || cappedPolicies > 0 || (normalizedMaxItems > 0 && normalizedItemCount >= normalizedMaxItems)
    ? "full"
    : ratio >= STORAGE_PRESSURE_HIGH_WATERMARK
      ? "high"
      : ratio >= 0.5
        ? "normal"
        : "low";
  return {
    lastCompactedAt: normalizeString(lastCompactedAt),
    dedupedItems: Number(dedupedItems || 0),
    trimmedItems: Number(trimmedItems || 0),
    trimmedSignals: Number(trimmedSignals || 0),
    cappedPolicies: Number(cappedPolicies || 0),
    itemCount: normalizedItemCount,
    maxItems: normalizedMaxItems,
    storagePressure,
    notes: limitStrings(normalizeStringArray(notes), 6),
  };
}

function formatAuditSummary(audit, fallbackMaxItems) {
  const itemCount = Number(audit?.itemCount || 0);
  const maxItems = Number(audit?.maxItems || fallbackMaxItems || 0);
  const storagePressure = audit?.storagePressure || "normal";
  return `${itemCount}/${maxItems || fallbackMaxItems} ${storagePressure} dedupe:${Number(audit?.dedupedItems || 0)} trim:${Number(audit?.trimmedItems || 0)}`;
}

function trimText(value, maxLength) {
  const text = normalizeString(value);
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function limitStrings(values, maxItems) {
  const unique = uniqueStrings(values);
  if (unique.length <= maxItems) {
    return unique;
  }
  return unique.slice(unique.length - maxItems);
}

function latestString(...values) {
  return values
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))[0] || "";
}

function compareNumbersDesc(left, right) {
  return Number(right || 0) - Number(left || 0);
}

function compareNumbersAsc(left, right) {
  return Number(left || 0) - Number(right || 0);
}

function compareStringsDesc(left, right) {
  return normalizeString(right).localeCompare(normalizeString(left));
}

function compareStringsAsc(left, right) {
  return normalizeString(left).localeCompare(normalizeString(right));
}

async function promoteGlobalCandidate(store, candidateId, instanceLabel) {
  const candidates = store.getGlobalPromotionCandidates();
  const candidateIndex = candidates.items.findIndex((item) => item.candidateId === candidateId || item.memoryId === candidateId);
  if (candidateIndex < 0) {
    return { ok: false, message: `未找到候选项：${candidateId}` };
  }
  const candidate = candidates.items[candidateIndex];
  const globalMemory = store.getGlobalDurableMemory();
  const existingIndex = globalMemory.items.findIndex((item) => item.policyKey === candidate.policyKey);
  const now = new Date().toISOString();
  const nextRecord = {
    memoryId: buildMemoryId("global", candidate.policyKey, candidate.candidateId, instanceLabel),
    policyKey: candidate.policyKey,
    summary: candidate.summary,
    sourceProjects: limitStrings(uniqueStrings(candidate.sourceProjects), MAX_SOURCE_PROJECTS),
    strength: 80,
    coldWeeks: 0,
    lastHitWeek: candidate.lastHitWeek || "",
    state: "active",
    updatedAt: now,
  };
  if (existingIndex >= 0) {
    globalMemory.items[existingIndex] = nextRecord;
  } else {
    globalMemory.items.push(nextRecord);
  }
  store.setGlobalDurableMemory(compactGlobalMemoryCollection(globalMemory, { now }));
  return { ok: true, message: `已将候选项升为全局持久记忆：${candidateId}` };
}

async function rejectGlobalMemory(store, targetId, instanceLabel) {
  const candidates = store.getGlobalPromotionCandidates();
  const now = new Date().toISOString();
  const candidateIndex = candidates.items.findIndex((item) => item.candidateId === targetId || item.memoryId === targetId);
  if (candidateIndex >= 0) {
    candidates.items.splice(candidateIndex, 1);
    store.setGlobalPromotionCandidates(compactCandidateMemoryCollection(candidates, { now }));
    return { ok: true, message: `已拒绝候选项：${targetId}` };
  }

  const globalMemory = store.getGlobalDurableMemory();
  const globalIndex = globalMemory.items.findIndex((item) => item.memoryId === targetId);
  if (globalIndex < 0) {
    return { ok: false, message: `未找到全局记忆：${targetId}` };
  }
  const record = globalMemory.items[globalIndex];
  if (record.state !== "pending_demote") {
    return { ok: false, message: "只有待降级的全局记忆可以 reject。"};
  }
  const nextCandidates = store.getGlobalPromotionCandidates();
  nextCandidates.items.push({
    candidateId: record.memoryId,
    policyKey: record.policyKey,
    summary: record.summary,
    sourceProjects: limitStrings(uniqueStrings(record.sourceProjects), MAX_SOURCE_PROJECTS),
    strength: clampNumber(Number(record.strength || 80) - 10, 0, 100),
    coldWeeks: 0,
    lastHitWeek: record.lastHitWeek || "",
    updatedAt: now,
    state: "candidate",
  });
  store.setGlobalPromotionCandidates(compactCandidateMemoryCollection(nextCandidates, { now }));
  globalMemory.items.splice(globalIndex, 1);
  store.setGlobalDurableMemory(compactGlobalMemoryCollection(globalMemory, { now }));
  return { ok: true, message: `已将全局记忆降回候选层：${targetId}` };
}

function getRoutingHints(store) {
  const effective = store.getEffectiveState();
  return {
    minRouteScore: Number(effective?.routing?.minRouteScore || 2),
    ambiguousScoreGap: Number(effective?.routing?.ambiguousScoreGap || 1),
  };
}

function summarizeMemoryItem(kind, item) {
  const state = String(item.state || "").trim() || (kind === "candidate" ? "candidate" : "active");
  const scope = item.workspaceRoot ? path.basename(String(item.workspaceRoot)) : item.policyKey;
  return `${scope} | ${item.summary} | ${state} | hit:${item.hitWeeks || 0} cold:${item.coldWeeks || 0} strength:${item.strength || 0}`;
}

function formatMemoryItemLine(kind, item) {
  return `- ${item.policyKey || item.candidateId || item.memoryId}: ${summarizeMemoryItem(kind, item)}`;
}

function buildMemoryId(prefix, policyKey, scope, instanceLabel) {
  const seed = `${prefix}:${policyKey}:${scope}:${instanceLabel}:${Date.now()}`;
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

function formatScore(value) {
  return `${Math.round(Number(value || 0))}/100`;
}

function formatTimestamp(value) {
  return value ? String(value) : "empty";
}

function formatSimpleMessage(surface, text) {
  return `**${surface === "eval" ? "Eval" : "Score"}**\n${text}`;
}

function formatRollbackMessage(surface, rollbackState) {
  return [
    `**${surface === "eval" ? "Eval" : "Score"} 回滚**`,
    `- 回滚到：${formatTimestamp(rollbackState.updatedAt)}`,
    `- 来源：${rollbackState.source || ""}`,
  ].join("\n");
}

async function sendOptimizationText(runtime, normalized, text) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text,
  });
  return text;
}

function buildWeekKey(date) {
  const target = new Date(date.getTime());
  target.setHours(0, 0, 0, 0);
  target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7));
  const week1 = new Date(target.getFullYear(), 0, 4);
  const weekNumber = 1 + Math.round(((target.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${target.getFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function normalizePolicyKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "-");
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => normalizeString(item)).filter(Boolean) : [];
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function clampNumber(value, min, max) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return min;
  }
  return Math.max(min, Math.min(max, normalized));
}

function createEmptyWeeklyPolicy(policyKey) {
  return {
    policyKey,
    summary: "",
    applyNotes: "",
    stableSignals: [],
    hitWeeks: 0,
    coldWeeks: 0,
    lastScore: 0,
    lastRuleScore: 0,
    lastLlmScore: 0,
    lastDelta: 0,
    lastHitWeek: "",
    lastColdWeek: "",
    regression: false,
    effective: false,
    state: "cooling",
    updatedAt: "",
  };
}

function groupActiveProjectMemoryByPolicy(projectMemory) {
  const grouped = {};
  for (const item of Array.isArray(projectMemory) ? projectMemory : []) {
    if (item.state !== "active") {
      continue;
    }
    if (!grouped[item.policyKey]) {
      grouped[item.policyKey] = [];
    }
    grouped[item.policyKey].push(item);
  }
  return grouped;
}

function createEmptyGlobalCandidate(policyKey) {
  return {
    candidateId: "",
    policyKey,
    summary: "",
    sourceProjects: [],
    strength: 60,
    coldWeeks: 0,
    lastHitWeek: "",
    state: "candidate",
    updatedAt: "",
  };
}

module.exports = {
  __test: {
    MAX_WEEKLY_POLICIES,
    MAX_PROJECT_MEMORY_ITEMS_PER_SCOPE,
    MAX_GLOBAL_MEMORY_ITEMS,
    MAX_GLOBAL_CANDIDATES,
    MAX_STABLE_SIGNALS,
    MAX_SOURCE_PROJECTS,
    buildAuditRecord,
    compactWeeklySummary,
    compactProjectMemoryCollection,
    compactGlobalMemoryCollection,
    compactCandidateMemoryCollection,
    formatAuditSummary,
    mergeWeeklySummary,
    updateGlobalCandidates,
    updateGlobalDurableMemory,
    updateProjectDurableMemory,
  },
  createOptimizationManager,
  parseOptimizationCommandMode,
};

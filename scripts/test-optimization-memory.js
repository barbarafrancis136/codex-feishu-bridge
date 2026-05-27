#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createOptimizationManager, parseOptimizationCommandMode } = require("../src/domain/optimization/service");
const pluginRoutingService = require("../src/domain/plugin-routing/service");

async function main() {
  testCommandParsing();
  await testScoreLifecycleAndRollback();
  testWeeklySummaryResetAndFixedFiles();
  await testGovernanceCompactionAndAudit();
  testProjectMemoryPromotionCoolingAndDelete();
  await testGlobalCandidatePromoteRejectAndDemote();
  await testRuntimeMessagePrefixInjection();
  await testCoolingAndPendingMemoryDoNotInject();
  testGlobalCandidateColdDelete();
  testPluginRoutingHintOverride();
  console.log("optimization memory fixtures ok");
}

function testCommandParsing() {
  assert.deepStrictEqual(parseOptimizationCommandMode("/codex score", "score"), {
    action: "run",
    mode: "all",
    scope: "",
    targetId: "",
  });
  assert.deepStrictEqual(parseOptimizationCommandMode("/codex eval bot", "eval"), {
    action: "run",
    mode: "bot",
    scope: "",
    targetId: "",
  });
  assert.deepStrictEqual(parseOptimizationCommandMode("/codex score rollback", "score").action, "rollback");
  assert.deepStrictEqual(parseOptimizationCommandMode("/codex eval memory", "eval").action, "memory");
  assert.deepStrictEqual(parseOptimizationCommandMode("/codex score promote global cand_1", "score"), {
    action: "promote",
    mode: "",
    scope: "global",
    targetId: "cand_1",
  });
  assert.deepStrictEqual(parseOptimizationCommandMode("/codex eval reject global mem_1", "eval"), {
    action: "reject",
    mode: "",
    scope: "global",
    targetId: "mem_1",
  });
}

async function testScoreLifecycleAndRollback() {
  const { manager, runtime, sent } = createHarness();
  await manager.handleCommand({
    surface: "score",
    normalized: buildNormalized("/codex score all"),
    runtime,
  });
  await manager.handleCommand({
    surface: "eval",
    normalized: buildNormalized("/codex eval bridge"),
    runtime,
  });

  const paths = manager.store.paths;
  const stateFiles = Object.entries(paths)
    .filter(([key]) => key !== "dir")
    .map(([, filePath]) => path.basename(filePath))
    .sort();
  assert.deepStrictEqual(stateFiles, [
    "effective-state.json",
    "global-durable-memory.json",
    "global-promotion-candidates.json",
    "latest-score.json",
    "previous-score.json",
    "project-durable-memory.json",
    "rollback-state.json",
    "weekly-summary.json",
  ]);
  assert.ok(fs.existsSync(paths.latestScore));
  assert.ok(fs.existsSync(paths.previousScore));
  assert.ok(fs.existsSync(paths.weeklySummary));
  assert.ok(fs.existsSync(paths.effectiveState));
  assert.ok(fs.existsSync(paths.rollbackState));
  assert.ok(fs.existsSync(paths.projectDurableMemory));
  assert.ok(fs.existsSync(paths.globalDurableMemory));
  assert.ok(fs.existsSync(paths.globalPromotionCandidates));
  assert.ok(readJson(paths.latestScore).score >= 0);
  assert.ok(readJson(paths.previousScore).score >= 0);
  assert.ok(readJson(paths.weeklySummary).runCount >= 2);
  assert.ok(readJson(paths.effectiveState).updatedAt);
  assert.ok(readJson(paths.rollbackState).updatedAt);
  assert.ok(sent.some((item) => item.includes("LLM 分")));

  const rollbackBefore = readJson(paths.rollbackState);
  await manager.handleCommand({
    surface: "score",
    normalized: buildNormalized("/codex score rollback"),
    runtime,
  });
  const effectiveAfterRollback = readJson(paths.effectiveState);
  assert.strictEqual(effectiveAfterRollback.source, "score:rollback");
  assert.strictEqual(effectiveAfterRollback.projectSummaries.length, rollbackBefore.projectSummaries.length);
  assert.strictEqual(effectiveAfterRollback.globalSummaries.length, rollbackBefore.globalSummaries.length);
  assert.ok(sent.some((item) => item.includes("回滚")));
}

function testWeeklySummaryResetAndFixedFiles() {
  const service = require("../src/domain/optimization/service");
  assert.ok(service.__test);
  const previousWeekly = buildWeeklySummary("2026-W21", "reply-shape", true);
  previousWeekly.runCount = 5;
  previousWeekly.policies["old-policy"] = {
    ...previousWeekly.policies["reply-shape"],
    policyKey: "old-policy",
    summary: "Old policy should not leak into the next week.",
  };

  const sameWeek = service.__test.mergeWeeklySummary(previousWeekly, buildLatestScore("2026-W21", "/srv/project-a", true));
  assert.strictEqual(sameWeek.weekKey, "2026-W21");
  assert.strictEqual(sameWeek.runCount, 6);
  assert.ok(sameWeek.policies["old-policy"]);

  const nextWeek = service.__test.mergeWeeklySummary(previousWeekly, buildLatestScore("2026-W22", "/srv/project-a", true));
  assert.strictEqual(nextWeek.weekKey, "2026-W22");
  assert.strictEqual(nextWeek.runCount, 1);
  assert.strictEqual(nextWeek.policies["old-policy"], undefined);
}

async function testGovernanceCompactionAndAudit() {
  const service = require("../src/domain/optimization/service");
  const limits = service.__test;
  const now = "2026-05-01T00:00:00.000Z";

  const weekly = buildOversizedWeeklySummary(limits.MAX_WEEKLY_POLICIES + 6, limits.MAX_STABLE_SIGNALS + 4);
  const compactedWeekly = service.__test.compactWeeklySummary(weekly, { now });
  assert.strictEqual(Object.keys(compactedWeekly.policies).length, limits.MAX_WEEKLY_POLICIES);
  assert.ok(compactedWeekly.audit.trimmedItems > 0);
  assert.ok(compactedWeekly.audit.trimmedSignals > 0);
  assert.ok(compactedWeekly.policies["policy-00"].summary.length <= 240);
  assert.ok(compactedWeekly.policies["policy-00"].stableSignals.length <= limits.MAX_STABLE_SIGNALS);

  const projectCollection = service.__test.compactProjectMemoryCollection(buildOversizedProjectCollection(limits), { now });
  const projectScopeItems = projectCollection.items.filter((item) => item.workspaceRoot === "/srv/project-a" && item.instanceLabel === "cloud");
  assert.strictEqual(projectScopeItems.length, limits.MAX_PROJECT_MEMORY_ITEMS_PER_SCOPE);
  assert.strictEqual(projectScopeItems.filter((item) => item.policyKey === "reply-shape").length, 1);
  assert.ok(projectCollection.audit.dedupedItems > 0);
  assert.ok(projectCollection.audit.trimmedItems > 0);
  assert.ok(projectCollection.audit.trimmedSignals > 0);

  const candidateCollection = service.__test.compactCandidateMemoryCollection(buildOversizedCandidateCollection(limits), { now });
  assert.strictEqual(candidateCollection.items.length, limits.MAX_GLOBAL_CANDIDATES);
  assert.strictEqual(candidateCollection.items.filter((item) => item.policyKey === "candidate-0").length, 1);
  assert.ok(candidateCollection.audit.dedupedItems > 0);
  assert.ok(candidateCollection.audit.trimmedItems > 0);

  const globalCollection = service.__test.compactGlobalMemoryCollection(buildOversizedGlobalCollection(limits), { now });
  assert.strictEqual(globalCollection.items.length, limits.MAX_GLOBAL_MEMORY_ITEMS);
  assert.strictEqual(globalCollection.items.filter((item) => item.policyKey === "global-0").length, 1);
  assert.ok(globalCollection.audit.dedupedItems > 0);
  assert.ok(globalCollection.audit.trimmedItems > 0);

  const { manager, runtime } = createHarness();
  manager.store.setWeeklySummary(compactedWeekly);
  manager.store.setProjectDurableMemory(projectCollection);
  manager.store.setGlobalPromotionCandidates(candidateCollection);
  manager.store.setGlobalDurableMemory(globalCollection);

  const summary = manager.getMemorySummary({
    runtime,
    workspaceRoot: "/srv/project-a",
    instanceLabel: "cloud",
  });
  assert.ok(summary.includes("weekly audit"));
  assert.ok(summary.includes("project audit"));
  assert.ok(summary.includes("global audit"));
  assert.ok(summary.includes("candidate audit"));

  const doctor = await manager.buildDoctorSection({
    runtime,
    workspaceRoot: "/srv/project-a",
    bindingKey: "default:oc_test:sender:ou_test",
  });
  assert.ok(doctor.includes("weekly audit"));
  assert.ok(doctor.includes("project audit"));
  assert.ok(doctor.includes("global audit"));
  assert.ok(doctor.includes("candidates audit"));
}

function testProjectMemoryPromotionCoolingAndDelete() {
  const { manager } = createHarness();
  const store = manager.store;
  const workspaceRoot = "/srv/project-a";
  const instanceLabel = "cloud";

  runOneUpdate(store, { workspaceRoot, instanceLabel, effective: true, weekKey: "2026-W19" });
  let item = store.getProjectDurableMemory().items.find((entry) => entry.policyKey === "reply-shape");
  assert.strictEqual(item, undefined);

  runOneUpdate(store, { workspaceRoot, instanceLabel, effective: true, weekKey: "2026-W20" });
  item = store.getProjectDurableMemory().items.find((entry) => entry.policyKey === "reply-shape");
  assert.strictEqual(item, undefined);

  runOneUpdate(store, { workspaceRoot, instanceLabel, effective: true, weekKey: "2026-W21" });
  item = store.getProjectDurableMemory().items.find((entry) => entry.policyKey === "reply-shape");
  assert.strictEqual(item.state, "active");
  assert.strictEqual(item.hitWeeks, 3);
  assert.ok(item.strength >= 70);

  for (let index = 22; index <= 25; index += 1) {
    runOneUpdate(store, {
      workspaceRoot,
      instanceLabel,
      effective: false,
      weekKey: `2026-W${index}`,
    });
  }
  item = store.getProjectDurableMemory().items.find((entry) => entry.policyKey === "reply-shape");
  assert.strictEqual(item.state, "cooling");
  assert.strictEqual(item.coldWeeks, 4);

  runOneUpdate(store, {
    workspaceRoot,
    instanceLabel,
    effective: false,
    weekKey: "2026-W26",
  });
  runOneUpdate(store, {
    workspaceRoot,
    instanceLabel,
    effective: false,
    weekKey: "2026-W27",
  });
  item = store.getProjectDurableMemory().items.find((entry) => entry.policyKey === "reply-shape");
  assert.strictEqual(item, undefined);
}

async function testGlobalCandidatePromoteRejectAndDemote() {
  const { manager } = createHarness();
  const store = manager.store;
  const candidateId = "candidate_global_reply_shape";

  store.setProjectDurableMemory({
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items: [
      buildProjectMemory("reply-shape", "/srv/a"),
      buildProjectMemory("reply-shape", "/srv/b"),
    ],
  });
  store.setGlobalPromotionCandidates({
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items: [{
      candidateId,
      policyKey: "reply-shape",
      summary: "Keep replies concise and action-first.",
      sourceProjects: ["/srv/a", "/srv/b"],
      strength: 70,
      coldWeeks: 0,
      lastHitWeek: "2026-W21",
      state: "candidate",
    }],
  });

  const result = await manager.promoteGlobal(candidateId);
  assert.strictEqual(result.ok, true);
  const global = store.getGlobalDurableMemory().items[0];
  assert.strictEqual(global.state, "active");
  assert.strictEqual(global.strength, 80);

  store.setGlobalPromotionCandidates({ version: 1, updatedAt: "", items: [] });
  for (let index = 0; index < 6; index += 1) {
    const current = store.getGlobalDurableMemory();
    current.items[0].coldWeeks = index;
    store.setGlobalDurableMemory(current);
    const next = forceGlobalDemote(manager, `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`);
    store.setGlobalDurableMemory(next);
  }
  const pending = store.getGlobalDurableMemory().items[0];
  assert.strictEqual(pending.state, "pending_demote");

  const rejectResult = await manager.rejectGlobal(pending.memoryId);
  assert.strictEqual(rejectResult.ok, true);
  assert.strictEqual(store.getGlobalDurableMemory().items.length, 0);
  assert.strictEqual(store.getGlobalPromotionCandidates().items.length, 1);
}

async function testRuntimeMessagePrefixInjection() {
  const { manager, runtime } = createHarness();
  manager.store.setProjectDurableMemory({
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items: [buildProjectMemory("reply-shape", "/srv/project-a")],
  });
  manager.store.setGlobalDurableMemory({
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items: [{
      memoryId: "global_1",
      policyKey: "approval-guard",
      summary: "Do not alter approval flows.",
      sourceProjects: ["/srv/project-a", "/srv/project-b"],
      strength: 80,
      coldWeeks: 0,
      lastHitWeek: "2026-W21",
      state: "active",
    }],
  });
  const prefix = await manager.buildMessagePrefix({
    runtime,
    normalized: buildNormalized("继续", { workspaceRoot: "/srv/project-a" }),
  });
  assert.ok(prefix.includes("<feishu-optimization-memory>"));
  assert.ok(prefix.includes("[project]"));
  assert.ok(prefix.includes("[global]"));
}

async function testCoolingAndPendingMemoryDoNotInject() {
  const { manager, runtime } = createHarness();
  manager.store.setProjectDurableMemory({
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items: [
      buildProjectMemory("reply-shape", "/srv/project-a"),
      {
        ...buildProjectMemory("cold-reply-shape", "/srv/project-a"),
        summary: "This cooling project memory must stay out of ordinary chat.",
        state: "cooling",
        coldWeeks: 4,
      },
    ],
  });
  manager.store.setGlobalDurableMemory({
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items: [{
      memoryId: "global_pending_1",
      policyKey: "approval-guard",
      summary: "This pending global memory must stay out of ordinary chat.",
      sourceProjects: ["/srv/project-a", "/srv/project-b"],
      strength: 20,
      coldWeeks: 6,
      lastHitWeek: "2026-W15",
      state: "pending_demote",
    }],
  });

  const prefix = await manager.buildMessagePrefix({
    runtime,
    normalized: buildNormalized("继续", { workspaceRoot: "/srv/project-a" }),
  });
  assert.ok(prefix.includes("Keep replies concise and action-first."));
  assert.ok(!prefix.includes("cooling project memory"));
  assert.ok(!prefix.includes("pending global memory"));
}

function testGlobalCandidateColdDelete() {
  const service = require("../src/domain/optimization/service");
  let candidates = {
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items: [{
      candidateId: "candidate_cold_reply_shape",
      policyKey: "reply-shape",
      summary: "Candidate should disappear after six cold weeks.",
      sourceProjects: ["/srv/a", "/srv/b"],
      strength: 70,
      coldWeeks: 0,
      lastHitWeek: "2026-W21",
      state: "candidate",
    }],
  };
  for (let index = 0; index < 6; index += 1) {
    candidates = service.__test.updateGlobalCandidates(candidates, {
      version: 1,
      updatedAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      items: [],
    }, {
      now: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }).memory;
  }
  assert.strictEqual(candidates.items.length, 0);
}

function testPluginRoutingHintOverride() {
  const text = "把这段聊天整理成需求文档";
  assert.strictEqual(pluginRoutingService.detectFirstBatchPluginIntent(text, {
    minRouteScore: 99,
  }), null);
  const route = pluginRoutingService.detectFirstBatchPluginIntent(text, {
    minRouteScore: 2,
  });
  assert.ok(route);
}

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-optimization-"));
  const sessionsFile = path.join(tempDir, "sessions.json");
  const manager = createOptimizationManager({ sessionsFile, instanceLabel: "cloud" });
  const sent = [];
  const runtime = {
    getBindingContext(normalized) {
      return {
        bindingKey: "default:oc_test:sender:ou_test",
        workspaceRoot: normalized.workspaceRoot || "/srv/project-a",
      };
    },
    sendInfoCardMessage(payload) {
      sent.push(payload.text);
      return Promise.resolve();
    },
  };
  return { manager, runtime, sent };
}

function runOneUpdate(store, { workspaceRoot, instanceLabel, effective, weekKey }) {
  const latestScore = buildLatestScore(weekKey, workspaceRoot, effective, instanceLabel);
  const service = require("../src/domain/optimization/service");
  assert.ok(service.__test);
  const weeklySummary = service.__test.mergeWeeklySummary(
    store.getWeeklySummary(),
    latestScore
  );
  store.setWeeklySummary(weeklySummary);
  const projectUpdate = service.__test.updateProjectDurableMemory(
    store.getProjectDurableMemory(),
    weeklySummary,
    latestScore,
    {
      instanceLabel,
      workspaceRoot,
      now: latestScore.createdAt,
    }
  );
  store.setProjectDurableMemory(projectUpdate.memory);
}

function forceGlobalDemote(manager, now) {
  const service = require("../src/domain/optimization/service");
  return service.__test.updateGlobalDurableMemory(
    manager.store.getGlobalDurableMemory(),
    manager.store.getGlobalPromotionCandidates(),
    { now }
  ).memory;
}

function buildLatestScore(weekKey, workspaceRoot, effective = true, instanceLabel = "cloud") {
  return {
    kind: "score",
    mode: "all",
    weekKey,
    workspaceRoot,
    instanceLabel,
    createdAt: `${weekKey}-1`,
    score: effective ? 90 : 40,
    checks: [{
      policyKey: "reply-shape",
      summary: "Keep replies concise and action-first.",
      applyNotes: "Use short sections.",
      stableSignals: ["confirmed useful"],
      score: effective ? 90 : 40,
      effective,
      regression: false,
    }],
  };
}

function buildWeeklySummary(weekKey, policyKey, effective) {
  return {
    version: 1,
    weekKey,
    updatedAt: `${weekKey}-1`,
    runCount: 1,
    lastMode: "all",
    lastSurface: "score",
    policies: {
      [policyKey]: {
        policyKey,
        summary: "Keep replies concise and action-first.",
        applyNotes: "Use short sections.",
        stableSignals: ["confirmed useful"],
        hitWeeks: effective ? 1 : 0,
        coldWeeks: effective ? 0 : 1,
        lastHitWeek: effective ? weekKey : "",
        lastColdWeek: effective ? "" : weekKey,
        regression: false,
        effective,
        state: effective ? "effective" : "cooling",
        updatedAt: `${weekKey}-1`,
      },
    },
  };
}

function buildOversizedWeeklySummary(policyCount, signalCount) {
  const policies = {};
  for (let index = 0; index < policyCount; index += 1) {
    const policyKey = `policy-${String(index).padStart(2, "0")}`;
    policies[policyKey] = {
      policyKey,
      summary: `${policyKey} ${"summary ".repeat(40)}`.trim(),
      applyNotes: `${policyKey} ${"notes ".repeat(40)}`.trim(),
      stableSignals: Array.from({ length: signalCount }, (_, signalIndex) => `${policyKey}-signal-${signalIndex}`),
      hitWeeks: index === 0 ? 999 : index + 1,
      coldWeeks: 0,
      lastScore: index === 0 ? 999 : 80 - index,
      lastRuleScore: index === 0 ? 999 : 80 - index,
      lastLlmScore: index === 0 ? 999 : 80 - index,
      lastDelta: 0,
      lastHitWeek: "2026-W21",
      lastColdWeek: "",
      regression: false,
      effective: index === 0 || index % 2 === 0,
      state: "effective",
      updatedAt: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    };
  }
  return {
    version: 1,
    weekKey: "2026-W21",
    updatedAt: "2026-05-01T00:00:00.000Z",
    runCount: 4,
    lastMode: "all",
    lastSurface: "score",
    policies,
  };
}

function buildOversizedProjectCollection(limits) {
  const items = [];
  items.push({
    memoryId: "project-dup-a",
    policyKey: "reply-shape",
    workspaceRoot: "/srv/project-a",
    instanceLabel: "cloud",
    summary: `${"reply shape ".repeat(30)}`.trim(),
    applyNotes: `${"project notes ".repeat(30)}`.trim(),
    stableSignals: Array.from({ length: limits.MAX_STABLE_SIGNALS + 4 }, (_, index) => `signal-${index}`),
    hitWeeks: 999,
    coldWeeks: 0,
    strength: 999,
    lastHitWeek: "2026-W21",
    state: "active",
  });
  items.push({
    memoryId: "project-dup-b",
    policyKey: "reply-shape",
    workspaceRoot: "/srv/project-a",
    instanceLabel: "cloud",
    summary: "reply shape duplicate",
    applyNotes: "duplicate notes",
    stableSignals: ["signal-0", "signal-1"],
    hitWeeks: 998,
    coldWeeks: 0,
    strength: 998,
    lastHitWeek: "2026-W20",
    state: "active",
  });
  for (let index = 1; index <= limits.MAX_PROJECT_MEMORY_ITEMS_PER_SCOPE + 4; index += 1) {
    items.push({
      memoryId: `project-${index}`,
      policyKey: `policy-${index}`,
      workspaceRoot: "/srv/project-a",
      instanceLabel: "cloud",
      summary: `${`project ${index} `.repeat(20)}`.trim(),
      applyNotes: `${`apply ${index} `.repeat(20)}`.trim(),
      stableSignals: Array.from({ length: limits.MAX_STABLE_SIGNALS + 2 }, (_, signalIndex) => `policy-${index}-signal-${signalIndex}`),
      hitWeeks: index + 1,
      coldWeeks: 0,
      strength: 90 - index,
      lastHitWeek: `2026-W${String(20 + index).padStart(2, "0")}`,
      state: index % 3 === 0 ? "cooling" : "active",
    });
  }
  return {
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items,
  };
}

function buildOversizedCandidateCollection(limits) {
  const items = [];
  items.push({
    candidateId: "candidate-dup-a",
    policyKey: "candidate-0",
    summary: `${"candidate zero ".repeat(20)}`.trim(),
    sourceProjects: ["/srv/a", "/srv/b", "/srv/c", "/srv/d", "/srv/e", "/srv/f", "/srv/g", "/srv/h", "/srv/i"],
    strength: 999,
    coldWeeks: 0,
    lastHitWeek: "2026-W21",
    state: "candidate",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });
  items.push({
    candidateId: "candidate-dup-b",
    policyKey: "candidate-0",
    summary: "candidate zero duplicate",
    sourceProjects: ["/srv/a", "/srv/b"],
    strength: 998,
    coldWeeks: 0,
    lastHitWeek: "2026-W20",
    state: "candidate",
    updatedAt: "2026-05-02T00:00:00.000Z",
  });
  for (let index = 1; index <= limits.MAX_GLOBAL_CANDIDATES + 4; index += 1) {
    items.push({
      candidateId: `candidate-${index}`,
      policyKey: `candidate-${index}`,
      summary: `${`candidate ${index} `.repeat(20)}`.trim(),
      sourceProjects: Array.from({ length: 10 }, (_, sourceIndex) => `/srv/project-${index}-${sourceIndex}`),
      strength: 100 - index,
      coldWeeks: 0,
      lastHitWeek: `2026-W${String(20 + index).padStart(2, "0")}`,
      state: "candidate",
      updatedAt: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }
  return {
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items,
  };
}

function buildOversizedGlobalCollection(limits) {
  const items = [];
  items.push({
    memoryId: "global-dup-a",
    policyKey: "global-0",
    summary: `${"global zero ".repeat(20)}`.trim(),
    sourceProjects: ["/srv/a", "/srv/b", "/srv/c", "/srv/d", "/srv/e", "/srv/f", "/srv/g", "/srv/h", "/srv/i"],
    strength: 999,
    coldWeeks: 0,
    lastHitWeek: "2026-W21",
    state: "active",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });
  items.push({
    memoryId: "global-dup-b",
    policyKey: "global-0",
    summary: "global zero duplicate",
    sourceProjects: ["/srv/a", "/srv/b"],
    strength: 998,
    coldWeeks: 0,
    lastHitWeek: "2026-W20",
    state: "active",
    updatedAt: "2026-05-02T00:00:00.000Z",
  });
  for (let index = 1; index <= limits.MAX_GLOBAL_MEMORY_ITEMS + 4; index += 1) {
    items.push({
      memoryId: `global-${index}`,
      policyKey: `global-${index}`,
      summary: `${`global ${index} `.repeat(20)}`.trim(),
      sourceProjects: Array.from({ length: 10 }, (_, sourceIndex) => `/srv/global-${index}-${sourceIndex}`),
      strength: 100 - index,
      coldWeeks: index % 2 === 0 ? 0 : 2,
      lastHitWeek: `2026-W${String(20 + index).padStart(2, "0")}`,
      state: index % 2 === 0 ? "active" : "pending_demote",
      updatedAt: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }
  return {
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    items,
  };
}

function buildProjectMemory(policyKey, workspaceRoot) {
  return {
    memoryId: `project_${policyKey}_${path.basename(workspaceRoot)}`,
    policyKey,
    workspaceRoot,
    instanceLabel: "cloud",
    summary: "Keep replies concise and action-first.",
    applyNotes: "Use short sections.",
    stableSignals: ["confirmed useful"],
    hitWeeks: 3,
    coldWeeks: 0,
    strength: 80,
    lastHitWeek: "2026-W21",
    state: "active",
  };
}

function buildNormalized(text, options = {}) {
  return {
    chatId: "oc_test",
    messageId: "om_test",
    senderId: "ou_test",
    command: options.command || "message",
    text,
    workspaceRoot: options.workspaceRoot || "/srv/project-a",
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

Promise.resolve(main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

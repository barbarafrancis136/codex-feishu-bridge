#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { normalizeFeishuTextEvent } = require("../src/presentation/message/normalizers");
const appointmentService = require("../src/domain/appointment/service");
const { SessionStore } = require("../src/infra/storage/session-store");

const REPO_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, "..");
const FIXED_NOW = new Date("2026-05-21T09:00:00+08:00");
const TIMEZONE = "Asia/Shanghai";
const DEFAULT_APPOINTMENT_EVAL_CASES = [
  {
    input: "张颍蕊预约5月24号下午两点半染头发",
    expect: {
      intent: "create",
      shouldIntercept: true,
      customerName: "张颍蕊",
      serviceName: "染头发",
      datetimeExpected: true,
    },
  },
  {
    input: "张三明天下午三点染发",
    expect: {
      intent: "create",
      shouldIntercept: true,
      customerName: "张三",
      serviceName: "染发",
      datetimeExpected: true,
    },
  },
  {
    input: "预约功能为什么不能用",
    expect: {
      intent: "other",
      shouldIntercept: false,
    },
  },
  {
    input: "帮我查今天预约",
    expect: {
      intent: "other",
      shouldIntercept: false,
    },
  },
  {
    input: "李四预约下周二上午10点剪发",
    expect: {
      intent: "create",
      shouldIntercept: true,
      customerName: "李四",
      serviceName: "剪发",
      datetimeExpected: true,
    },
  },
];

async function runOptimizationScores(mode = "all") {
  const normalizedMode = normalizeMode(mode);
  const results = [];

  if (normalizedMode === "system" || normalizedMode === "all") {
    results.push(scoreSystem());
  }
  if (normalizedMode === "bridge" || normalizedMode === "all") {
    results.push(await scoreBridge());
  }
  if (normalizedMode === "bot" || normalizedMode === "all") {
    results.push(await scoreBot());
  }

  const score = round(
    results.reduce((sum, item) => sum + Number(item.score || 0), 0) / Math.max(1, results.length)
  );
  const ruleScore = round(
    results.reduce((sum, item) => sum + Number(item.ruleScore ?? item.score ?? 0), 0) / Math.max(1, results.length)
  );
  const llmScore = round(
    results.reduce((sum, item) => sum + Number(item.llmScore ?? item.score ?? 0), 0) / Math.max(1, results.length)
  );

  return {
    mode: normalizedMode,
    title: `Optimization ${normalizedMode}`,
    summary: buildSummary(results),
    score,
    ruleScore,
    llmScore,
    results,
  };
}

async function main() {
  const mode = normalizeMode(process.argv[2] || "all");
  const report = await runOptimizationScores(mode);
  printReport(report.results);
}

function scoreSystem() {
  const auditPath = path.join(WORKSPACE_ROOT, "plugin-audit-formal.json");
  const audit = fs.existsSync(auditPath) ? loadJson(auditPath) : [];
  const byLevel = countBy(audit, (item) => String(item.level || "unknown"));
  const total = audit.length || 1;
  const weights = { L0: 0, L1: 50, L2: 75, L3: 90, L4: 100 };
  const inventoryScore = round(
    audit.reduce((sum, item) => sum + (weights[item.level] ?? 0), 0) / total
  );
  const verifiedRuntimeCount = audit.filter((item) => String(item.verified_runtime || "").toLowerCase() === "yes").length;
  const usableNowCount = audit.filter((item) => ["L2", "L3", "L4"].includes(String(item.level))).length;

  const checks = [
    checkFileContains(path.join(REPO_ROOT, "src", "infra", "config", "config.js"), "appointmentReminderEnabled"),
    checkFileContains(path.join(REPO_ROOT, "src", "infra", "config", "config.js"), "appointmentReminderTimezone"),
    checkFileContains(path.join(REPO_ROOT, "src", "infra", "config", "config.js"), "appointmentReminderScanIntervalSec"),
    checkFileContains(path.join(REPO_ROOT, "src", "infra", "storage", "session-store.js"), "appointmentStateByChatScopeKey"),
    checkFileContains(path.join(REPO_ROOT, "src", "domain", "optimization", "service.js"), "PROJECT_PROMOTION_STREAK"),
    checkFileContains(path.join(REPO_ROOT, "package.json"), "\"test:optimization-memory\""),
  ];

  const supportScore = round((checks.filter((item) => item.ok).length / checks.length) * 100);
  const runtimeVerificationScore = audit.length ? round((verifiedRuntimeCount / total) * 100) : 0;
  const finalScore = audit.length
    ? round((inventoryScore * 0.55) + (runtimeVerificationScore * 0.2) + (supportScore * 0.25))
    : supportScore;

  return buildResult({
    name: "system",
    title: "系统优化跑分",
    score: finalScore,
    details: [
      audit.length ? `plugin-audit entries: ${audit.length}` : "plugin-audit entries: missing",
      audit.length ? `levels: ${formatCounts(byLevel)}` : "levels: n/a",
      audit.length ? `runtime-verified: ${verifiedRuntimeCount}` : "runtime-verified: n/a",
      audit.length ? `usable-now(L2+): ${usableNowCount}` : "usable-now(L2+): n/a",
      `support-score: ${supportScore}`,
    ],
    checks,
  });
}

async function scoreBridge() {
  const dispatcherSource = readText(path.join(REPO_ROOT, "src", "app", "dispatcher.js"));
  const commandDispatcherSource = readText(path.join(REPO_ROOT, "src", "app", "command-dispatcher.js"));
  const runtimeSource = readText(path.join(REPO_ROOT, "src", "app", "feishu-bot-runtime.js"));
  const registrySource = readText(path.join(REPO_ROOT, "src", "app", "capability-registry.js"));
  const optimizationServiceSource = readText(path.join(REPO_ROOT, "src", "domain", "optimization", "service.js"));
  const workspaceServiceSource = readText(path.join(REPO_ROOT, "src", "domain", "workspace", "workspace-service.js"));
  const configSource = readText(path.join(REPO_ROOT, "src", "infra", "config", "config.js"));
  const sessionStoreSource = readText(path.join(REPO_ROOT, "src", "infra", "storage", "session-store.js"));
  const normalizerSource = readText(path.join(REPO_ROOT, "src", "presentation", "message", "normalizers.js"));
  const threadServiceSource = readText(path.join(REPO_ROOT, "src", "domain", "thread", "thread-service.js"));
  const indexSource = readText(path.join(REPO_ROOT, "src", "index.js"));
  const morningRunSource = readText(path.join(REPO_ROOT, "scripts", "run-morning-briefing.js"));

  const checks = [
    {
      label: "thin bridge is the default and normal messages enter Codex",
      weight: 15,
      ok: configSource.includes('return ALLOWED_BRIDGE_MODES.has(value) ? value : "thin"')
        && dispatcherSource.includes('String(config?.bridgeMode || "thin")')
        && dispatcherSource.includes("coerceThinModeCommandToMessage")
        && dispatcherSource.includes("shouldPassthroughToCodex"),
    },
    {
      label: "manual attachment directives stay on message-only input",
      weight: 10,
      ok: dispatcherSource.includes("normalized?.command !== \"message\""),
    },
    {
      label: "legacy appointment routes remain extension-facing but not default thin path",
      weight: 12,
      ok: commandDispatcherSource.includes('appointment: "handleAppointmentCommand"')
        && commandDispatcherSource.includes('appointment: "handleAppointmentCardAction"')
        && registrySource.includes("!thinBridgeMode && shouldEnableAppointmentReminder(config)"),
    },
    {
      label: "runtime starts optional capabilities through the capability registry",
      weight: 15,
      ok: runtimeSource.includes("await this.capabilities.start(this);")
        && registrySource.includes("startMorningBriefingScheduler")
        && registrySource.includes("startAppointmentReminderScheduler")
        && indexSource.includes('config.bridgeMode === "standard"')
        && morningRunSource.includes('config.bridgeMode !== "standard"'),
    },
    {
      label: "doctor text surfaces bridge mode and internal capabilities",
      weight: 14,
      ok: workspaceServiceSource.includes("handleDoctorCommand")
        && runtimeSource.includes("buildDoctorText({ bindingKey = \"\", workspaceRoot = \"\" } = {})")
        && registrySource.includes("buildDoctorSections")
        && registrySource.includes("bridge mode:"),
    },
    {
      label: "optimization memory is disabled in thin mode and only active in standard mode",
      weight: 12,
      ok: registrySource.includes("thinBridgeMode")
        && registrySource.includes("disabled in thin mode")
        && registrySource.includes("optimizationManager = thinBridgeMode")
        && registrySource.includes("buildMessagePrefix")
        && optimizationServiceSource.includes("<feishu-optimization-memory>")
        && await canInjectOptimizationPrefix(),
    },
    {
      label: "legacy optimization commands are routed through runtime capabilities outside thin path",
      weight: 10,
      ok: workspaceServiceSource.includes("runtime?.capabilities?.handleOptimizationCommand")
        && workspaceServiceSource.includes("runtime?.optimizationManager?.handleCommand")
        && dispatcherSource.includes("THIN_MODE_LOCAL_COMMANDS")
        && !dispatcherSource.includes('"score",')
        && !dispatcherSource.includes('"eval",'),
    },
    {
      label: "message normalizer recognizes merged-forward content and appointment aliases",
      weight: 12,
      ok: normalizerSource.includes("merge_forward")
        && normalizerSource.includes('"/预约"')
        && normalizerSource.includes('"/appoint"'),
    },
    {
      label: "thread payload still keeps goal prefix separate from optimization prefix",
      weight: 10,
      ok: threadServiceSource.includes("feishu-project-goal")
        && threadServiceSource.includes("buildMessageWithBridgeCapabilities"),
    },
  ];

  return buildResult({
    name: "bridge",
    title: "飞书桥优化跑分",
    score: weightedScore(checks),
    details: [`route-checks: ${checks.filter((item) => item.ok).length}/${checks.length}`],
    checks,
  });
}

async function canInjectOptimizationPrefix() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-opt-prefix-"));
  const sessionsFile = path.join(tempDir, "sessions.json");
  const { createOptimizationManager } = require("../src/domain/optimization/service");
  const manager = createOptimizationManager({
    sessionsFile,
    instanceLabel: "cloud",
  });
  manager.store.setProjectDurableMemory({
    version: 1,
    updatedAt: "2026-05-24T00:00:00.000Z",
    items: [{
      memoryId: "project_mem_1",
      policyKey: "reply-shape",
      workspaceRoot: "/srv/project-a",
      instanceLabel: "cloud",
      summary: "Keep replies concise and action-first.",
      applyNotes: "Use short sections.",
      stableSignals: ["confirmed useful"],
      hitWeeks: 3,
      coldWeeks: 0,
      strength: 70,
      lastHitWeek: "2026-W21",
      state: "active",
    }],
  });

  const prefix = await manager.buildMessagePrefix({
    runtime: {
      getBindingContext() {
        return {
          bindingKey: "default:oc_test:sender:ou_test",
          workspaceRoot: "/srv/project-a",
        };
      },
    },
    normalized: {
      command: "message",
      text: "继续",
    },
  });
  return String(prefix || "").includes("<feishu-optimization-memory>");
}

async function scoreBot() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-bot-score-"));
  const cases = loadAppointmentEvalCases();
  const checks = [];

  for (const [index, item] of cases.entries()) {
    checks.push({
      label: `case ${index + 1}`,
      weight: 12,
      ok: await evaluateAppointmentCase(item, index, tempDir),
    });
  }

  checks.push({
    label: "spaced-date recognition",
    weight: 10,
    ok: evaluateSpacedDateParsing(),
  });

  checks.push({
    label: "appointment suite passes",
    weight: 30,
    ok: runAppointmentSuite(),
  });

  return buildResult({
    name: "bot",
    title: "飞书bot优化跑分",
    score: weightedScore(checks),
    details: [
      `cases: ${checks.slice(0, cases.length).filter((item) => item.ok).length}/${cases.length}`,
      `extras: ${checks.slice(cases.length).filter((item) => item.ok).length}/2`,
    ],
    checks,
  });
}

function loadAppointmentEvalCases() {
  const candidatePaths = [
    path.join(WORKSPACE_ROOT, "appointment_eval_cases.json"),
    path.join(REPO_ROOT, "appointment_eval_cases.json"),
  ];
  for (const filePath of candidatePaths) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const parsed = loadJson(filePath);
    if (Array.isArray(parsed?.cases) && parsed.cases.length) {
      return parsed.cases;
    }
  }
  return DEFAULT_APPOINTMENT_EVAL_CASES.slice();
}

async function evaluateAppointmentCase(item, index, tempDir) {
  const shouldIntercept = Boolean(item.expect?.shouldIntercept);
  if (shouldIntercept) {
    const parsed = appointmentService.parseNaturalLanguageAppointmentText(item.input, {
      now: FIXED_NOW,
      timezone: TIMEZONE,
    });
    return Boolean(
      parsed.ok
      && parsed.intentDetected
      && parsed.datetimeDetected
      && (!item.expect?.customerName || parsed.customerName === item.expect.customerName)
      && (!item.expect?.serviceName || parsed.serviceName === item.expect.serviceName)
    );
  }

  const runtime = createAppointmentRuntime(path.join(tempDir, `case-${index}.json`));
  const normalized = normalizeTextMessage(item.input, `om_case_${index}`);
  const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
  if (shouldIntercept) {
    return result === null && runtime.sent.cards.length === 1 && runtime.sent.info.length === 0;
  }
  return result === normalized && runtime.sent.cards.length === 0 && runtime.sent.info.length === 0;
}

function evaluateSpacedDateParsing() {
  const parsed = appointmentService.parseNaturalLanguageAppointmentText("张颍蕊预约5 月24号下午两点半染头发", {
    now: FIXED_NOW,
    timezone: TIMEZONE,
  });
  return Boolean(parsed.ok && parsed.customerName === "张颍蕊" && parsed.datetimeDetected);
}

function runAppointmentSuite() {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "test-appointment-service.js")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) {
    return false;
  }
  return result.status === 0;
}

function createAppointmentRuntime(filePath) {
  const sent = { info: [], cards: [], patches: [], toasts: [] };
  const sessionStore = new SessionStore({ filePath });
  return {
    config: {
      defaultWorkspaceId: "default",
      appointmentReminderEnabled: true,
      appointmentReminderTimezone: TIMEZONE,
      appointmentReminderScanIntervalSec: 60,
    },
    sessionStore,
    sent,
    resolveReplyToMessageId(normalized, replyToMessageId = "") {
      return replyToMessageId || normalized.messageId;
    },
    buildCardToast(text) {
      const toast = { text };
      sent.toasts.push(toast);
      return toast;
    },
    buildCardResponse(payload) {
      return payload;
    },
    queueCardActionWithFeedback(_normalized, _feedback, task) {
      return Promise.resolve().then(() => task());
    },
    patchInteractiveCard(payload) {
      sent.patches.push(payload);
      return Promise.resolve(payload);
    },
    sendInfoCardMessage(payload) {
      sent.info.push(payload);
      return Promise.resolve(payload);
    },
    sendInteractiveCard(payload) {
      sent.cards.push(payload);
      return Promise.resolve(payload);
    },
    sendCardActionFeedbackByContext() {
      return Promise.resolve();
    },
  };
}

function normalizeTextMessage(text, messageId) {
  return normalizeFeishuTextEvent({
    sender: { sender_id: { open_id: "ou_test" } },
    message: {
      message_type: "text",
      chat_id: "oc_score",
      message_id: messageId,
      content: JSON.stringify({ text }),
    },
  }, {
    defaultWorkspaceId: "default",
  });
}

function buildResult({ name, title, score, details = [], checks = [] }) {
  const ruleScore = weightedScore(checks);
  return {
    name,
    policyKey: name,
    title,
    summary: `${title}：${ruleScore}/100，${checks.filter((item) => item.ok).length}/${checks.length} 项通过。`,
    applyNotes: `Use ${name} score signals to update optimization memory and doctor output.`,
    stableSignals: checks.filter((item) => item.ok).slice(0, 4).map((item) => item.label),
    regression: checks.some((item) => !item.ok),
    effective: Number(score || 0) >= 70,
    score: round(score),
    ruleScore,
    llmScore: ruleScore,
    details,
    checks,
  };
}

function buildSummary(results) {
  return results
    .map((item) => `${item.name}:${item.score}/100`)
    .join(" | ");
}

function normalizeMode(mode) {
  return String(mode || "all").trim().toLowerCase();
}

function weightedScore(checks) {
  const totalWeight = checks.reduce((sum, item) => sum + Number(item.weight || 0), 0) || 1;
  const passedWeight = checks.reduce((sum, item) => sum + (item.ok ? Number(item.weight || 0) : 0), 0);
  return round((passedWeight / totalWeight) * 100);
}

function checkFileContains(filePath, needle) {
  return {
    label: `${path.basename(filePath)} includes ${needle}`,
    weight: 1,
    ok: readText(filePath).includes(needle),
  };
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function loadJson(filePath) {
  return JSON.parse(readText(filePath).replace(/^\uFEFF/, ""));
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items || []) {
    const key = selector(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function formatCounts(counts) {
  return Object.entries(counts)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
}

function round(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function printReport(results) {
  for (const result of results) {
    console.log(`${result.title}: ${result.score}/100`);
    for (const detail of result.details || []) {
      console.log(`- ${detail}`);
    }
    for (const check of result.checks || []) {
      console.log(`- ${check.ok ? "PASS" : "FAIL"} ${check.label}`);
    }
    console.log("");
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  runOptimizationScores,
  scoreSystem,
  scoreBridge,
  scoreBot,
  weightedScore,
};

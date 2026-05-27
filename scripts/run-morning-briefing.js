#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("../src/infra/config/config");
const { FeishuBotRuntime } = require("../src/app/feishu-bot-runtime");
const { ensureMorningBriefingSkill } = require("../src/morning/skill-bootstrap");
const { runMorningBriefing } = require("../src/morning/service");

function loadEnv() {
  const defaultConfigDir = path.join(os.homedir(), ".codex-im");
  fs.mkdirSync(defaultConfigDir, { recursive: true });
  const envCandidates = [
    path.join(process.cwd(), ".env"),
    path.join(defaultConfigDir, ".env"),
  ];

  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath });
    return;
  }

  dotenv.config();
}

async function initializeManualRuntime(runtime) {
  runtime.validateConfig();
  runtime.initializeFeishuSdk();
  await runtime.codex.connect();
  await runtime.codex.initialize();
  await runtime.refreshAvailableModelCatalogAtStartup();
}

function waitForThreadCompletion(runtime, threadId, timeoutMs = 10 * 60 * 1000) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = null;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
      resolve(value);
    };

    unsubscribe = runtime.codex.onMessage((message) => {
      const method = String(message?.method || "");
      const params = message?.params || {};
      if (String(params?.threadId || "") !== normalizedThreadId) {
        return;
      }
      if (method === "turn/completed") {
        finish(true);
        return;
      }
      if (method === "turn/failed" || method === "turn/cancelled") {
        finish(false);
      }
    });

    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function disposeManualRuntime(runtime) {
  try {
    if (runtime.codex.socket && typeof runtime.codex.socket.close === "function") {
      runtime.codex.socket.close();
    }
  } catch {}

  try {
    if (runtime.codex.child) {
      runtime.codex.child.kill("SIGTERM");
    }
  } catch {}
}

async function main() {
  loadEnv();
  const config = readConfig();
  if (config.bridgeMode !== "standard") {
    console.log("morning briefing is a legacy standard-mode capability; set CODEX_IM_BRIDGE_MODE=standard to run it locally.");
    process.exitCode = 1;
    return;
  }
  ensureMorningBriefingSkill(config.skillRoot);
  const runtime = new FeishuBotRuntime(config);
  try {
    await initializeManualRuntime(runtime);
    const result = await runMorningBriefing(runtime, { manual: true });
    if (!result.ok) {
      console.log(`morning briefing skipped: ${result.reason || "unknown"}`);
      process.exitCode = 1;
      return;
    }
    const completed = await waitForThreadCompletion(runtime, result.threadId);
    if (!completed) {
      console.warn(`morning briefing did not finish before timeout: thread=${result.threadId} chat=${result.chatId}`);
      process.exitCode = 1;
      return;
    }
    console.log(`morning briefing completed: thread=${result.threadId} chat=${result.chatId}`);
  } finally {
    await disposeManualRuntime(runtime);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

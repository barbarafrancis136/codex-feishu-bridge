const path = require("path");
const os = require("os");
const fs = require("fs");
const dotenv = require("dotenv");

const { readConfig } = require("./infra/config/config");
const { FeishuBotRuntime } = require("./app/feishu-bot-runtime");
const { createLogger } = require("./shared/logger");
const { ensureMorningBriefingSkill } = require("./morning/skill-bootstrap");

const logger = createLogger("process");

function loadEnv() {
  ensureDefaultConfigDirectory();

  const envCandidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".codex-im", ".env"),
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

function ensureDefaultConfigDirectory() {
  const defaultConfigDir = path.join(os.homedir(), ".codex-im");
  fs.mkdirSync(defaultConfigDir, { recursive: true });
}

async function main() {
  installProcessGuards();
  loadEnv();
  const config = readConfig();
  if (config.bridgeMode === "standard") {
    ensureMorningBriefingSkill(config.skillRoot);
  }

  if (!config.mode || config.mode === "feishu-bot") {
    const runtime = new FeishuBotRuntime(config);
    installShutdownHandlers(runtime);
    await runtime.start();
    return;
  }

  console.error("Usage: codex-im [feishu-bot]");
  process.exit(1);
}

function installProcessGuards() {
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled promise rejection", {
      reason: normalizeProcessError(reason),
    });
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error: normalizeProcessError(error) });
    process.exit(1);
  });
}

function installShutdownHandlers(runtime) {
  let shuttingDown = false;
  const handleSignal = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const forceExitTimer = setTimeout(() => {
      process.exit(0);
    }, 8000);
    if (typeof forceExitTimer.unref === "function") {
      forceExitTimer.unref();
    }
    Promise.resolve(runtime?.shutdownGracefully?.({ signal }))
      .catch((error) => {
        logger.error("graceful shutdown failed", {
          signal,
          error: normalizeProcessError(error),
        });
      })
      .finally(() => {
        clearTimeout(forceExitTimer);
        process.exit(0);
      });
  };

  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
}

function normalizeProcessError(error) {
  if (!error) {
    return { message: "unknown error" };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[codex-im] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };

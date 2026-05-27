const fs = require("fs");
const os = require("os");
const path = require("path");

function resolveOptimizationStateDir(sessionsFile) {
  const baseSessionsFile = normalizeSessionsFilePath(sessionsFile);
  return path.join(path.dirname(baseSessionsFile), "optimization-state");
}

function resolveOptimizationStatePaths(sessionsFile) {
  const dir = resolveOptimizationStateDir(sessionsFile);
  return {
    dir,
    latestScore: path.join(dir, "latest-score.json"),
    previousScore: path.join(dir, "previous-score.json"),
    weeklySummary: path.join(dir, "weekly-summary.json"),
    effectiveState: path.join(dir, "effective-state.json"),
    rollbackState: path.join(dir, "rollback-state.json"),
    projectDurableMemory: path.join(dir, "project-durable-memory.json"),
    globalDurableMemory: path.join(dir, "global-durable-memory.json"),
    globalPromotionCandidates: path.join(dir, "global-promotion-candidates.json"),
  };
}

function normalizeSessionsFilePath(value) {
  const trimmed = String(value || "").trim();
  if (trimmed) {
    return trimmed;
  }
  return path.join(os.homedir(), ".codex-im", "sessions.json");
}

function ensureOptimizationStateDir(sessionsFile) {
  const dir = resolveOptimizationStateDir(sessionsFile);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  ensureOptimizationStateDir,
  resolveOptimizationStateDir,
  resolveOptimizationStatePaths,
};

const fs = require("fs");
const path = require("path");

async function summarizeDirectoryFiles(rootDir) {
  let fileCount = 0;
  let totalBytes = 0;
  const queue = [rootDir];
  while (queue.length) {
    const current = queue.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      fileCount += 1;
      const stats = await fs.promises.stat(fullPath);
      totalBytes += Number(stats.size || 0);
    }
  }
  return { fileCount, totalBytes };
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let size = value;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rounded = size >= 10 || unitIndex === 0
    ? Math.round(size * 10) / 10
    : Math.round(size * 100) / 100;
  return `${rounded} ${units[unitIndex]}`;
}

module.exports = {
  summarizeDirectoryFiles,
  normalizePositiveInt,
  formatBytes,
};

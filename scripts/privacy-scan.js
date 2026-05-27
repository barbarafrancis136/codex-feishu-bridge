#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "coverage",
  "dist",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "privacy-scan.js",
  "scripts/privacy-scan.js",
]);

const SKIP_EXTENSIONS = new Set([
  ".tgz",
  ".gz",
  ".zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
]);

const PRIVATE_TRACKED_PATHS = [
  { name: "private-workspace-path", re: /^00-Inbox\// },
  { name: "private-workspace-path", re: /^10-/ },
  { name: "private-workspace-path", re: /^40-/ },
  { name: "private-workspace-path", re: /^50-/ },
  { name: "private-workspace-path", re: /^60-/ },
  { name: "private-workspace-path", re: /^70-/ },
  { name: "private-workspace-path", re: /^99-Archive\// },
  { name: "private-plugin-state-path", re: /^\.codex-plugin\// },
  { name: "private-local-helper-path", re: /^stapp\.py$/ },
  { name: "private-local-helper-path", re: /^requirements\.txt$/ },
  { name: "private-memory-extension-path", re: /^extensions\/mem0-extension\.js$/ },
  { name: "private-memory-client-path", re: /^src\/infra\/memory\/mem0-client\.js$/ },
];

const PATTERNS = [
  { name: "private-persona", re: /\b(Jiao|Mira)\b|予安/g },
  { name: "private-systems", re: /Obsidian|TaskNotes|OpenClaw|Hermes|Chronicle|Knowledge Wiki|Over CDN/gi },
  { name: "local-private-path", re: /\/Users\/keeploving/g },
  { name: "env-secret-assignment", re: /FEISHU_APP_SECRET\s*=\s*(?!x{6,}|YOUR_|<|$)[^\s]+/g },
  { name: "openai-like-secret", re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
];

const ALLOWED_PUBLIC_TERMS = [
  "Jiao-Joe",
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(ROOT, fullPath);
    const normalizedRelPath = relPath.split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        files.push(...walk(fullPath));
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (
      SKIP_FILES.has(entry.name) ||
      SKIP_FILES.has(relPath) ||
      SKIP_FILES.has(normalizedRelPath) ||
      SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      continue;
    }
    files.push(relPath);
  }
  return files;
}

function scanFile(relPath) {
  const fullPath = path.join(ROOT, relPath);
  const findings = [];
  let text = fs.readFileSync(fullPath, "utf8");
  for (const term of ALLOWED_PUBLIC_TERMS) {
    text = text.replaceAll(term, "[allowed-public-owner]");
  }
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(text)) !== null) {
      const before = text.slice(0, match.index);
      const line = before.split(/\r?\n/).length;
      findings.push({ file: relPath, line, name: pattern.name, match: match[0] });
    }
  }
  return findings;
}

function main() {
  const candidates = listTrackedFiles();
  const pathFindings = candidates.flatMap(scanTrackedPath);
  const files = candidates.filter(shouldScanFile);
  const textFiles = files.filter(isTextFile);
  const findings = [
    ...pathFindings,
    ...textFiles.flatMap(scanFile),
  ];
  if (findings.length) {
    console.error("Privacy scan failed:");
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} [${finding.name}] ${finding.match}`);
    }
    process.exit(1);
  }
  console.log(`Privacy scan passed (${textFiles.length} tracked text files checked; ${files.length - textFiles.length} binary files skipped).`);
}

function scanTrackedPath(relPath) {
  const normalizedRelPath = normalizeRelPath(relPath);
  const findings = [];
  for (const rule of PRIVATE_TRACKED_PATHS) {
    if (rule.re.test(normalizedRelPath)) {
      findings.push({
        file: normalizedRelPath,
        line: 1,
        name: rule.name,
        match: normalizedRelPath,
      });
    }
  }
  return findings;
}

function listTrackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status === 0 && result.stdout) {
    return result.stdout
      .split("\0")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return walk(ROOT).map(normalizeRelPath);
}

function shouldScanFile(relPath) {
  const normalizedRelPath = normalizeRelPath(relPath);
  const baseName = path.basename(normalizedRelPath);
  if (!fs.existsSync(path.join(ROOT, normalizedRelPath))) {
    return false;
  }
  if (
    SKIP_FILES.has(baseName) ||
    SKIP_FILES.has(normalizedRelPath) ||
    SKIP_EXTENSIONS.has(path.extname(baseName).toLowerCase())
  ) {
    return false;
  }
  return !normalizedRelPath.split("/").some((part) => SKIP_DIRS.has(part));
}

function isTextFile(relPath) {
  const fullPath = path.join(ROOT, relPath);
  const chunk = fs.readFileSync(fullPath).subarray(0, 8192);
  return !chunk.includes(0);
}

function normalizeRelPath(relPath) {
  return String(relPath || "").split(path.sep).join("/");
}

main();

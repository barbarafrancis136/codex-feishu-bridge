#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

const promptfooEntrypoint = path.join(__dirname, "..", "node_modules", "promptfoo", "dist", "src", "main.js");
const args = process.argv.slice(2);

function main() {
  if (!fs.existsSync(promptfooEntrypoint)) {
    console.error("promptfoo entrypoint not found. Run `npm install` first.");
    process.exitCode = 1;
    return;
  }

  const nodePath = resolveNode();
  if (!nodePath) {
    console.error("No Node.js runtime found for promptfoo.");
    process.exitCode = 1;
    return;
  }

  const result = childProcess.spawnSync(nodePath, [promptfooEntrypoint, ...args], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
    windowsHide: true,
  });

  if (typeof result.status === "number") {
    process.exitCode = result.status;
    return;
  }

  if (result.error) {
    console.error(result.error.message);
  }
  process.exitCode = 1;
}

function resolveNode() {
  const candidates = unique([
    process.env.CODEX_PROMPTFOO_NODE,
    process.execPath,
    path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin", "node.exe"),
    path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin", "node.exe"),
  ].filter(Boolean));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function unique(values) {
  return Array.from(new Set(values.map((item) => String(item))));
}

main();

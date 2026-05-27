#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "domain", "workspace", "workspace-service.js"),
  "utf8"
);

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skill-scaffold-"));
  const skillRoot = path.join(tempRoot, "skills");
  fs.mkdirSync(skillRoot, { recursive: true });

  const {
    createCloudAssetScaffold,
    parseAssetCreateRequest,
    normalizeAssetDescription,
    normalizeSkillType,
    toYamlScalar,
  } = loadSkillHelpers();
  const parsed = parseAssetCreateRequest("demo-skill --type bot --without-references --with-scripts Generate a concise daily finance morning briefing for Feishu");
  assert.strictEqual(parsed.name, "demo-skill");
  assert.strictEqual(parsed.type, "bot");
  assert.strictEqual(parsed.withScripts, true);
  assert.strictEqual(parsed.withReferences, false);

  const result = createCloudAssetScaffold({
    kind: "skill",
    root: skillRoot,
    name: parsed.name,
    type: parsed.type,
    withScripts: parsed.withScripts,
    withReferences: parsed.withReferences,
    description: parsed.description,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.type, "bot");
  assert.strictEqual(result.withScripts, true);
  assert.strictEqual(result.withReferences, false);
  assert.ok(fs.existsSync(path.join(skillRoot, "demo-skill", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(skillRoot, "demo-skill", "agents", "openai.yaml")));
  assert.ok(fs.existsSync(path.join(skillRoot, "demo-skill", "scripts", "run.js")));
  assert.ok(!fs.existsSync(path.join(skillRoot, "demo-skill", "references", "context.md")));

  const skillDoc = fs.readFileSync(path.join(skillRoot, "demo-skill", "SKILL.md"), "utf8");
  const openaiYaml = fs.readFileSync(path.join(skillRoot, "demo-skill", "agents", "openai.yaml"), "utf8");
  const helperScript = fs.readFileSync(path.join(skillRoot, "demo-skill", "scripts", "run.js"), "utf8");
  const description = normalizeAssetDescription("Generate a concise daily finance morning briefing for Feishu");

  assert.strictEqual(result.description, description);
  assert.match(skillDoc, /## Purpose/);
  assert.match(skillDoc, new RegExp(escapeRegExp(`- ${normalizeSkillType("bot")}`)));
  assert.match(skillDoc, /## When to use/);
  assert.match(skillDoc, /## Bundled Resources/);
  assert.match(skillDoc, /without bundled reference notes/i);
  assert.match(skillDoc, new RegExp(escapeRegExp(description)));
  assert.match(openaiYaml, /display_name:/);
  assert.match(openaiYaml, new RegExp(escapeRegExp(`short_description: ${toYamlScalar(description)}`)));
  assert.match(helperScript, /Starter helper/);
  console.log("skill scaffold ok");
}

function loadSkillHelpers() {
  const fsModule = require("fs");
  const pathModule = require("path");
  const toDisplayName = (pluginName) => String(pluginName || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const normalizeAssetName = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const start = source.indexOf("function parseAssetCreateRequest(");
  const end = source.indexOf("function formatAssetListText(", start);
  if (start < 0 || end < 0) {
    throw new Error("skill helper block not found");
  }
  const fnSource = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    "fs",
    "path",
    "toDisplayName",
    "normalizeAssetName",
    `${fnSource}; return { createCloudAssetScaffold, parseAssetCreateRequest, normalizeAssetDescription, normalizeSkillType, toYamlScalar };`
  )(
    fsModule,
    pathModule,
    toDisplayName,
    normalizeAssetName
  );
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();

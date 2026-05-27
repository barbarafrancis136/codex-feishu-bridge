#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ensureGithubPluginInstall,
  ensureMarketplaceEntry,
  ensurePluginManifest,
  ensurePluginSkeleton,
  listInstalledPlugins,
  listMarketplacePlugins,
  readPluginManifest,
} = require("../src/infra/plugins/plugin-registry");

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-registry-"));
  const pluginRoot = path.join(tempRoot, "plugins");
  const marketplacePath = path.join(tempRoot, ".agents", "plugins", "marketplace.json");

  const createResult = ensurePluginSkeleton({
    pluginRoot,
    pluginName: "demo",
    displayName: "Demo",
    description: "Demo plugin for Codex",
    force: true,
  });
  assert.strictEqual(createResult.ok, true);
  assert.strictEqual(readPluginManifest(path.join(pluginRoot, "demo")).name, "demo");

  const manifestResult = ensurePluginManifest({
    pluginPath: path.join(pluginRoot, "demo"),
    pluginName: "demo",
    displayName: "Demo",
    description: "Demo plugin for Codex",
    force: true,
  });
  assert.strictEqual(manifestResult.ok, true);

  const marketplaceResult = ensureMarketplaceEntry(marketplacePath, "demo");
  assert.strictEqual(marketplaceResult.ok, true);

  const githubResult = ensureGithubPluginInstall({
    pluginRoot,
    marketplacePath,
    force: true,
  });
  assert.strictEqual(githubResult.ok, true);
  assert.ok(fs.existsSync(path.join(pluginRoot, "github", ".codex-plugin", "plugin.json")));
  assert.ok(listInstalledPlugins(pluginRoot).includes("github"));
  assert.ok(listMarketplacePlugins(marketplacePath).some((item) => item.name === "github"));

  console.log("plugin registry ok");
}

main();

const fs = require("fs");
const path = require("path");

const DEFAULT_PLUGIN_VERSION = "0.1.0";
const DEFAULT_PLUGIN_CATEGORY = "Productivity";
const DEFAULT_MARKETPLACE_NAME = "codex-local";
const DEFAULT_MARKETPLACE_DISPLAY_NAME = "Codex Plugins";

function normalizePluginName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function validatePluginName(pluginName) {
  if (!pluginName) {
    throw new Error("Plugin name must include at least one letter or digit.");
  }
  if (pluginName.length > 64) {
    throw new Error(`Plugin name '${pluginName}' is too long.`);
  }
}

function toDisplayName(pluginName) {
  return String(pluginName || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload, { force = false } = {}) {
  if (fs.existsSync(filePath) && !force) {
    return false;
  }
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return true;
}

function writeText(filePath, content, { force = false } = {}) {
  if (fs.existsSync(filePath) && !force) {
    return false;
  }
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
  return true;
}

function buildPluginManifest({
  pluginName,
  displayName = toDisplayName(pluginName),
  description = `${displayName} plugin for Codex`,
  installSource = "local",
  existingManifest = null,
}) {
  const manifest = isPlainObject(existingManifest) ? { ...existingManifest } : {};
  const interfaceBlock = isPlainObject(manifest.interface) ? { ...manifest.interface } : {};
  return {
    ...manifest,
    name: pluginName,
    version: String(manifest.version || DEFAULT_PLUGIN_VERSION),
    description: String(manifest.description || description),
    enabled: manifest.enabled !== false,
    install_source: String(manifest.install_source || installSource),
    skills: String(manifest.skills || "./skills/"),
    tools: String(manifest.tools || "./tools/"),
    mcpServers: String(manifest.mcpServers || "./.mcp.json"),
    apps: String(manifest.apps || "./.app.json"),
    interface: {
      ...interfaceBlock,
      displayName: String(interfaceBlock.displayName || displayName),
      shortDescription: String(interfaceBlock.shortDescription || description),
      longDescription: String(interfaceBlock.longDescription || description),
      developerName: String(interfaceBlock.developerName || "Codex"),
      category: String(interfaceBlock.category || DEFAULT_PLUGIN_CATEGORY),
    },
  };
}

function ensurePluginManifest({
  pluginPath,
  pluginName,
  displayName,
  description,
  installSource = "local",
  force = false,
}) {
  if (!pluginPath) {
    return {
      ok: false,
      created: false,
      errorText: "Plugin path is not configured.",
    };
  }

  const manifestPath = path.join(path.resolve(pluginPath), ".codex-plugin", "plugin.json");
  const existingManifest = readJsonIfExists(manifestPath);
  const manifest = buildPluginManifest({
    pluginName,
    displayName,
    description,
    installSource,
    existingManifest,
  });
  const wasWritten = writeJson(manifestPath, manifest, { force: true });
  return {
    ok: true,
    created: !existingManifest,
    updated: Boolean(existingManifest) && wasWritten,
    manifestPath,
    manifest,
  };
}

function buildMarketplaceRoot() {
  return {
    name: DEFAULT_MARKETPLACE_NAME,
    interface: {
      displayName: DEFAULT_MARKETPLACE_DISPLAY_NAME,
    },
    plugins: [],
  };
}

function buildMarketplaceEntry(pluginName, { category = DEFAULT_PLUGIN_CATEGORY } = {}) {
  return {
    name: pluginName,
    source: {
      source: "local",
      path: `./plugins/${pluginName}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category,
  };
}

function ensureMarketplaceEntry(marketplacePath, pluginName, options = {}) {
  const normalizedMarketplacePath = String(marketplacePath || "").trim();
  if (!normalizedMarketplacePath) {
    return {
      ok: false,
      created: false,
      replaced: false,
      errorText: "Marketplace path is not configured.",
    };
  }

  const marketplaceFile = path.resolve(normalizedMarketplacePath);
  const existing = readJsonIfExists(marketplaceFile);
  const payload = existing && typeof existing === "object" ? existing : buildMarketplaceRoot();
  if (!payload.interface || typeof payload.interface !== "object") {
    payload.interface = { displayName: DEFAULT_MARKETPLACE_DISPLAY_NAME };
  } else if (!String(payload.interface.displayName || "").trim()) {
    payload.interface.displayName = DEFAULT_MARKETPLACE_DISPLAY_NAME;
  }
  if (!Array.isArray(payload.plugins)) {
    payload.plugins = [];
  }

  const entry = buildMarketplaceEntry(pluginName, options);
  const index = payload.plugins.findIndex((item) => item && item.name === pluginName);
  let replaced = false;
  if (index >= 0) {
    const currentEntry = payload.plugins[index];
    const currentEntryText = JSON.stringify(currentEntry);
    const nextEntryText = JSON.stringify(entry);
    replaced = currentEntryText !== nextEntryText;
    payload.plugins[index] = entry;
  } else {
    payload.plugins.push(entry);
  }

  writeJson(marketplaceFile, payload, { force: true });
  return {
    ok: true,
    created: !existing,
    replaced,
    path: marketplaceFile,
  };
}

function ensurePluginSkeleton({
  pluginRoot,
  pluginName,
  displayName,
  description,
  installSource = "local",
  force = false,
}) {
  if (!pluginRoot) {
    return {
      ok: false,
      created: false,
      errorText: "Plugin root is not configured.",
    };
  }

  validatePluginName(pluginName);

  const pluginPath = path.resolve(pluginRoot, pluginName);
  ensureDirectory(pluginPath);
  ensureDirectory(path.join(pluginPath, ".codex-plugin"));
  ensureDirectory(path.join(pluginPath, "skills"));
  ensureDirectory(path.join(pluginPath, "tools"));
  ensureDirectory(path.join(pluginPath, "assets"));

  const manifestResult = ensurePluginManifest({
    pluginPath,
    pluginName,
    displayName,
    description,
    installSource,
    force,
  });
  const manifestPath = manifestResult.manifestPath;

  const skillDocPath = path.join(pluginPath, "skills", pluginName, "SKILL.md");
  writeText(
    skillDocPath,
    [
      "---",
      `name: ${pluginName}`,
      `description: ${description}`,
      "---",
      "",
      `# ${displayName}`,
      "",
      description,
      "",
    ].join("\n"),
    { force }
  );

  writeText(
    path.join(pluginPath, "tools", "README.md"),
    `# ${displayName} tools\n\nPlaceholder tools folder for ${displayName}.\n`,
    { force }
  );

  writeJson(path.join(pluginPath, ".mcp.json"), { mcpServers: {} }, { force });
  writeJson(path.join(pluginPath, ".app.json"), { apps: {} }, { force });

  return {
    ok: true,
    created: Boolean(manifestResult.created),
    pluginPath,
    manifestPath,
    manifest: manifestResult.manifest,
  };
}

function ensureGithubPluginInstall({
  pluginRoot,
  marketplacePath,
  force = false,
}) {
  const pluginName = "github";
  const displayName = "GitHub";
  const description = "GitHub plugin for Codex";
  const scaffold = ensurePluginSkeleton({
    pluginRoot,
    pluginName,
    displayName,
    description,
    installSource: "github",
    force,
  });
  if (!scaffold.ok) {
    return scaffold;
  }

  const marketplace = ensureMarketplaceEntry(marketplacePath, pluginName, {
    category: DEFAULT_PLUGIN_CATEGORY,
  });
  return {
    ok: true,
    created: scaffold.created,
    pluginPath: scaffold.pluginPath,
    manifestPath: scaffold.manifestPath,
    marketplacePath: marketplace.path,
    marketplaceReplaced: marketplace.replaced,
  };
}

function listInstalledPlugins(pluginRoot) {
  if (!pluginRoot) {
    return [];
  }

  try {
    return fs
      .readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        const manifestPath = path.join(pluginRoot, name, ".codex-plugin", "plugin.json");
        return fs.existsSync(manifestPath);
      })
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function readPluginManifest(pluginPath) {
  if (!pluginPath) {
    return null;
  }
  const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
  return readJsonIfExists(manifestPath);
}

function readMarketplace(marketplacePath) {
  if (!marketplacePath) {
    return null;
  }
  return readJsonIfExists(path.resolve(marketplacePath));
}

function listMarketplacePlugins(marketplacePath) {
  const marketplace = readMarketplace(marketplacePath);
  if (!marketplace || !Array.isArray(marketplace.plugins)) {
    return [];
  }
  return marketplace.plugins
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      name: String(entry.name || "").trim(),
      sourcePath: String(entry?.source?.path || "").trim(),
      installation: String(entry?.policy?.installation || "").trim(),
      authentication: String(entry?.policy?.authentication || "").trim(),
      category: String(entry?.category || "").trim(),
    }))
    .filter((entry) => entry.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function describePluginInstall({
  pluginPath,
  manifestPath,
  marketplacePath,
  pluginName,
}) {
  const manifest = readPluginManifest(pluginPath);
  const marketplace = readMarketplace(marketplacePath);
  const marketplaceEntry = Array.isArray(marketplace?.plugins)
    ? marketplace.plugins.find((entry) => entry && entry.name === pluginName)
    : null;

  return {
    pluginName,
    pluginPath,
    manifestPath,
    manifest,
    marketplacePath,
    marketplaceEntry,
    installed: Boolean(manifest),
    marketplaceLinked: Boolean(marketplaceEntry),
  };
}

function isPluginInstalled(pluginRoot, pluginName) {
  const normalizedPluginName = normalizePluginName(pluginName);
  if (!pluginRoot || !normalizedPluginName) {
    return false;
  }
  const manifestPath = path.join(pluginRoot, normalizedPluginName, ".codex-plugin", "plugin.json");
  return fs.existsSync(manifestPath);
}

module.exports = {
  buildMarketplaceEntry,
  buildPluginManifest,
  ensureGithubPluginInstall,
  ensureMarketplaceEntry,
  ensurePluginManifest,
  ensurePluginSkeleton,
  describePluginInstall,
  isPluginInstalled,
  listInstalledPlugins,
  listMarketplacePlugins,
  normalizePluginName,
  readPluginManifest,
  readMarketplace,
  toDisplayName,
  validatePluginName,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

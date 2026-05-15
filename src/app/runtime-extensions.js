const path = require("path");

const emptyCodexProfiles = Object.freeze({
  displayNames: Object.freeze({}),
  profiles: Object.freeze({}),
  beforeSwitchCodexAppServerProfile: async () => {},
  getProfileHelpLines: () => [],
  getProfileNote: () => "",
});

const emptyHooks = Object.freeze({
  beforeMessage: async ({ normalized }) => normalized,
  afterCodexReply: async ({ text }) => text,
  onApprovalRequest: async () => {},
  onUsageUpdate: async () => {},
});

function loadRuntimeExtensions() {
  const externalPathRaw = String(process.env.CODEX_IM_EXTENSIONS_FILE || "").trim();
  if (!externalPathRaw) {
    return {
      codexProfiles: emptyCodexProfiles,
      hooks: emptyHooks,
    };
  }

  const externalPath = path.resolve(externalPathRaw);
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const custom = require(externalPath) || {};
    return {
      codexProfiles: mergeCodexProfiles(custom.codexProfiles),
      hooks: mergeHooks(custom.hooks),
    };
  } catch (error) {
    console.error(`[codex-im] failed to load extensions file ${externalPath}: ${error.message}`);
    return {
      codexProfiles: emptyCodexProfiles,
      hooks: emptyHooks,
    };
  }
}

function mergeCodexProfiles(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    displayNames: freezeObject(input.displayNames),
    profiles: freezeObject(input.profiles),
    beforeSwitchCodexAppServerProfile: asFunction(input.beforeSwitchCodexAppServerProfile, emptyCodexProfiles.beforeSwitchCodexAppServerProfile),
    getProfileHelpLines: asFunction(input.getProfileHelpLines, emptyCodexProfiles.getProfileHelpLines),
    getProfileNote: asFunction(input.getProfileNote, emptyCodexProfiles.getProfileNote),
  };
}

function mergeHooks(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    beforeMessage: asFunction(input.beforeMessage, emptyHooks.beforeMessage),
    afterCodexReply: asFunction(input.afterCodexReply, emptyHooks.afterCodexReply),
    onApprovalRequest: asFunction(input.onApprovalRequest, emptyHooks.onApprovalRequest),
    onUsageUpdate: asFunction(input.onUsageUpdate, emptyHooks.onUsageUpdate),
  };
}

function freezeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }
  return Object.freeze({ ...value });
}

function asFunction(value, fallback) {
  return typeof value === "function" ? value : fallback;
}

module.exports = {
  ...loadRuntimeExtensions(),
};

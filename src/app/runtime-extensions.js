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

module.exports = {
  codexProfiles: emptyCodexProfiles,
  hooks: emptyHooks,
};

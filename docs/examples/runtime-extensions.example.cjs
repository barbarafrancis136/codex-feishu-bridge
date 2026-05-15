module.exports = {
  codexProfiles: {
    displayNames: {
      main: "main",
    },
    profiles: {
      main: "",
    },
    beforeSwitchCodexAppServerProfile: async () => {},
    getProfileHelpLines: () => [],
    getProfileNote: () => "",
  },
  hooks: {
    beforeMessage: async ({ normalized }) => normalized,
    afterCodexReply: async ({ text }) => text,
    onApprovalRequest: async ({ threadId, approval }) => {
      void threadId;
      void approval;
    },
    onUsageUpdate: async ({ threadId, usage }) => {
      void threadId;
      void usage;
    },
  },
};

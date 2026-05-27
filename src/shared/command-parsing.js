function extractBindPath(text) {
  return extractCommandArgument(text, "/codex bind ");
}

function extractSwitchThreadId(text) {
  return extractCommandArgument(text, "/codex switch ");
}

function extractRemoveWorkspacePath(text) {
  return extractCommandArgument(text, "/codex remove ");
}

function extractSendPath(text) {
  return extractCommandArgument(text, "/codex send ");
}

function extractModelValue(text) {
  return extractCommandArgument(text, "/codex model ");
}

function extractEffortValue(text) {
  return extractCommandArgument(text, "/codex effort ");
}

function extractProfileValue(text) {
  return extractCommandArgument(text, "/codex profile ");
}

function extractAccessValue(text) {
  return extractCommandArgument(text, "/codex access ");
}

function extractSkillValue(text) {
  return extractCommandArgument(text, "/codex skill ");
}

function extractPluginValue(text) {
  return extractCommandArgument(text, "/codex plugin ") || extractCommandArgument(text, "/codexplugin");
}

function extractPluginInstallValue(text) {
  return extractCommandArgument(text, "/codex plugin install ") || extractCommandArgument(text, "/codexplugininstall");
}

function extractPluginManifestValue(text) {
  return extractCommandArgument(text, "/codex plugin manifest ") || extractCommandArgument(text, "/codexpluginmanifest");
}

function extractPluginMarketplaceValue(text) {
  return extractCommandArgument(text, "/codex plugin marketplace ") || extractCommandArgument(text, "/codexpluginmarketplace");
}

function extractScoreValue(text) {
  return extractCommandArgument(text, "/codex score ");
}

function extractEvalValue(text) {
  return extractCommandArgument(text, "/codex eval ");
}

function extractGoalValue(text) {
  return extractCommandArgument(text, "/goal ");
}

function extractAppointmentValue(text) {
  const trimmed = String(text || "").trim();
  if (trimmed === "/预约" || trimmed.toLowerCase() === "/appoint") {
    return "";
  }
  return extractCommandArgument(text, "/预约 ")
    || extractCommandArgument(text, "/appoint ");
}

function extractCommandArgument(text, prefix) {
  const trimmed = String(text || "").trim();
  const normalizedPrefix = String(prefix || "").toLowerCase();
  if (trimmed.toLowerCase().startsWith(normalizedPrefix)) {
    return trimmed.slice(normalizedPrefix.length).trim();
  }
  return "";
}

module.exports = {
  extractAccessValue,
  extractAppointmentValue,
  extractBindPath,
  extractEffortValue,
  extractGoalValue,
  extractModelValue,
  extractPluginValue,
  extractPluginInstallValue,
  extractPluginManifestValue,
  extractPluginMarketplaceValue,
  extractProfileValue,
  extractScoreValue,
  extractRemoveWorkspacePath,
  extractSendPath,
  extractSkillValue,
  extractSwitchThreadId,
  extractEvalValue,
};

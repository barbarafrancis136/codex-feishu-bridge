const fs = require("fs");
const path = require("path");

const SKILL_NAME = "morning-briefing";

function ensureMorningBriefingSkill(skillRoot) {
  const root = String(skillRoot || "").trim();
  if (!root) {
    return null;
  }

  const skillDir = path.join(root, SKILL_NAME);
  const agentsDir = path.join(skillDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  const skillDocPath = path.join(skillDir, "SKILL.md");
  const openaiYamlPath = path.join(agentsDir, "openai.yaml");

  if (!fs.existsSync(skillDocPath)) {
    fs.writeFileSync(
      skillDocPath,
      [
        "---",
        `name: ${SKILL_NAME}`,
        "description: Generate and refine a concise daily morning briefing for Feishu delivery.",
        "---",
        "",
        "# Morning Briefing",
        "",
        "Use this skill when preparing a daily morning briefing for Feishu.",
        "",
        "## Workflow",
        "",
        "1. Keep the report concise and easy to scan on mobile.",
        "2. Start with one sentence for the overall conclusion.",
        "3. Use four generic sections by default:",
        "   - 今日概览",
        "   - 重点事项",
        "   - 待确认信息",
        "   - 下一步建议",
        "4. End with a short 风险提示.",
        "5. Put finance, industry, team, or personal formats in CODEX_IM_MORNING_BRIEFING_PROMPT_FILE instead of changing the public default.",
        "6. If live data is unavailable, say so clearly and produce a structured template version instead of fabricating figures.",
        "",
      ].join("\n"),
      "utf8"
    );
  }

  if (!fs.existsSync(openaiYamlPath)) {
    fs.writeFileSync(
      openaiYamlPath,
      [
        "interface:",
        "  display_name: Morning Briefing",
        "  short_description: Prepare a daily morning briefing for Feishu.",
        "  default_prompt: Generate a concise Chinese morning briefing with one-line conclusion, generic sections, and a short risk note.",
        "",
      ].join("\n"),
      "utf8"
    );
  }

  return {
    skillDir,
    skillDocPath,
    openaiYamlPath,
  };
}

module.exports = {
  SKILL_NAME,
  ensureMorningBriefingSkill,
};

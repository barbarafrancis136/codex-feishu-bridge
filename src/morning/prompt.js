const fs = require("fs");
const path = require("path");

const DEFAULT_PROMPT = [
  "你现在要生成一份适合飞书直接阅读的中文晨报。",
  "",
  "任务要求：",
  "1. 输出必须简洁、可信、便于早上快速浏览。",
  "2. 优先使用标题、短段落、有序列表。",
  "3. 优先使用当前日期可获得的最新公开信息；如工具可用，请主动检索当天相关资料后再写。",
  "4. 如果事实不确定，明确写‘待确认’或‘需要复核’。",
  "5. 不要编造实时数据；如果缺少外部数据，就明确写成‘待补数模板版晨报’。",
  "6. 默认固定输出 4 个通用模块：",
  "   - 今日概览",
  "   - 重点事项",
  "   - 待确认信息",
  "   - 下一步建议",
  "7. 在 4 个模块之前，先给出‘今日一句话结论’。",
  "8. 最后附一段‘风险提示’。",
  "9. 如果需要财经、行业、团队或个人化模块，请通过 CODEX_IM_MORNING_BRIEFING_PROMPT_FILE 提供外部 prompt，不要改默认模板。",
  "10. 如果当天缺少可靠数据，就清楚标注哪些模块是待补数，不要用猜测填满。",
  "",
  "固定输出格式：",
  "- 标题使用：# 今日晨报",
  "- 标题下一行写：日期：YYYY-MM-DD",
  "- 然后输出：## 今日一句话结论",
  "- 然后依次输出：",
  "  - ## 今日概览",
  "  - ## 重点事项",
  "  - ## 待确认信息",
  "  - ## 下一步建议",
  "  - ## 风险提示",
  "- 每个模块 3 到 5 条要点。",
  "- ‘下一步建议’要把当天信息抽象成 1 到 3 条可执行动作，不要只复述信息。",
  "- 全文适合直接发送到飞书卡片，不要输出多余前言。",
].join("\n");

function resolveMorningBriefingPrompt(config = {}) {
  const promptFile = String(config.morningBriefingPromptFile || "").trim();
  if (!promptFile) {
    return DEFAULT_PROMPT;
  }

  const resolvedPath = path.resolve(promptFile);
  try {
    const value = fs.readFileSync(resolvedPath, "utf8").trim();
    return value || DEFAULT_PROMPT;
  } catch {
    return DEFAULT_PROMPT;
  }
}

module.exports = {
  DEFAULT_PROMPT,
  resolveMorningBriefingPrompt,
};

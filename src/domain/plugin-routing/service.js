const { createLogger } = require("../../shared/logger");

const logger = createLogger("plugin-routing");

const MIN_ROUTE_SCORE = 2;
const AMBIGUOUS_SCORE_GAP = 1;

const PLUGIN_INTENTS = Object.freeze([
  {
    pluginId: "notion",
    displayName: "Notion",
    categoryLabel: "文档整理",
    aliases: ["notion"],
    highSignals: ["会议纪要", "需求文档", "任务清单", "知识卡片", "知识库", "执行任务"],
    actionWords: ["整理", "总结", "沉淀", "归纳", "梳理", "拆成", "拆分"],
    artifactWords: ["需求", "纪要", "文档", "任务", "知识", "方案", "待办", "负责人"],
    prompts: [
      "把这段聊天整理成需求文档",
      "把今天讨论整理成会议纪要",
      "根据这段目标拆成执行任务",
    ],
    fallbackLine: "如果你只是想先在飞书里拿到摘要，我也可以先整理一版。",
  },
  {
    pluginId: "figma",
    displayName: "Figma",
    categoryLabel: "设计分析",
    aliases: ["figma"],
    highSignals: [
      "设计稿",
      "设计图",
      "设计链接",
      "页面差异",
      "设计还原",
      "版式",
      "组件映射",
      "设计实现",
      "对照设计",
    ],
    actionWords: ["看", "检查", "对照", "拆成", "实现", "分析"],
    artifactWords: ["ui", "视觉", "页面", "组件", "样式", "布局"],
    prompts: [
      "帮我看这个设计稿的重点",
      "对照设计稿检查当前页面差异",
      "把这个页面拆成开发任务",
    ],
    fallbackLine: "如果你先给我设计链接，我可以先按这个方向帮你拆分析框架。",
  },
  {
    pluginId: "semrush",
    displayName: "Semrush",
    categoryLabel: "搜索流量分析",
    aliases: ["semrush"],
    highSignals: ["seo", "关键词", "搜索流量", "自然流量", "搜索表现", "搜索排名", "竞品词", "域名seo"],
    actionWords: ["查", "分析", "对比", "看看", "评估"],
    artifactWords: ["流量", "排名", "搜索", "域名"],
    prompts: [
      "帮我查这个关键词值不值得做",
      "看这个域名的 SEO 情况",
      "对比这两个竞品的搜索表现",
    ],
    fallbackLine: "当前链路还没验通实时数据，我可以先给你一版关键词和 SEO 分析框架。",
  },
  {
    pluginId: "particl-market-research",
    displayName: "Particl Market Research",
    categoryLabel: "电商竞品研究",
    aliases: ["particl", "particl market research"],
    highSignals: ["竞品", "品类", "市场机会", "电商趋势", "卖点", "价格带", "产品方向", "品类趋势"],
    actionWords: ["看", "对比", "提炼", "分析", "判断"],
    artifactWords: ["市场", "电商", "趋势", "机会"],
    prompts: [
      "帮我看这个品类最近趋势",
      "对比这几个竞品的卖点",
      "这个产品方向值不值得做",
    ],
    fallbackLine: "当前链路还没验通实时市场数据，我可以先给你竞品研究提纲。",
  },
  {
    pluginId: "zhihu",
    displayName: "Zhihu",
    categoryLabel: "内容素材研究",
    aliases: ["zhihu", "知乎"],
    highSignals: [
      "知乎搜索",
      "全网搜索",
      "热榜",
      "热点",
      "直答",
      "知乎 api",
      "知乎 mcp",
      "知乎 skill",
      "developer.zhihu.com",
      "自媒体素材",
      "创作者素材",
    ],
    actionWords: ["查", "搜索", "获取", "分析", "整理", "提炼", "追踪"],
    artifactWords: ["知乎", "热榜", "热点", "回答", "问题", "文章", "素材", "选题", "内容"],
    prompts: [
      "用知乎热榜给我整理今天的选题素材",
      "用知乎搜索这个关键词的高赞问题和回答",
      "用知乎直答帮我提炼这个话题的观点",
    ],
    fallbackLine: "当前实例还没配置知乎开发者 Token；我可以先基于转发内容整理接入清单和选题框架。",
  },
]);

function handlePotentialPluginIntentMessage(runtime, normalized) {
  if (normalized?.command !== "message" || !normalized?.chatId) {
    return Promise.resolve(normalized);
  }

  const route = detectFirstBatchPluginIntent(normalized.text, resolveRoutingHints(runtime));
  if (!route) {
    return Promise.resolve(normalized);
  }

  logger.info("first batch plugin route detected", {
    kind: route.kind,
    pluginId: route.pluginId || "",
    messageId: normalized.messageId || "",
  });

  if (typeof runtime.sendPluginRouteCardMessage === "function") {
    return runtime.sendPluginRouteCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      route,
    }).then(() => null);
  }

  return runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: route.kind === "ambiguous"
      ? buildAmbiguousPluginRouteText(route)
      : buildPluginRouteText(route),
  }).then(() => null);
}

function detectFirstBatchPluginIntent(text, hints = {}) {
  const sourceText = normalizeSourceText(text);
  if (!sourceText) {
    return null;
  }
  const minRouteScore = normalizePositiveNumber(hints.minRouteScore, MIN_ROUTE_SCORE);
  const ambiguousScoreGap = normalizePositiveNumber(hints.ambiguousScoreGap, AMBIGUOUS_SCORE_GAP);

  const matches = PLUGIN_INTENTS
    .map((definition) => scorePluginIntent(definition, sourceText))
    .filter((item) => item.score >= minRouteScore)
    .sort((left, right) => right.score - left.score);

  if (!matches.length) {
    return null;
  }

  const top = matches[0];
  const next = matches[1];
  if (next && top.score - next.score <= ambiguousScoreGap) {
    return {
      kind: "ambiguous",
      candidates: [top, next].map((item) => ({
        pluginId: item.pluginId,
        displayName: item.displayName,
        categoryLabel: item.categoryLabel,
        prompt: item.prompts?.[0] || "",
      })),
    };
  }

  return {
    kind: "plugin",
    pluginId: top.pluginId,
    displayName: top.displayName,
    categoryLabel: top.categoryLabel,
    reasons: top.reasons,
    prompts: top.prompts,
    fallbackLine: top.fallbackLine,
  };
}

function scorePluginIntent(definition, sourceText) {
  let score = 0;
  const reasons = [];

  const alias = definition.aliases.find((item) => sourceText.includes(item));
  if (alias) {
    score += 4;
    reasons.push(`我直接识别到了 ${definition.displayName} 相关词。`);
  }

  const matchedSignals = definition.highSignals.filter((item) => sourceText.includes(item.toLowerCase()));
  if (matchedSignals.length) {
    score += Math.min(4, matchedSignals.length * 2);
    reasons.push(`你提到了 ${matchedSignals.slice(0, 3).join("、")} 这类高信号词。`);
  }

  const matchedActionWords = definition.actionWords.filter((item) => sourceText.includes(item.toLowerCase()));
  const matchedArtifactWords = definition.artifactWords.filter((item) => sourceText.includes(item.toLowerCase()));
  if (matchedActionWords.length && matchedArtifactWords.length) {
    score += 2;
    reasons.push(`这条消息同时带有“${matchedActionWords[0]}”和“${matchedArtifactWords[0]}”这类组合信号。`);
  }

  return {
    pluginId: definition.pluginId,
    displayName: definition.displayName,
    categoryLabel: definition.categoryLabel,
    prompts: definition.prompts,
    fallbackLine: definition.fallbackLine,
    score,
    reasons,
  };
}

function buildPluginRouteText(route) {
  return [
    `**插件建议：${route.displayName}**`,
    "",
    "结论：",
    `这条消息更适合先走 ${route.displayName} 的${route.categoryLabel}能力。`,
    "",
    "关键发现：",
    ...route.reasons.map((item) => `- ${item}`),
    "- 当前实例已经能本地识别这条路由，但还没完成真实插件链路验通。",
    "",
    "下一步建议：",
    ...route.prompts.map((item) => `- ${item}`),
    `- ${route.fallbackLine}`,
  ].join("\n");
}

function buildAmbiguousPluginRouteText(route) {
  return [
    "**插件分流建议**",
    "",
    "结论：",
    "这条消息像是在调用插件能力，但方向还不够单一。",
    "",
    "关键发现：",
    `- 我同时识别到了 ${route.candidates.map((item) => item.displayName).join(" 和 ")} 的信号。`,
    "- 现在更适合先把方向收窄，再决定走哪条插件链路。",
    "- 当前实例会先做本地分流，不把它说成已验通的实时插件结果。",
    "",
    "下一步建议：",
    "- 文档整理：把这段聊天整理成需求文档",
    "- 设计分析：帮我看这个设计稿的重点",
    "- 搜索流量：帮我查这个关键词值不值得做",
    "- 电商竞品：帮我看这个品类最近趋势",
    "- 内容素材：用知乎热榜给我整理今天的选题素材",
  ].join("\n");
}

function normalizeSourceText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveRoutingHints(runtime) {
  const resolver = runtime?.capabilities?.getRoutingHints
    || runtime?.optimizationManager?.getRoutingHints;
  if (typeof resolver !== "function") {
    return {};
  }
  try {
    return resolver.call(runtime.capabilities || runtime.optimizationManager) || {};
  } catch (error) {
    logger.warn("failed to read optimization routing hints", { error });
    return {};
  }
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

module.exports = {
  buildAmbiguousPluginRouteText,
  buildPluginRouteText,
  detectFirstBatchPluginIntent,
  handlePotentialPluginIntentMessage,
};

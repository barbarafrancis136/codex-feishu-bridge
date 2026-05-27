# Plugin First Batch Playbook

This document defines the first plugin batch that is most worth wiring into the Feishu bot workflow.

It is intentionally product-facing rather than implementation-heavy. The goal is to help the bridge route common Feishu messages into the right plugin-backed workflow with clear user expectations.

## Scope

First batch:

- `notion`
- `figma`
- `semrush`
- `particl-market-research`
- `zhihu`

Why this batch:

- `notion` fits daily Feishu collaboration immediately.
- `figma` turns design discussion into actionable implementation work.
- `semrush` adds keyword and traffic judgment.
- `particl-market-research` adds ecommerce and competitor research.
- `zhihu` adds creator-material research through Zhihu search, hotlist, and answer-style workflows once authenticated.

## Product Rule

For this bridge, "supported" should continue to mean:

- the plugin is visible to the runtime
- the bridge can recognize the user intent
- the bot can route the request into a stable response shape
- the capability is verified on the real Feishu bot instance

Until a plugin is runtime-verified, the bot should describe it as:

- available for routing
- not yet fully verified end to end

## Default Response Shape

All first-batch plugin responses should prefer the same three-part structure:

1. `一句结论`
2. `3-5 条关键发现`
3. `下一步建议`

This keeps Feishu replies short, scannable, and consistent across plugins.

Example shape:

```text
结论：
这段讨论已经可以整理成需求草案。

关键发现：
- 目标已经明确
- 范围基本完整
- 还缺优先级和验收标准

下一步建议：
- 是否生成任务清单
```

## Routing Order

When multiple plugins appear relevant, prefer this order:

1. `notion`
2. `figma`
3. `semrush`
4. `particl-market-research`
5. `zhihu`

Reasoning:

- Feishu conversation first tends to produce internal notes, decisions, and tasks.
- Design follow-up is the next most common workflow.
- SEO and market research are usually analyst follow-ups rather than the first action.
- Zhihu is best used when the user asks for Chinese content topics, creator material, platform hot topics, or Zhihu-specific search/answer workflows.

## Plugin Profiles

### 1. Notion

Primary role:

- organize requirements
- organize meeting notes
- split discussion into tasks
- save knowledge into a durable page

Typical user asks:

- `把这段聊天整理成需求文档`
- `把今天讨论整理成会议纪要`
- `根据这段目标拆成执行任务`
- `把这份资料沉淀成知识卡片`
- `帮我总结这次讨论的结论、待办、负责人`

Intent keywords:

- `整理`
- `纪要`
- `总结`
- `任务`
- `知识库`
- `文档`
- `需求`
- `方案`

Routing guidance:

- Prefer `notion` when the user wants structure from messy conversation.
- Prefer `notion` when the output should become a document, plan, or task list.
- If the user only wants a quick summary in chat, the bridge can answer locally first and offer Notion as the next step.

Suggested reply card:

- Title: `Notion 整理结果`
- Fields:
  - `结论`
  - `关键点`
  - `待办`
  - `负责人`
  - `下一步`

Fallback copy:

- `我识别到你想整理成文档/纪要，但当前 Notion 链路还没有完成运行期验证。我先在飞书里给你整理摘要，需要的话再继续补成正式结构。`

### 2. Figma

Primary role:

- inspect design context
- compare implementation against design
- convert design intent into implementation work
- support design-to-code follow-up

Typical user asks:

- `帮我看这个设计稿的重点`
- `把这个页面拆成开发任务`
- `对照设计稿检查当前页面差异`
- `给我一份设计实现说明`
- `看看这个版式有哪些明显问题`

Intent keywords:

- `设计稿`
- `版式`
- `页面差异`
- `UI`
- `视觉`
- `对照`
- `还原`
- `组件`
- `页面`

Routing guidance:

- Prefer `figma` when the user references a frame, page, component, style, or parity check.
- Prefer `figma` when the user is asking for implementation guidance from design.
- If no Figma link or design reference is present, ask for the design source instead of guessing.

Suggested reply card:

- Title: `Figma 设计分析`
- Fields:
  - `结论`
  - `主要差异`
  - `实现建议`
  - `风险点`
  - `下一步`

Fallback copy:

- `我识别到你想做设计稿分析或设计到代码，但当前 Figma 链路还没有完成运行期验证。你可以先给我设计链接，我先按规则帮你拆分析框架。`

### 3. Semrush

Primary role:

- keyword opportunity review
- traffic and SEO visibility review
- competitor search comparison

Typical user asks:

- `帮我查这个关键词值不值得做`
- `看这个域名的 SEO 情况`
- `对比这两个竞品的搜索表现`
- `给我一份关键词优先级建议`
- `看看这个页面的流量机会点`

Intent keywords:

- `关键词`
- `流量`
- `SEO`
- `搜索`
- `排名`
- `自然流量`
- `竞品词`
- `域名`

Routing guidance:

- Prefer `semrush` when the user is asking about search performance rather than product-market fit.
- Prefer `semrush` when the user gives a domain, page, keyword set, or SEO objective.
- If the request is broad market analysis rather than search analysis, prefer `particl-market-research`.

Suggested reply card:

- Title: `Semrush 搜索分析`
- Fields:
  - `结论`
  - `机会词`
  - `竞争情况`
  - `风险点`
  - `下一步`

Fallback copy:

- `我识别到你想看关键词或 SEO 数据，但当前 Semrush 链路还没有完成运行期验证。我可以先给你一版分析框架，等链路验证后再补实时数据。`

### 4. Particl Market Research

Primary role:

- ecommerce trend review
- competitor product and selling-point comparison
- market opportunity judgment

Typical user asks:

- `帮我看这个品类最近趋势`
- `对比这几个竞品的卖点`
- `这个产品方向值不值得做`
- `帮我提炼市场机会点`
- `看看竞品都在怎么卖`

Intent keywords:

- `竞品`
- `品类`
- `市场`
- `电商`
- `趋势`
- `卖点`
- `产品方向`
- `价格带`

Routing guidance:

- Prefer `particl-market-research` when the user wants market or ecommerce evidence.
- Prefer it when the user asks whether a product direction is worth doing.
- If the question is specifically about search keywords or SEO ranking, prefer `semrush` instead.

Suggested reply card:

- Title: `Particl 市场分析`
- Fields:
  - `结论`
  - `市场发现`
  - `竞品卖点`
  - `机会点`
  - `下一步`

Fallback copy:

- `我识别到你想看竞品或品类趋势，但当前 Particl Market Research 链路还没有完成运行期验证。我可以先给你研究提纲，后续再接实时市场数据。`

### 5. Zhihu

Primary role:

- creator-material research
- Zhihu question, answer, and article search
- hotlist and topic tracking
- answer-style synthesis once API/MCP auth is configured

Typical user asks:

- `用知乎热榜给我整理今天的选题素材`
- `用知乎搜索这个关键词的高赞问题和回答`
- `用知乎直答帮我提炼这个话题的观点`
- `帮我看知乎上这个话题有什么争议点`
- `把这条知乎 MCP 消息落成可用方案`

Intent keywords:

- `知乎`
- `知乎搜索`
- `全网搜索`
- `热榜`
- `热点`
- `直答`
- `知乎 API`
- `知乎 MCP`
- `知乎 Skill`
- `developer.zhihu.com`
- `自媒体素材`
- `选题`

Routing guidance:

- Prefer `zhihu` when the user explicitly mentions Zhihu, Zhihu Developer, Zhihu API/MCP/Skill, or Zhihu hotlist/search.
- Prefer it when the user wants Chinese creator topics, public Q&A material, or platform-native opinion synthesis.
- If the request is generic SEO traffic, prefer `semrush`.
- If the request is ecommerce market evidence, prefer `particl-market-research`.

Suggested reply card:

- Title: `Zhihu 内容素材分析`
- Fields:
  - `结论`
  - `可用能力`
  - `需要凭证`
  - `接入方式`
  - `下一步`

Fallback copy:

- `我识别到你想走知乎内容素材链路，但当前实例还没有配置知乎开发者 Token。我可以先基于转发内容整理接入清单和选题框架，不把它说成已验通的实时结果。`

## Intent Disambiguation

Use these rules before routing:

### Route to Notion when

- the user wants structure from conversation
- the user wants notes, tasks, plans, or documentation
- the core question is internal organization

### Route to Figma when

- the user mentions design, layout, component, parity, or implementation-from-design
- the message contains a design link or design review language

### Route to Semrush when

- the user mentions keywords, traffic, search ranking, domain SEO, or search opportunity

### Route to Particl when

- the user mentions product category, competitors, ecommerce trend, selling points, or market direction

### Route to Zhihu when

- the user mentions Zhihu, Zhihu Developer, Zhihu API/MCP/Skill, hotlist, questions, answers, or creator material
- the user wants Chinese content topics, public Q&A material, or Zhihu-style answer synthesis

### If still ambiguous

Use the smallest clarification prompt possible:

- `你更想看文档整理、设计分析、搜索流量、竞品市场，还是知乎素材？`

Do not ask an open-ended follow-up if a four-way clarification is enough.

## Feishu Bot Prompt Starters

These are safe starter phrasings the bot can accept directly.

### Notion

- `把这段讨论整理成需求`
- `帮我做一份会议纪要`
- `把这次讨论拆成任务`

### Figma

- `帮我看这个设计稿`
- `对照设计稿检查差异`
- `把这个页面拆成开发任务`

### Semrush

- `帮我看这个关键词值不值得做`
- `查一下这个域名的 SEO 情况`
- `对比两个竞品的搜索表现`

### Particl Market Research

- `帮我看这个品类趋势`
- `对比竞品卖点`
- `这个产品方向值不值得做`

### Zhihu

- `用知乎热榜给我整理今天的选题素材`
- `用知乎搜索这个关键词的高赞问题和回答`
- `用知乎直答帮我提炼这个话题的观点`

## Failure Policy

If runtime verification has not been completed:

- do not pretend the plugin already works end to end
- do not present stale or fabricated external data as live data
- do offer a bridge-native fallback:
  - local summary
  - analysis framework
  - task decomposition
  - follow-up checklist

Recommended wording:

- `这条能力我已经识别到了，但当前实例还没完成真实链路验通。`
- `我先给你一版结构化分析，不把它说成实时结果。`
- `等这条插件链路验通后，再补实时数据或外部上下文。`

## Verification Checklist

Each first-batch plugin should eventually move from "visible" to "supported" through the same checks:

1. Connector auth is available
2. Runtime can route the request
3. One read scenario works
4. If relevant, one write or command scenario works
5. Feishu reply formatting is readable on mobile

## Recommended Next Execution Order

1. Verify `notion`
2. Verify `figma`
3. Verify `semrush`
4. Verify `particl-market-research`
5. Verify `zhihu`

This order matches the most likely day-to-day Feishu bot usage.

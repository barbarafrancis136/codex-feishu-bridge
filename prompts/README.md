# Prompt Assets

这个目录用于存放可复用的 prompt 文本资产。

详细边界和外部加载示例见 `docs/PROMPT_ASSETS.md`。

当前新增：

- `agent-memory-layering.md`：Agent 记忆分层判断 Prompt。
- `skill-five-tier-audit.md`：Skill 五档体检 Prompt。

使用原则：

- 默认不接入运行时逻辑。
- 默认不写入公开核心功能。
- 如需启用，优先通过外部 prompt 文件或下游扩展引用。
- 如需发布到 npm 包，需要先审查整个 `prompts/` 目录的公开安全性。

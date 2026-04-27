
const { sanitizeAssistantMarkdown } = require("../../shared/assistant-markdown");
const { normalizeText, resolveEffectiveModelForEffort } = require("../../shared/model-catalog");

// UI card builders extracted from feishu-bot runtime
function buildApprovalCard(approval) {
  const requestType = approval?.method && approval.method.includes("command") ? "命令执行" : "敏感操作";
  const reasonText = formatApprovalReason(approval?.reason);
  const commandSummary = formatApprovalCommandSummary(approval?.command);
  const commandTarget = formatApprovalCommandTarget(approval?.command);
  const commandPreview = formatApprovalCommandPreview(approval?.command);
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "**Codex 授权请求**",
          text_size: "notation",
        },
        {
          tag: "markdown",
          content: [
            `请求类型：${requestType}`,
            reasonText ? `原因：${escapeCardMarkdown(reasonText)}` : "",
            commandSummary ? `操作摘要：${escapeCardMarkdown(commandSummary)}` : "",
            commandTarget ? `目标位置：${escapeCardMarkdown(commandTarget)}` : "",
            "请选择处理方式：",
          ].filter(Boolean).join("\n"),
          text_size: "normal",
        },
        ...buildApprovalCommandPreviewElements(commandPreview),
        {
          tag: "column_set",
          flex_mode: "none",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "本次允许" },
                  type: "primary",
                  value: {
                    kind: "approval",
                    decision: "approve",
                    scope: "once",
                    requestId: approval.requestId,
                    threadId: approval.threadId,
                  },
                },
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "自动允许" },
                  value: {
                    kind: "approval",
                    decision: "approve",
                    scope: "workspace",
                    requestId: approval.requestId,
                    threadId: approval.threadId,
                  },
                },
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "拒绝" },
                  type: "danger",
                  value: {
                    kind: "approval",
                    decision: "reject",
                    scope: "once",
                    requestId: approval.requestId,
                    threadId: approval.threadId,
                  },
                },
              ],
            },
          ],
        },
        {
          tag: "markdown",
          content: "`自动允许` 对当前项目生效，相同命令自动允许，重启后仍保留。",
          text_size: "notation",
        },
      ],
    },
  };
}

function buildApprovalCommandPreviewElements(commandPreview) {
  if (!commandPreview) {
    return [];
  }
  return [
    {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: {
          tag: "plain_text",
          content: "查看命令预览",
        },
        icon: {
          tag: "standard_icon",
          token: "down-small-ccm_outlined",
          size: "16px 16px",
        },
        icon_position: "follow_text",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      padding: "8px 8px 8px 8px",
      elements: [
        {
          tag: "markdown",
          content: escapeCardMarkdown(commandPreview),
          text_size: "notation",
        },
      ],
    },
  ];
}

function buildAssistantReplyCard({ text, state, incomingText = "", elapsed = "", model = "", toolText = "", thinkingText = "", usageText = "", contextText = "", toolCountText = "" }) {
  const normalizedState = state || "streaming";
  const content = typeof text === "string" && text.trim()
    ? text.trim()
    : normalizedState === "failed"
      ? "这次没有顺利完成。"
      : normalizedState === "completed"
        ? "我已经处理好了。"
        : "我正在整理正式回复。";
  const intro = buildAssistantReplyIntro(incomingText);
  const resolvedToolText = typeof toolText === "string" && toolText.trim()
    ? toolText.trim()
    : normalizedState === "streaming"
      ? "这条消息已经被我接住了。"
      : normalizedState === "failed"
        ? "这次处理在运行阶段出了问题。"
        : "这次回复已经顺利走完。";
  const resolvedThinkingText = typeof thinkingText === "string" && thinkingText.trim()
    ? thinkingText.trim()
    : normalizedState === "streaming"
      ? "我在整理怎么更稳地回你。"
      : normalizedState === "failed"
        ? "我这次没把它收稳，所以先停在这里。"
        : "我已经把这次回复收好了。";
  const footer = buildAssistantReplyFooter({
    status: normalizedState === "failed" ? "未完成" : normalizedState === "completed" ? "已完成" : "正在回复",
    elapsed,
    model,
    usageText,
    contextText,
    toolCountText,
  });

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "Codex",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: intro,
          text_size: "notation",
        },
        {
          tag: "collapsible_panel",
          expanded: false,
          header: {
            title: {
              tag: "plain_text",
              content: "🔧 工具执行",
            },
            icon: {
              tag: "standard_icon",
              token: "down-small-ccm_outlined",
              size: "16px 16px",
            },
            icon_position: "follow_text",
            icon_expanded_angle: -180,
          },
          border: { color: "grey", corner_radius: "5px" },
          padding: "8px 8px 8px 8px",
          elements: [
            {
              tag: "markdown",
              content: resolvedToolText,
              text_size: "notation",
            },
          ],
        },
        {
          tag: "collapsible_panel",
          expanded: false,
          header: {
            title: {
              tag: "plain_text",
              content: normalizedState === "streaming" ? "💭 正在想" : "💭 思考完成",
            },
            icon: {
              tag: "standard_icon",
              token: "down-small-ccm_outlined",
              size: "16px 16px",
            },
            icon_position: "follow_text",
            icon_expanded_angle: -180,
          },
          border: { color: "grey", corner_radius: "5px" },
          padding: "8px 8px 8px 8px",
          elements: [
            {
              tag: "markdown",
              content: resolvedThinkingText,
              text_size: "notation",
            },
          ],
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: sanitizeAssistantMarkdown(content),
          },
        },
        {
          tag: "markdown",
          content: footer,
          text_size: "notation",
        },
      ],
    },
  };
}

function buildAssistantReplyIntro(incomingText) {
  const clean = String(incomingText || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return "回复";
  }
  return `回复：${escapeCardMarkdown(clean.slice(0, 120))}`;
}

function buildAssistantReplyFooter({ status = "已完成", elapsed = "", model = "", usageText = "", contextText = "", toolCountText = "" }) {
  const parts = [status];
  if (elapsed) {
    parts.push(`耗时 ${escapeCardMarkdown(elapsed)}`);
  }
  if (toolCountText) {
    parts.push(escapeCardMarkdown(toolCountText));
  }
  if (usageText) {
    parts.push(escapeCardMarkdown(usageText));
  }
  if (contextText) {
    parts.push(escapeCardMarkdown(contextText));
  }
  parts.push(model ? escapeCardMarkdown(model) : "Codex");
  return parts.join(" · ");
}

function buildInfoCard(text, { kind = "info" } = {}) {
  const normalizedText = String(text || "").trim();
  const title = kind === "progress"
    ? "⏳ 处理中"
    : kind === "success"
      ? "✅ 已完成"
      : kind === "error"
        ? "❌ 处理失败"
        : "💬 提示";
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**${title}**\n\n${normalizedText}`,
          text_size: "normal",
        },
      ],
    },
  };
}

function buildStatusPanelCard({
  workspaceRoot,
  codexParams,
  modelOptions,
  effortOptions,
  threadId,
  currentThread,
  recentThreads,
  totalThreadCount,
  status,
  noticeText = "",
}) {
  const isRunning = status?.code === "running";
  const currentThreadStatusText = status?.code === "running"
    ? "🟡 运行中"
    : status?.code === "approval"
      ? "🟠 等待授权"
      : "";
  const shouldShowAllThreadsButton = Number(totalThreadCount || 0) > 3;
  const threadRows = [];
  const current = threadId ? (currentThread || { id: threadId }) : null;
  if (current) {
    threadRows.push({
      isCurrent: true,
      thread: current,
    });
  }
  for (const thread of (recentThreads || [])) {
    threadRows.push({
      isCurrent: false,
      thread,
    });
  }

  const elements = [];
  if (typeof noticeText === "string" && noticeText.trim()) {
    elements.push({
      tag: "markdown",
      content: `✅ ${escapeCardMarkdown(noticeText.trim())}`,
      text_size: "notation",
    });
  }

  elements.push({
      tag: "column_set",
      flex_mode: "none",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          vertical_align: "top",
          elements: [
            {
              tag: "markdown",
              content: [
                `**当前项目**：\`${escapeCardMarkdown(workspaceRoot)}\``,
              ].join(""),
            },
          ],
        },
      ],
    }
  );
  elements.push({
    tag: "column_set",
    flex_mode: "none",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "top",
        elements: [
          buildModelSelectElement(codexParams, modelOptions),
        ],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "top",
        elements: [
          buildEffortSelectElement(codexParams, effortOptions),
        ],
      },
    ],
  });
  elements.push({ tag: "hr" });

  if (threadRows.length) {
    elements.push({
      tag: "markdown",
      content: `**线程列表**（${threadRows.length}）`,
      text_size: "notation",
    });
    threadRows.forEach((row, index) => {
      if (index > 0) {
        elements.push({ tag: "hr" });
      }
      elements.push(buildThreadRow({
        thread: row.thread,
        isCurrent: row.isCurrent,
        currentThreadStatusText,
      }));
    });
  } else {
    elements.push({
      tag: "markdown",
      content: "**线程列表**\n暂无历史线程",
      text_size: "notation",
    });
  }

  const footerColumns = [];
  if (shouldShowAllThreadsButton) {
    footerColumns.push(buildFooterButtonColumn({
      text: "全部线程",
      value: buildPanelActionValue("open_threads"),
    }));
  }
  footerColumns.push(buildFooterButtonColumn({
    text: "新建",
    value: buildPanelActionValue("new_thread"),
  }));
  footerColumns.push(buildFooterButtonColumn({
    text: "状态",
    value: buildPanelActionValue("status"),
  }));
  if (isRunning) {
    footerColumns.push(buildFooterButtonColumn({
      text: "停止",
      value: buildPanelActionValue("stop"),
      type: "danger",
    }));
  }
  if (footerColumns.length) {
    elements.push(
      { tag: "hr" },
      {
        tag: "column_set",
        flex_mode: "none",
        columns: footerColumns,
      }
    );
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements,
    },
  };
}

function buildThreadPickerCard({ workspaceRoot, threads, currentThreadId }) {
  const elements = [
    {
      tag: "markdown",
      content: `**当前项目**：\`${escapeCardMarkdown(workspaceRoot)}\``,
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `**线程列表**（${Math.min(threads.length, 8)}）`,
      text_size: "notation",
    },
  ];

  threads.slice(0, 8).forEach((thread, index) => {
    if (index > 0) {
      elements.push({ tag: "hr" });
    }
    const isCurrent = thread.id === currentThreadId;
    elements.push(buildThreadRow({
      thread,
      isCurrent,
      currentThreadStatusText: "",
    }));
  });

  elements.push(
    { tag: "hr" },
    {
      tag: "button",
      text: { tag: "plain_text", content: "新建线程" },
      value: buildPanelActionValue("new_thread"),
    }
  );

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements,
    },
  };
}

function buildHelpCardText() {
  const sections = [
    [
      "**直接对话**",
      "绑定项目后，直接发普通消息即可继续当前线程。",
    ],
    [
      "**绑定项目**",
      "`/codex bind /绝对路径`",
      "把当前飞书会话绑定到一个本地项目。",
    ],
    [
      "**查看当前状态**",
      "`/codex where`",
      "查看当前绑定的项目和正在使用的线程。",
    ],
    [
      "**查看最近消息**",
      "`/codex message`",
      "查看当前线程最近几轮对话。",
    ],
    [
      "**查看可用历史线程**",
      "`/codex workspace`",
      "查看当前项目下 Codex runtime 可见的历史线程。",
    ],
    [
      "**移除会话项目绑定**",
      "`/codex remove /绝对路径`",
      "从当前飞书会话中移除指定项目（不能移除当前项目）。",
    ],
    [
      "**发送当前项目内文件**",
      "`/codex send <相对文件路径>`",
      "把当前项目内的文件发送到当前飞书会话。",
    ],
    [
      "**切换到指定线程**",
      "`/codex switch <threadId>`",
      "按线程 ID 切换到指定线程。",
    ],
    [
      "**新建线程**",
      "`/codex new`",
      "在当前项目下创建一条新线程并切换过去。",
    ],
    [
      "**中断运行**",
      "`/codex stop`",
      "停止当前线程里正在执行的任务。",
    ],
    [
      "**设置模型**",
      "`/codex model`",
      "`/codex model update`",
      "`/codex model <modelId>`",
      "查看/设置当前项目的模型覆盖。",
    ],
    [
      "**设置推理强度**",
      "`/codex effort`",
      "`/codex effort <low|medium|high|xhigh>`",
      "查看/设置当前项目的推理强度覆盖。",
    ],
    [
      "**切换 Codex 运行档**",
      "`/codex profile`",
      "`/codex profile main`",
      "按需切换飞书桥背后的 Codex app-server。",
    ],
    [
      "**审批命令**",
      "`/codex approve`\n`/codex approve workspace`\n`/codex reject`",
      "用于处理 Codex 发起的审批请求。",
    ],
  ];

  return [
    "**Codex IM 使用说明**",
    sections.map((section) => section.join("\n")).join("\n\n"),
  ].join("\n\n");
}

function listBoundWorkspaces(binding) {
  const activeWorkspaceRoot = String(binding?.activeWorkspaceRoot || "").trim();
  const threadIdByWorkspaceRoot = binding?.threadIdByWorkspaceRoot
    && typeof binding.threadIdByWorkspaceRoot === "object"
    ? binding.threadIdByWorkspaceRoot
    : {};
  const workspaceRoots = new Set(Object.keys(threadIdByWorkspaceRoot));
  if (activeWorkspaceRoot) {
    workspaceRoots.add(activeWorkspaceRoot);
  }

  return [...workspaceRoots]
    .map((workspaceRoot) => String(workspaceRoot || "").trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .map((workspaceRoot) => ({
      workspaceRoot,
      isActive: workspaceRoot === activeWorkspaceRoot,
      threadId: String(threadIdByWorkspaceRoot[workspaceRoot] || "").trim(),
    }));
}

function buildWorkspaceBindingsCard(items) {
  const elements = [
    {
      tag: "markdown",
      content: `**会话绑定项目**（${items.length}）`,
      text_size: "normal",
    },
  ];

  items.forEach((item, index) => {
    if (index > 0) {
      elements.push({ tag: "hr" });
    }
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 5,
          vertical_align: "top",
          elements: [
            {
              tag: "markdown",
              content: [
                `${item.isActive ? "🟢 当前项目" : "⚪ 已绑定项目"}`,
                `\`${escapeCardMarkdown(item.workspaceRoot)}\``,
                item.threadId ? "" : "线程：未关联",
              ].filter(Boolean).join("\n"),
              text_size: "notation",
            },
          ],
        },
        {
          tag: "column",
          width: "auto",
          vertical_align: "center",
          elements: item.isActive
            ? [
              {
                tag: "column_set",
                flex_mode: "none",
                columns: [
                  {
                    tag: "column",
                    width: "auto",
                    elements: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "线程列表" },
                        type: "primary",
                        value: buildWorkspaceActionValue("status", item.workspaceRoot),
                      },
                    ],
                  },
                  {
                    tag: "column",
                    width: "auto",
                    elements: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "当前" },
                        type: "default",
                        disabled: true,
                      },
                    ],
                  },
                ],
              },
            ]
            : [
              {
                tag: "column_set",
                flex_mode: "none",
                columns: [
                  {
                    tag: "column",
                    width: "auto",
                    elements: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "移除" },
                        type: "default",
                        value: buildWorkspaceActionValue("remove", item.workspaceRoot),
                      },
                    ],
                  },
                  {
                    tag: "column",
                    width: "auto",
                    elements: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "切换" },
                        type: "primary",
                        value: buildWorkspaceActionValue("switch", item.workspaceRoot),
                      },
                    ],
                  },
                ],
              },
            ],
        },
      ],
    });
  });

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements,
    },
  };
}

function buildThreadMessagesSummary({ workspaceRoot, thread, recentMessages }) {
  const sections = [
    `项目：\`${workspaceRoot}\``,
    `当前线程：${formatThreadLabel(thread)}`,
    "***",
    "**对话记录**",
  ];

  if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
    sections.push("空");
    return sections.join("\n\n");
  }

  const normalizedTranscript = recentMessages.map((message) => (
    message.role === "user"
      ? `😄 **你**\n> ${sanitizeAssistantMarkdown(message.text).replace(/\n/g, "\n> ")}`
      : `🤖 <font color='blue'>**Codex**</font>\n> ${sanitizeAssistantMarkdown(message.text).replace(/\n/g, "\n> ")}`
  ));
  sections.push(normalizedTranscript.join("\n\n---\n\n"));
  return sections.join("\n\n");
}

function mergeReplyText(previousText, nextText) {
  if (!previousText) {
    return nextText;
  }
  if (!nextText) {
    return previousText;
  }
  if (previousText === nextText) {
    return previousText;
  }
  if (nextText.startsWith(previousText)) {
    return nextText;
  }
  if (previousText.endsWith(nextText)) {
    return previousText;
  }
  if (previousText.startsWith(nextText)) {
    return previousText;
  }

  const maxOverlap = Math.min(previousText.length, nextText.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previousText.slice(-overlap) === nextText.slice(0, overlap)) {
      return previousText + nextText.slice(overlap);
    }
  }

  return previousText + nextText;
}


function buildApprovalResolvedCard(approval) {
  const resolutionLabel = approval.resolution === "approved" ? "已批准" : "已拒绝";
  const colorText = approval.resolution === "approved" ? "green" : "red";
  const reasonText = formatApprovalReason(approval?.reason);
  const commandSummary = formatApprovalCommandSummary(approval?.command);
  const commandTarget = formatApprovalCommandTarget(approval?.command);
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**Codex 授权请求 <font color='${colorText}'>${resolutionLabel}</font>**`,
          text_size: "notation",
        },
        {
          tag: "markdown",
          content: [
            reasonText ? `原因：${escapeCardMarkdown(reasonText)}` : "",
            commandSummary ? `操作摘要：${escapeCardMarkdown(commandSummary)}` : "",
            commandTarget ? `目标位置：${escapeCardMarkdown(commandTarget)}` : "",
          ].filter(Boolean).join("\n"),
          text_size: "normal",
        },
      ],
    },
  };
}

function formatApprovalReason(reason) {
  const normalized = compactApprovalText(reason);
  if (!normalized) {
    return "";
  }
  if (/run\s+this\s+command/i.test(normalized)) {
    return "执行这条命令需要授权";
  }
  return truncateApprovalText(normalized, 140);
}

function formatApprovalCommandSummary(command) {
  const normalized = compactApprovalText(command);
  if (!normalized) {
    return "";
  }
  if (/\bcat\s*>/.test(normalized) || /<<\s*['"]?EOF['"]?/.test(normalized)) {
    return "写入本地文件";
  }
  if (/\b(perl|sed)\b.*\b(-i|-0pi)\b/.test(normalized)) {
    return "修改本地文件内容";
  }
  if (/\bmv\b/.test(normalized)) {
    return "移动或重命名文件";
  }
  if (/\brm\b/.test(normalized)) {
    return "删除文件或目录";
  }
  if (/\/bin\/(?:zsh|bash|sh)\s+-lc/.test(normalized)) {
    return "执行本地 shell 命令";
  }
  return truncateApprovalText(normalized, 90);
}

function formatApprovalCommandTarget(command) {
  const normalized = normalizeApprovalCommand(command);
  if (!normalized) {
    return "";
  }
  const dirMatch = normalized.match(/(?:^|[\s;])dir=\\?"([^"\n]+)\\?"/);
  if (dirMatch?.[1]) {
    return formatApprovalTargetDisplay(dirMatch[1]);
  }
  const fileMatch = normalized.match(/(?:^|[\s;])file=\\?"([^"\n]+)\\?"/);
  if (fileMatch?.[1]) {
    return formatApprovalTargetDisplay(fileMatch[1]);
  }
  const absoluteMatch = normalized.match(/\/Users\/[^"'\n]+/);
  if (absoluteMatch?.[0]) {
    return formatApprovalTargetDisplay(absoluteMatch[0]);
  }
  return "";
}

function formatApprovalCommandPreview(command) {
  const normalized = compactApprovalText(command);
  if (!normalized) {
    return "";
  }
  return truncateApprovalText(normalized, 160);
}

function normalizeApprovalCommand(command) {
  return typeof command === "string" ? command.trim() : "";
}

function compactApprovalText(value) {
  return normalizeApprovalCommand(value)
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanApprovalPath(value) {
  return String(value || "")
    .replace(/\\"/g, "\"")
    .replace(/\\+$/g, "")
    .trim();
}

function formatApprovalTargetDisplay(value) {
  const cleaned = cleanApprovalPath(value);
  return truncateApprovalText(cleaned, 160);
}

function truncateApprovalText(value, maxLength) {
  const normalized = String(value || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function formatThreadLabel(thread) {
  if (!thread) {
    return "";
  }

  const title = typeof thread.title === "string" ? thread.title.trim() : "";
  if (!title) {
    return "未命名线程";
  }
  return truncateDisplayText(title, 50);
}

function formatThreadIdLine(thread) {
  const threadId = normalizeIdentifier(thread?.id);
  if (!threadId) {
    return "";
  }
  return `线程ID：\`${escapeCardMarkdown(threadId)}\``;
}

function truncateDisplayText(text, maxLength) {
  const input = String(text || "");
  const chars = Array.from(input);
  if (!Number.isFinite(maxLength) || maxLength <= 0 || chars.length <= maxLength) {
    return input;
  }
  return `${chars.slice(0, maxLength).join("")}...`;
}

function buildPanelActionValue(action) {
  return {
    kind: "panel",
    action,
  };
}

function buildFooterButtonColumn({ text, value, type = "", actionType = "" }) {
  const button = {
    tag: "button",
    text: { tag: "plain_text", content: text },
    value,
  };
  if (type) {
    button.type = type;
  }
  if (actionType) {
    button.action_type = actionType;
  }
  return {
    tag: "column",
    width: "auto",
    elements: [button],
  };
}

function buildFormSubmitButton({ name, text, value, type = "" }) {
  const button = {
    tag: "button",
    name,
    action_type: "form_submit",
    text: { tag: "plain_text", content: text },
    value,
  };
  if (type) {
    button.type = type;
  }
  return button;
}

function buildModelSelectElement(codexParams, modelOptions) {
  const options = normalizeSelectOptions(modelOptions);
  if (!options.length) {
    return {
      tag: "markdown",
      content: "暂无可用模型（等待启动同步或执行 `/codex model update`）",
      text_size: "notation",
    };
  }
  const selectedValue = String(codexParams?.model || "").trim();
  const initialOption = findOptionByValue(options, selectedValue);
  return {
    tag: "select_static",
    placeholder: {
      tag: "plain_text",
      content: `选择模型（当前：${formatCodexParam(codexParams?.model)}）`,
    },
    options,
    initial_option: initialOption?.value || undefined,
    value: buildPanelActionValue("set_model"),
  };
}

function buildEffortSelectElement(codexParams, effortOptions) {
  const options = normalizeSelectOptions(effortOptions);
  if (!options.length) {
    return {
      tag: "markdown",
      content: "当前模型没有可用推理强度",
      text_size: "notation",
    };
  }
  const selectedValue = String(codexParams?.effort || "").trim();
  const initialOption = findOptionByValue(options, selectedValue);
  return {
    tag: "select_static",
    placeholder: {
      tag: "plain_text",
      content: `选择推理强度（当前：${formatCodexParam(codexParams?.effort)}）`,
    },
    options,
    initial_option: initialOption?.value || undefined,
    value: buildPanelActionValue("set_effort"),
  };
}

function normalizeSelectOptions(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const options = [];
  for (const item of input) {
    const label = truncateDisplayText(String(item?.label || item?.value || "").trim(), 60);
    const value = String(item?.value || "").trim();
    if (!label || !value) {
      continue;
    }
    options.push({
      text: { tag: "plain_text", content: label },
      value,
    });
  }
  return options.slice(0, 100);
}

function findOptionByValue(options, selectedValue) {
  const normalized = String(selectedValue || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return options.find((option) => String(option?.value || "").trim().toLowerCase() === normalized) || null;
}

function buildThreadActionValue(action, threadId) {
  return {
    kind: "thread",
    action,
    threadId,
  };
}

function buildWorkspaceActionValue(action, workspaceRoot) {
  return {
    kind: "workspace",
    action,
    workspaceRoot,
  };
}

function summarizeThreadPreview(thread) {
  const updated = formatRelativeTimestamp(thread?.updatedAt);
  return updated ? `更新时间：${updated}` : "更新时间：未知";
}

function formatRelativeTimestamp(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} 小时前`;
  }
  return `${Math.floor(seconds / 86400)} 天前`;
}

function buildCardToast(text) {
  return buildCardResponse({ toast: text });
}

function buildCardResponse({ toast, card }) {
  const response = {};
  if (toast) {
    response.toast = {
      type: "info",
      content: toast,
    };
  }
  if (card) {
    response.card = {
      type: "raw",
      data: card,
    };
  }
  return response;
}


function escapeCardMarkdown(text) {
  const input = String(text || "");
  return input
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+.!|>~])/g, "\\$1");
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function formatCodexParam(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || "默认";
}

function buildModelInfoText(workspaceRoot, current, availableModelsResult) {
  const model = current?.model || "默认";
  const effort = current?.effort || "默认";
  const modelLines = buildAvailableModelLines(availableModelsResult, { limit: 10 });
  const canLoadModels = !availableModelsResult?.error;
  return [
    `当前项目：\`${workspaceRoot}\``,
    `模型：${model}`,
    `推理强度：${effort}`,
    "",
    ...modelLines,
    "",
    "用法：",
    "`/codex model`",
    "`/codex model update`",
    "`/codex model <modelId>`",
    canLoadModels ? "" : "提示：当前无法拉取模型列表，设置模型会被拒绝。",
  ].join("\n");
}

function buildEffortInfoText(workspaceRoot, current, availableModelsResult) {
  const model = current?.model || "默认";
  const effort = current?.effort || "默认";
  const effectiveModel = resolveEffectiveModelForEffort(
    availableModelsResult?.models || [],
    current?.model || ""
  );
  const effortLines = buildAvailableEffortLines(effectiveModel, availableModelsResult);
  return [
    `当前项目：\`${workspaceRoot}\``,
    `模型：${model}`,
    `推理强度：${effort}`,
    "",
    ...effortLines,
    "",
    "用法：",
    "`/codex effort`",
    "`/codex model update`",
    "`/codex effort <low|medium|high|xhigh>`",
  ].join("\n");
}

function buildModelListText(workspaceRoot, availableModelsResult, { refreshed = false } = {}) {
  const cacheMeta = buildCacheMetaLine(availableModelsResult, { refreshed });
  const lines = [
    `当前项目：\`${workspaceRoot}\``,
    cacheMeta,
    "",
    "**可用模型**",
  ];
  lines.push(...buildAvailableModelLines(availableModelsResult, { limit: 60 }));
  lines.push("", "用法：", "`/codex model update`", "`/codex model <modelId>`");
  return lines.join("\n");
}

function buildModelValidationErrorText(workspaceRoot, rawModel, models) {
  const suggestions = suggestModels(models, rawModel, 3);
  const lines = [
    `当前项目：\`${workspaceRoot}\``,
    "",
    `未找到可用模型：\`${normalizeText(rawModel)}\``,
  ];
  if (suggestions.length) {
    lines.push("", "你可能想设置：");
    for (const item of suggestions) {
      lines.push(`- \`${item.model}\``);
    }
  }
  lines.push("", "请执行 `/codex model` 查看可用模型。");
  return lines.join("\n");
}

function buildEffortListText(workspaceRoot, current, availableModelsResult, { refreshed = false } = {}) {
  const effectiveModel = resolveEffectiveModelForEffort(
    availableModelsResult?.models || [],
    current?.model || ""
  );
  const cacheMeta = buildCacheMetaLine(availableModelsResult, { refreshed });
  const lines = [
    `当前项目：\`${workspaceRoot}\``,
    cacheMeta,
    `当前模型：\`${effectiveModel?.model || current?.model || "默认"}\``,
    "",
    "**可用推理强度**",
    ...buildAvailableEffortLines(effectiveModel, availableModelsResult),
    "",
    "用法：",
    "`/codex effort`",
    "`/codex model update`",
    "`/codex effort <low|medium|high|xhigh>`",
  ];
  return lines.join("\n");
}

function buildEffortValidationErrorText(workspaceRoot, modelEntry, rawEffort) {
  const supportedLines = buildAvailableEffortLines(modelEntry, { models: [modelEntry], error: "" });
  return [
    `当前项目：\`${workspaceRoot}\``,
    `当前模型：\`${modelEntry?.model || "未知"}\``,
    "",
    `该模型不支持推理强度：\`${normalizeText(rawEffort)}\``,
    "",
    "可用推理强度：",
    ...supportedLines,
    "",
    "请执行 `/codex effort` 查看可用推理强度。",
  ].join("\n");
}

function buildAvailableModelLines(availableModelsResult, { limit = 10 } = {}) {
  if (availableModelsResult?.error) {
    return [`获取可用模型失败：${availableModelsResult.error}`];
  }
  const models = Array.isArray(availableModelsResult?.models) ? availableModelsResult.models : [];
  if (!models.length) {
    return ["暂无可用模型。"];
  }

  const lines = [`共 ${models.length} 个模型：`];
  const display = models.slice(0, Math.max(1, limit));
  for (const item of display) {
    lines.push(`- \`${item.model}\``);
  }
  if (models.length > display.length) {
    lines.push(`- ... 还有 ${models.length - display.length} 个，执行 \`/codex model\` 查看全部`);
  }
  return lines;
}

function buildAvailableEffortLines(effectiveModel, availableModelsResult) {
  if (availableModelsResult?.error) {
    return [`获取可用推理强度失败：${availableModelsResult.error}`];
  }
  if (!effectiveModel) {
    return ["暂无可用推理强度（未解析到可用模型）。"];
  }
  const supported = Array.isArray(effectiveModel.supportedReasoningEfforts)
    ? effectiveModel.supportedReasoningEfforts
    : [];
  if (supported.length) {
    return supported.map((effort) => `- \`${effort}\``);
  }
  const defaultEffort = normalizeText(effectiveModel.defaultReasoningEffort);
  if (defaultEffort) {
    return [`- \`${defaultEffort}\``];
  }
  return ["该模型未声明可用推理强度。"];
}

function buildCacheMetaLine(availableModelsResult, { refreshed = false } = {}) {
  const source = availableModelsResult?.source || "";
  const updatedAt = normalizeText(availableModelsResult?.updatedAt);
  const warning = normalizeText(availableModelsResult?.warning);
  let sourceLabel = "来源：未知";
  if (source === "cache") {
    sourceLabel = "来源：本地缓存";
  } else if (source === "live") {
    sourceLabel = "来源：实时拉取";
  } else if (source === "refresh") {
    sourceLabel = "来源：强制刷新";
  }
  const timeLabel = updatedAt ? `，更新时间：${updatedAt}` : "";
  const refreshLabel = refreshed ? "（已执行刷新）" : "";
  const warningLabel = warning ? `\n提示：${warning}` : "";
  return `${sourceLabel}${timeLabel}${refreshLabel}${warningLabel}`;
}

function suggestModels(models, rawInput, limit = 3) {
  const query = normalizeText(rawInput).toLowerCase();
  if (!query) {
    return models.slice(0, limit);
  }
  const startsWith = [];
  const includes = [];
  for (const item of models) {
    const model = normalizeText(item.model).toLowerCase();
    const id = normalizeText(item.id).toLowerCase();
    if (model.startsWith(query) || id.startsWith(query)) {
      startsWith.push(item);
      continue;
    }
    if (model.includes(query) || id.includes(query)) {
      includes.push(item);
    }
  }
  const merged = [...startsWith, ...includes];
  if (merged.length >= limit) {
    return merged.slice(0, limit);
  }
  const seen = new Set(merged.map((item) => normalizeText(item.model).toLowerCase()));
  for (const item of models) {
    const key = normalizeText(item.model).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    merged.push(item);
    seen.add(key);
    if (merged.length >= limit) {
      break;
    }
  }
  return merged;
}

module.exports = {
  buildApprovalCard,
  buildApprovalResolvedCard,
  buildAssistantReplyCard,
  buildCardResponse,
  buildCardToast,
  buildHelpCardText,
  buildInfoCard,
  buildModelInfoText,
  buildModelListText,
  buildModelValidationErrorText,
  buildStatusPanelCard,
  buildEffortInfoText,
  buildEffortListText,
  buildEffortValidationErrorText,
  buildThreadMessagesSummary,
  buildThreadPickerCard,
  buildWorkspaceBindingsCard,
  listBoundWorkspaces,
  mergeReplyText,
};

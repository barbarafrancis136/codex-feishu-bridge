const { filterThreadsByWorkspaceRoot } = require("../../shared/workspace-paths");
const { extractSwitchThreadId } = require("../../shared/command-parsing");
const codexMessageUtils = require("../../infra/codex/message-utils");
const attachmentRuntime = require("../attachments/attachment-service");

const THREAD_SOURCE_KINDS = new Set([
  "app",
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

const GOAL_CONTINUATION_PREFIXES = Object.freeze([
  "继续",
  "全部继续",
  "接着",
  "继续做",
  "接着做",
  "往下",
  "下一步",
  "然后呢",
  "continue",
  "go on",
  "keep going",
  "carry on",
  "resume",
]);

async function resolveWorkspaceThreadState(runtime, {
  bindingKey,
  workspaceRoot,
  normalized,
  autoSelectThread = true,
}) {
  const threads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const shouldAutoSelectThread = autoSelectThread && binding.threadScopedBinding !== true;
  const threadId = selectedThreadId || (shouldAutoSelectThread ? (threads[0]?.id || "") : "");
  if (!selectedThreadId && threadId) {
    runtime.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
  }
  if (threadId) {
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
  }
  return { threads, threadId, selectedThreadId };
}

async function ensureThreadAndSendMessage(runtime, { bindingKey, workspaceRoot, normalized, threadId }) {
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const useBridgeGoalMode = shouldUseBridgeGoalMode(runtime?.config);
  const workspaceGoal = useBridgeGoalMode && workspaceRoot
    ? runtime.sessionStore.getGoalForWorkspace(bindingKey, workspaceRoot)
    : "";
  const chatGoal = useBridgeGoalMode ? runtime.sessionStore.getChatGoal(bindingKey) : "";
  const goal = workspaceGoal || chatGoal;
  const goalScope = workspaceGoal ? "project" : "chat";
  const goalState = useBridgeGoalMode
    ? (workspaceRoot
      ? runtime.sessionStore.getGoalStateForWorkspace(bindingKey, workspaceRoot)
      : runtime.sessionStore.getChatGoalState(bindingKey))
    : null;
  const messageText = buildMessageWithBridgeCapabilities(
    useBridgeGoalMode
      ? buildMessageWithGoal(normalized.text, goal, goalScope, goalState)
      : String(normalized.text || ""),
    {
      includeGoalBridgeNotes: useBridgeGoalMode,
      nativeAutomationAvailable: Boolean(runtime?.config?.nativeAutomationAvailable),
      nativeWakeToFeishuAvailable: Boolean(runtime?.config?.nativeWakeToFeishuAvailable),
      bridgeWakeupAvailable: Boolean(runtime?.config?.bridgeWakeupEnabled),
    }
  );
  const finalizeAttachmentReceipt = async (error = null) => {
    if (!normalized?.attachmentReceipt) {
      return;
    }
    const receipt = attachmentRuntime.markAttachmentReceiptDelivered(normalized.attachmentReceipt, { error });
    normalized.attachmentReceipt = receipt;
    await attachmentRuntime.sendAttachmentReceipt(runtime, normalized, receipt);
  };

  if (!threadId) {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    console.log(`[codex-im] turn/start first message thread=${createdThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: createdThreadId,
      text: messageText,
      attachments: normalized.attachments || [],
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: codexParams.accessMode || runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    await finalizeAttachmentReceipt();
    return createdThreadId;
  }

  try {
    await ensureThreadResumed(runtime, threadId);
    await runtime.codex.sendUserMessage({
      threadId,
      text: messageText,
      attachments: normalized.attachments || [],
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: codexParams.accessMode || runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    console.log(`[codex-im] turn/start ok workspace=${workspaceRoot} thread=${threadId}`);
    await finalizeAttachmentReceipt();
    rememberThreadSelection(runtime, {
      bindingKey,
      workspaceRoot,
      threadId,
      normalized,
    });
    return threadId;
  } catch (error) {
    if (!shouldRecreateThread(error)) {
      await finalizeAttachmentReceipt(error);
      throw error;
    }

    console.warn(`[codex-im] stale thread detected, recreating thread: ${threadId}`);
    runtime.resumedThreadIds.delete(threadId);
    clearRememberedThread(runtime, bindingKey, workspaceRoot);
    const recreatedThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    console.log(`[codex-im] turn/start retry thread=${recreatedThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: recreatedThreadId,
      text: messageText,
      attachments: normalized.attachments || [],
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: codexParams.accessMode || runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    await finalizeAttachmentReceipt();
    return recreatedThreadId;
  }
}

async function createWorkspaceThread(runtime, { bindingKey, workspaceRoot, normalized }) {
  const response = await runtime.codex.startThread({
    cwd: workspaceRoot,
  });
  console.log(
    workspaceRoot
      ? `[codex-im] thread/start ok workspace=${workspaceRoot}`
      : `[codex-im] thread/start ok binding=${bindingKey}`
  );

  const resolvedThreadId = codexMessageUtils.extractThreadId(response);
  if (!resolvedThreadId) {
    throw new Error("thread/start did not return a thread id");
  }

  rememberThreadSelection(runtime, {
    bindingKey,
    workspaceRoot,
    threadId: resolvedThreadId,
    normalized,
  });
  runtime.resumedThreadIds.add(resolvedThreadId);
  runtime.setPendingThreadContext(resolvedThreadId, normalized);
  return resolvedThreadId;
}

async function ensureThreadResumed(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || runtime.resumedThreadIds.has(normalizedThreadId)) {
    return null;
  }

  const response = await runtime.codex.resumeThread({ threadId: normalizedThreadId });
  runtime.resumedThreadIds.add(normalizedThreadId);
  console.log(`[codex-im] thread/resume ok thread=${normalizedThreadId}`);
  return response;
}

async function handleNewCommand(runtime, normalized) {
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);

  try {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: workspaceRoot
        ? `已创建新线程并切换到它。\n${workspaceRoot}\n\nthread: ${createdThreadId}`
        : `已创建新的飞书会话线程，并切换到它。\n\nthread: ${createdThreadId}`,
    });
    if (workspaceRoot) {
      await runtime.showStatusPanel(normalized, { replyToMessageId: normalized.messageId });
    }
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `创建新线程失败: ${error.message}`,
    });
  }
}

async function handleSwitchCommand(runtime, normalized) {
  const threadId = extractSwitchThreadId(normalized.text);
  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex switch <threadId>`",
    });
    return;
  }

  await switchThreadById(runtime, normalized, threadId, { replyToMessageId: normalized.messageId });
}

async function refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized) {
  try {
    const threads = await listCodexThreadsForWorkspace(runtime, workspaceRoot);
    const currentThreadId = runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const shouldKeepCurrentThread = currentThreadId && runtime.resumedThreadIds.has(currentThreadId);
    if (currentThreadId && !shouldKeepCurrentThread && !threads.some((thread) => thread.id === currentThreadId)) {
      clearRememberedThread(runtime, bindingKey, workspaceRoot);
    }
    return threads;
  } catch (error) {
    console.warn(`[codex-im] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
    return [];
  }
}

async function listCodexThreadsForWorkspace(runtime, workspaceRoot) {
  if (!workspaceRoot) {
    return [];
  }
  const allThreads = await listCodexThreadsPaginated(runtime);
  const sourceFiltered = allThreads.filter((thread) => isSupportedThreadSourceKind(thread?.sourceKind));
  return filterThreadsByWorkspaceRoot(sourceFiltered, workspaceRoot);
}

async function listCodexThreadsPaginated(runtime) {
  const allThreads = [];
  const seenThreadIds = new Set();
  let cursor = null;

  for (let page = 0; page < 10; page += 1) {
    const response = await runtime.codex.listThreads({
      cursor,
      limit: 200,
      sortKey: "updated_at",
    });
    const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
    for (const thread of pageThreads) {
      if (seenThreadIds.has(thread.id)) {
        continue;
      }
      seenThreadIds.add(thread.id);
      allThreads.push(thread);
    }

    const nextCursor = codexMessageUtils.extractThreadListCursor(response);
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
    if (pageThreads.length === 0) {
      break;
    }
  }

  return allThreads;
}

function describeWorkspaceStatus(runtime, threadId) {
  if (!threadId) {
    return { code: "idle", label: "空闲" };
  }
  if (runtime.pendingApprovalByThreadId.has(threadId)) {
    return { code: "approval", label: "等待授权" };
  }
  if (runtime.activeTurnIdByThreadId.has(threadId)) {
    return { code: "running", label: "运行中" };
  }
  return { code: "idle", label: "空闲" };
}

async function switchThreadById(runtime, normalized, threadId, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  if (currentThreadId && currentThreadId === threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "已经是当前线程，无需切换。",
    });
    return;
  }

  const availableThreads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThread = availableThreads.find((thread) => thread.id === threadId) || null;
  if (!selectedThread) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "指定线程当前不可用，请刷新后重试。",
    });
    return;
  }

  const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    resolvedWorkspaceRoot,
    threadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
  runtime.setThreadBindingKey(threadId, bindingKey);
  runtime.setThreadWorkspaceRoot(threadId, resolvedWorkspaceRoot);
  runtime.resumedThreadIds.delete(threadId);
  await ensureThreadResumed(runtime, threadId);
  await runtime.showStatusPanel(normalized, { replyToMessageId: replyTarget });
}

function rememberThreadSelection(runtime, { bindingKey, workspaceRoot, threadId, normalized }) {
  runtime.setThreadBindingKey(threadId, bindingKey);
  if (workspaceRoot) {
    runtime.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
    return;
  }
  runtime.sessionStore.setChatThreadId(
    bindingKey,
    threadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
}

function clearRememberedThread(runtime, bindingKey, workspaceRoot) {
  if (workspaceRoot) {
    runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    return;
  }
  runtime.sessionStore.clearChatThreadId(bindingKey);
}

function isSupportedThreadSourceKind(sourceKind) {
  const normalized = typeof sourceKind === "string" && sourceKind.trim() ? sourceKind.trim() : "unknown";
  return THREAD_SOURCE_KINDS.has(normalized);
}

function shouldRecreateThread(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found") || message.includes("unknown thread");
}

function buildMessageWithBridgeCapabilities(text, {
  includeGoalBridgeNotes = true,
  nativeAutomationAvailable = false,
  nativeWakeToFeishuAvailable = false,
  bridgeWakeupAvailable = false,
} = {}) {
  return [
    "<feishu-bridge-capabilities>",
    "[System note: This Feishu/Lark bridge is transport-only. Keep reasoning, planning, tool selection, and task execution inside Codex-1 rather than asking the bridge to decide work for you.]",
    ...(includeGoalBridgeNotes
      ? ["[System note: Treat any <feishu-project-goal> or <feishu-chat-goal> block as a standing objective that should shape planning, tradeoffs, and follow-through across the whole task unless the user explicitly changes it.]"]
      : []),
    "[System note: Default operating mode: understand the request, inspect the available context before deciding, execute end-to-end when safe, make reasonable assumptions instead of stalling, and verify results before claiming success.]",
    "[System note: When the request is visual, design, diagram, presentation, image, video, or creative-production related, proactively use the strongest available visual stack when helpful, especially Figma, Canva, BioRender, HyperFrames, Cloudinary, and Remotion. Prefer concrete artifacts, drafts, or structured execution over abstract advice.]",
    "[System note: When blocked, give one concrete blocker and the next best action. Avoid long restatements, avoid asking the user to repeat prior context, and resume from prior progress when the user says to continue.]",
    "[System note: The bridge can return normal Feishu replies to the current thread.]",
    "[System note: This Feishu/Lark bridge can send current-workspace attachments back to Feishu. If the user asks you to send a local image, file, or audio, create or locate the file under the bound workspace, then include a hidden directive on its own line: [[codex-feishu-send:relative/path/from/workspace]]. The bridge will upload it. Supported routing: images as Feishu image messages, .opus/.mp4 as audio, other files as file messages. Do not use absolute paths in the directive; keep a short human explanation separately.]",
    `[System note: Native automation available: ${nativeAutomationAvailable ? "yes" : "no"}.]`,
    `[System note: Native wake-to-Feishu available: ${nativeWakeToFeishuAvailable ? "yes" : "no"}.]`,
    `[System note: Bridge timed wakeup available: ${bridgeWakeupAvailable ? "yes" : "no"}.]`,
    "[System note: You may discuss, structure, and refine scheduling or reminder requests, but when neither native automation nor bridge timed wakeup is available you must not claim that a real timed reminder, appointment, cron, or delayed wake-up has been created.]",
    "[System note: If bridge timed wakeup is available but native automation is unavailable, you may still create a bridge-managed delayed reminder by appending exactly one hidden directive on its own line near the end of the final answer using strict one-line JSON: [[codex-feishu-wakeup:{\"runAt\":\"2026-05-26T10:00:00+08:00\",\"text\":\"Reminder text to send later\",\"title\":\"optional short label\",\"replyInThread\":true}]]]",
    "[System note: Only emit the bridge wakeup directive when the user clearly asked to create a timed reminder and you have a concrete executable time. The visible reply must honestly say it is a bridge-managed reminder rather than native Codex automation.]",
    "[System note: The bridge wakeup directive is hidden transport metadata. Do not mention the directive syntax to the user, do not wrap it in code fences, and keep the JSON valid on one line.]",
    "[System note: If neither native automation nor bridge timed wakeup is available, for requests such as '5 minutes later remind me to drink water' or 'tomorrow evening at 7 remind me to leave work', explain clearly that this runtime currently cannot create an executable timed reminder. Do not fabricate success confirmations, IDs, saved state, or scheduled delivery.]",
    "[System note: Replies are shown in Feishu CardKit. Prefer scan-friendly Markdown: short paragraphs, ordered/bulleted lists, Markdown tables for comparisons, and fenced code blocks for commands/snippets.]",
    "[System note: For long product copy, multilingual copy, Russian text, Ozon-style listing drafts, titles, tags, attributes, and descriptions, do not wrap the content in fenced code blocks unless the user explicitly asks for raw code/text blocks. Use plain Markdown sections instead.]",
    "[System note: When outputting e-commerce copy for Feishu, keep each label or tag on its own line when possible, split long descriptions into short paragraphs, leave a blank line between major sections, and avoid dense mixed-language lines that are hard to read in CardKit.]",
    "[System note: If the content includes hashtags, keywords, or attributes, prefer one item per line or short bullet lists instead of a single crowded line.]",
    "</feishu-bridge-capabilities>",
    "",
    text,
  ].join("\n");
}

function buildMessageWithGoal(text, goal, scope = "project", goalState = null) {
  const normalizedGoal = String(goal || "").trim();
  const normalizedText = String(text || "");
  const normalizedGoalState = normalizeGoalState(goalState);
  if (!normalizedGoal && !hasGoalState(normalizedGoalState)) {
    return normalizedText;
  }
  const tagName = scope === "chat" ? "feishu-chat-goal" : "feishu-project-goal";
  const followThroughNote = buildGoalFollowThroughNote(normalizedText, normalizedGoalState);
  const sections = [];
  if (normalizedGoal) {
    sections.push(
      `<${tagName}>`,
      normalizedGoal,
      `</${tagName}>`
    );
  }
  if (hasGoalState(normalizedGoalState)) {
    if (sections.length) {
      sections.push("");
    }
    sections.push(
      "<feishu-goal-state>",
      ...buildGoalStateLines(normalizedGoalState),
      "</feishu-goal-state>"
    );
  }
  if (normalizedGoal || hasGoalState(normalizedGoalState)) {
    if (sections.length) {
      sections.push("");
    }
    sections.push(
      "<feishu-goal-contract>",
      ...buildGoalContractLines(),
      "</feishu-goal-contract>"
    );
  }
  if (followThroughNote) {
    sections.push(
      "",
      "<feishu-goal-mode>",
      followThroughNote,
      "</feishu-goal-mode>"
    );
  }
  sections.push("", normalizedText);
  return sections.join("\n");
}

function buildGoalFollowThroughNote(text, goalState = null) {
  if (!isGoalContinuationMessage(text)) {
    return "";
  }
  const normalizedGoalState = normalizeGoalState(goalState);
  const lines = [
    "[System note: The user's latest message is a continuation against the active goal.]",
    "[System note: Resume from the most recent progress, do not restart discovery from scratch, choose the highest-value next step, and keep advancing until the goal is complete or you hit a concrete blocker.]",
  ];
  if (normalizedGoalState.stage) {
    lines.push(`[System note: The current remembered stage is: ${normalizedGoalState.stage}]`);
  }
  if (normalizedGoalState.nextStep) {
    lines.push(`[System note: Unless the user changed direction or new evidence invalidates it, start by executing this remembered next step first: ${normalizedGoalState.nextStep}]`);
  }
  if (normalizedGoalState.status === "blocked") {
    lines.push("[System note: The remembered goal state is blocked. First verify whether the blocker is still real. If it is, focus this turn on the single unblock request instead of pretending active execution is possible.]");
  }
  return lines.join("\n");
}

function isGoalContinuationMessage(text) {
  const normalized = normalizeContinuationText(text);
  if (!normalized) {
    return false;
  }
  return GOAL_CONTINUATION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function normalizeContinuationText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[。！？!?,，、；;:："'“”‘’（）()\[\]【】]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGoalState(goalState) {
  const input = goalState && typeof goalState === "object" ? goalState : {};
  return {
    status: normalizeInlineValue(input.status).toLowerCase(),
    stage: normalizeInlineValue(input.stage),
    nextStep: normalizeInlineValue(input.nextStep || input.next_step),
    summary: normalizeInlineValue(input.summary),
    updatedAt: normalizeInlineValue(input.updatedAt || input.updated_at),
  };
}

function hasGoalState(goalState) {
  const normalized = normalizeGoalState(goalState);
  return !!(normalized.status || normalized.stage || normalized.nextStep || normalized.summary);
}

function buildGoalStateLines(goalState) {
  const lines = [];
  if (goalState.status) {
    lines.push(`status: ${goalState.status}`);
  }
  if (goalState.stage) {
    lines.push(`stage: ${goalState.stage}`);
  }
  if (goalState.nextStep) {
    lines.push(`next_step: ${goalState.nextStep}`);
  }
  if (goalState.summary) {
    lines.push(`summary: ${goalState.summary}`);
  }
  if (goalState.updatedAt) {
    lines.push(`updated_at: ${goalState.updatedAt}`);
  }
  return lines;
}

function buildGoalContractLines() {
  return [
    "[System note: Goal tracking is stateful across turns. When you reply to a goal-shaped task, silently report the latest goal state in your final answer so the bridge can persist it.]",
    "[System note: Include exactly one hidden directive on its own line near the end of the final answer using strict JSON: [[codex-goal-state:{\"status\":\"active|completed|blocked\",\"stage\":\"short current stage\",\"nextStep\":\"single best next step\",\"summary\":\"brief progress summary\"}]]]",
    "[System note: The hidden directive is additive metadata, not the user-facing answer. First complete the normal visible answer to the user, then append the hidden directive on a separate line.]",
    "[System note: Use status=completed only when the active goal is actually done. Use status=blocked only when progress cannot continue without an external unblocker. Otherwise use status=active.]",
    "[System note: If the user's latest message is only a continuation request such as continue or 继续, do not restart discovery or ask what to do next when the active goal and remembered nextStep already make the next move clear.]",
    "[System note: Keep stage names stable across nearby turns. Only change stage when a real milestone advances, and avoid generic labels like working, continuing, or in progress.]",
    "[System note: Keep stage and summary concise. Keep nextStep concrete and singular. If the goal is complete, nextStep may be an empty string.]",
    "[System note: nextStep should name the single best immediate action after this reply. If the goal is blocked, nextStep should name the single unblock action needed.]",
    "[System note: Do not mention the hidden directive explicitly to the user, do not wrap it in code fences, and keep it valid one-line JSON so the bridge can strip and store it.]",
  ];
}

function normalizeInlineValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function shouldUseBridgeGoalMode(config = {}) {
  return String(config.bridgeMode || "thin").trim().toLowerCase() !== "direct";
}

module.exports = {
  createWorkspaceThread,
  describeWorkspaceStatus,
  ensureThreadAndSendMessage,
  ensureThreadResumed,
  handleNewCommand,
  handleSwitchCommand,
  refreshWorkspaceThreads,
  resolveWorkspaceThreadState,
  switchThreadById,
};

const fs = require("fs");
const path = require("path");
const {
  isAbsoluteWorkspacePath,
  isPathStyleCompatibleWithRuntime,
  isWorkspaceAllowed,
  formatRuntimePlatformLabel,
  normalizeWorkspacePath,
  pathMatchesWorkspaceRoot,
} = require("../../shared/workspace-paths");
const {
  extractAccessValue,
  extractBindPath,
  extractEffortValue,
  extractGoalValue,
  extractModelValue,
  extractPluginValue,
  extractRemoveWorkspacePath,
  extractSendPath,
  extractSkillValue,
} = require("../../shared/command-parsing");
const {
  extractModelCatalogFromListResponse,
  findModelByQuery,
  normalizeText,
  resolveEffectiveModelForEffort,
} = require("../../shared/model-catalog");
const {
  classifyLocalAttachment,
  inferFeishuFileType,
} = require("../../shared/media-types");
const codexMessageUtils = require("../../infra/codex/message-utils");
const { formatFailureText } = require("../../shared/error-text");
const {
  describePluginInstall,
  ensureGithubPluginInstall,
  ensureMarketplaceEntry,
  ensurePluginManifest,
  ensurePluginSkeleton,
  listInstalledPlugins,
  listMarketplacePlugins,
  normalizePluginName,
  readPluginManifest,
  toDisplayName,
} = require("../../infra/plugins/plugin-registry");

const MAX_FEISHU_UPLOAD_FILE_BYTES = 30 * 1024 * 1024;
const MAX_FEISHU_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

async function resolveWorkspaceContext(
  runtime,
  normalized,
  {
    replyToMessageId = "",
    missingWorkspaceText = buildMissingWorkspaceBindingText(),
  } = {}
) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: missingWorkspaceText,
    });
    return null;
  }

  return { bindingKey, workspaceRoot, replyTarget };
}

async function handleBindCommand(runtime, normalized) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const rawWorkspaceRoot = extractBindPath(normalized.text);
  if (!rawWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法：`/codex bind /绝对路径`",
    });
    return;
  }

  const workspaceRoot = normalizeWorkspacePath(rawWorkspaceRoot);
  if (!isAbsoluteWorkspacePath(workspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "只支持绝对路径绑定。Windows 例如 `C:\\code\\repo`，Linux/macOS 例如 `/root/project`。",
    });
    return;
  }
  if (!isPathStyleCompatibleWithRuntime(workspaceRoot, process.platform)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildWorkspacePathStyleMismatchText(runtime, workspaceRoot),
    });
    return;
  }
  if (!isWorkspaceAllowed(workspaceRoot, runtime.config.workspaceAllowlist)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "该项目不在允许绑定的白名单中。",
    });
    return;
  }

  const workspaceStats = await runtime.resolveWorkspaceStats(workspaceRoot);
  if (!workspaceStats.exists) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildWorkspaceNotAccessibleText(runtime, workspaceRoot),
    });
    return;
  }
  if (!workspaceStats.isDirectory) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `路径存在，但不是目录：${workspaceRoot}`,
    });
    return;
  }

  applyDefaultCodexParamsOnBind(runtime, bindingKey, workspaceRoot);
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
  await runtime.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
  const existingThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  await showStatusPanel(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: existingThreadId ? "已切换到项目，并恢复原会话上下文。" : "已绑定项目。",
  });
}

async function handleWhereCommand(runtime, normalized) {
  await showStatusPanel(runtime, normalized);
}

async function handleDoctorCommand(runtime, normalized) {
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  const doctorText = await runtime.buildDoctorText({ bindingKey, workspaceRoot });
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: doctorText,
  });
}

async function handleGoalCommand(runtime, normalized) {
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  const rawGoal = extractGoalValue(normalized.text);
  const currentGoal = workspaceRoot
    ? runtime.sessionStore.getGoalForWorkspace(bindingKey, workspaceRoot)
    : runtime.sessionStore.getChatGoal(bindingKey);

  if (!rawGoal) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: workspaceRoot
        ? buildGoalCommandText(workspaceRoot, currentGoal)
        : buildChatGoalCommandText(currentGoal),
    });
    return;
  }

  if (rawGoal.trim().toLowerCase() === "clear") {
    if (workspaceRoot) {
      runtime.sessionStore.setGoalForWorkspace(bindingKey, workspaceRoot, "");
      await runtime.showStatusPanel(normalized, {
        replyToMessageId: normalized.messageId,
        noticeText: "已清除当前项目目标。",
      });
      return;
    }
    runtime.sessionStore.setChatGoal(bindingKey, "");
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `已清除当前会话目标。\n\n${buildChatGoalCommandText("")}`,
    });
    return;
  }

  if (workspaceRoot) {
    runtime.sessionStore.setGoalForWorkspace(bindingKey, workspaceRoot, rawGoal);
    await runtime.showStatusPanel(normalized, {
      replyToMessageId: normalized.messageId,
      noticeText: "已更新当前项目目标。",
    });
    return;
  }

  runtime.sessionStore.setChatGoal(bindingKey, rawGoal);
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: `已更新当前会话目标。\n\n${buildChatGoalCommandText(rawGoal)}`,
  });
}

async function handleScoreCommand(runtime, normalized) {
  await handleOptimizationSurfaceCommand(runtime, normalized, "score");
}

async function handleEvalCommand(runtime, normalized) {
  await handleOptimizationSurfaceCommand(runtime, normalized, "eval");
}

async function handleOptimizationSurfaceCommand(runtime, normalized, surface) {
  const capabilityHandler = runtime?.capabilities?.handleOptimizationCommand;
  const legacyHandler = runtime?.optimizationManager?.handleCommand;
  if (typeof capabilityHandler !== "function" && typeof legacyHandler !== "function") {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "优化记忆管理器尚未初始化。请先重启桥接进程。",
    });
    return;
  }
  if (typeof capabilityHandler === "function") {
    await capabilityHandler.call(runtime.capabilities, { surface, normalized, runtime });
    return;
  }
  await legacyHandler.call(runtime.optimizationManager, { surface, normalized, runtime });
}

async function showStatusPanel(runtime, normalized, { replyToMessageId, noticeText = "" } = {}) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, { replyToMessageId });
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot, replyTarget } = workspaceContext;

  const { threads, threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });
  const currentThread = threads.find((thread) => thread.id === threadId) || null;
  const recentThreads = currentThread
    ? threads.filter((thread) => thread.id !== threadId).slice(0, 2)
    : threads.slice(0, 3);
  const status = runtime.describeWorkspaceStatus(threadId);
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const goal = runtime.sessionStore.getGoalForWorkspace(bindingKey, workspaceRoot);
  const goalState = runtime.sessionStore.getGoalStateForWorkspace(bindingKey, workspaceRoot);
  const memoryStatus = typeof runtime.resolveEvolvingMemoryStatus === "function"
    ? await runtime.resolveEvolvingMemoryStatus({ bindingKey })
    : null;
  const availableCatalog = runtime.sessionStore.getAvailableModelCatalog();
  const availableModels = Array.isArray(availableCatalog?.models) ? availableCatalog.models : [];
  const modelOptions = buildModelSelectOptions(availableModels);
  const effortOptions = buildEffortSelectOptions(availableModels, codexParams?.model || "");
  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildStatusPanelCard({
      workspaceRoot,
      codexParams,
      goal,
      goalState,
      memoryStatus,
      modelOptions,
      effortOptions,
      threadId,
      currentThread,
      recentThreads,
      totalThreadCount: threads.length,
      status,
      noticeText,
    }),
  });
}

async function handleMessageCommand(runtime, normalized) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
  });
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const { threads, threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });

  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `当前项目：\`${workspaceRoot}\`\n\n该项目还没有可查看的线程消息。`,
    });
    return;
  }

  const currentThread = threads.find((thread) => thread.id === threadId) || { id: threadId };
  runtime.resumedThreadIds.delete(threadId);
  const resumeResponse = await runtime.ensureThreadResumed(threadId);
  const recentMessages = codexMessageUtils.extractRecentConversationFromResumeResponse(resumeResponse);

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: runtime.buildThreadMessagesSummary({
      workspaceRoot,
      thread: currentThread,
      recentMessages,
    }),
  });
}

async function handleHelpCommand(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: runtime.buildHelpCardText(runtime.config),
  });
}

async function handleSkillCommand(runtime, normalized) {
  await handleCloudAssetCommand(runtime, normalized, {
    kind: "skill",
    title: "技能",
    root: runtime.config.skillRoot,
    valueExtractor: extractSkillValue,
  });
}

async function handleCloudAssetCommand(runtime, normalized, { kind, title, root, valueExtractor }) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前项目还没有绑定可操作的工作区，请先用 `/codex bind /绝对路径` 绑定后再继续。",
  });
  if (!workspaceContext) {
    return;
  }

  const { bindingKey, workspaceRoot } = workspaceContext;
  const raw = String(valueExtractor(normalized.text) || "").trim();
  const currentState = runtime.sessionStore.getSkillStateForWorkspace(bindingKey, workspaceRoot);
  const assetRoot = String(root || "").trim();

  if (!raw || raw.toLowerCase() === "list") {
    const items = readAssetEntries(assetRoot);
    runtime.sessionStore.setSkillStateForWorkspace(bindingKey, workspaceRoot, {
      skillRoot: kind === "skill" ? assetRoot : currentState.skillRoot,
      pluginRoot: kind === "plugin" ? assetRoot : currentState.pluginRoot,
      skillItems: kind === "skill" ? items : currentState.skillItems,
      pluginItems: kind === "plugin" ? items : currentState.pluginItems,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatAssetListText(title, assetRoot, items),
    });
    return;
  }

  const [action, ...rest] = raw.split(/\s+/);
  const normalizedAction = String(action || "list").toLowerCase();
  const targetName = normalizeAssetName(rest.join(" "));

  if (normalizedAction === "create") {
    if (!targetName) {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `用法：\`/codex ${kind} create <name>\``,
      });
      return;
    }
    const result = createCloudAssetScaffold({ kind, root: assetRoot, name: targetName });
    const items = readAssetEntries(assetRoot);
    runtime.sessionStore.setSkillStateForWorkspace(bindingKey, workspaceRoot, {
      skillRoot: kind === "skill" ? assetRoot : currentState.skillRoot,
      pluginRoot: kind === "plugin" ? assetRoot : currentState.pluginRoot,
      skillItems: kind === "skill" ? items : currentState.skillItems,
      pluginItems: kind === "plugin" ? items : currentState.pluginItems,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: result.ok ? `${title}已创建：\`${result.path}\`` : result.errorText,
    });
    return;
  }

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: `不支持的${title}操作：${normalizedAction}`,
  });
}

async function handlePluginCommand(runtime, normalized) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前项目还未绑定。先发送 `/codex bind /绝对路径`。",
  });
  if (!workspaceContext) {
    return;
  }

  const { bindingKey, workspaceRoot } = workspaceContext;
  const currentState = runtime.sessionStore.getSkillStateForWorkspace(bindingKey, workspaceRoot);
  const pluginRoot = String(runtime.config.pluginRoot || "").trim();
  const marketplaceRoot = String(runtime.config.marketplaceRoot || "").trim();
  const marketplaceFile = marketplaceRoot ? path.join(marketplaceRoot, "marketplace.json") : "";
  const raw = String(extractPluginValue(normalized.text) || "").trim();

  if (!raw || raw.toLowerCase() === "list") {
    const items = listInstalledPlugins(pluginRoot);
    const marketplaceItems = listMarketplacePlugins(marketplaceFile);
    runtime.sessionStore.setSkillStateForWorkspace(bindingKey, workspaceRoot, {
      skillRoot: currentState.skillRoot,
      pluginRoot,
      skillItems: currentState.skillItems,
      pluginItems: items,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatPluginListText({ pluginRoot, marketplaceFile, items, marketplaceItems }),
    });
    return;
  }

  const segments = raw.split(/\s+/).filter(Boolean);
  const action = String(segments[0] || "").toLowerCase();
  const subject = segments.slice(1).join(" ");

  if (action === "install" || action === "installgithub") {
    const target = normalizePluginName(subject || (action === "installgithub" ? "github" : ""));
    if (target !== "github") {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前只内置了 GitHub 快速安装路径：`/codex plugin install github`。",
      });
      return;
    }
    const result = ensureGithubPluginInstall({ pluginRoot, marketplacePath: marketplaceFile, force: true });
    const items = listInstalledPlugins(pluginRoot);
    runtime.sessionStore.setSkillStateForWorkspace(bindingKey, workspaceRoot, {
      skillRoot: currentState.skillRoot,
      pluginRoot,
      skillItems: currentState.skillItems,
      pluginItems: items,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: result.ok
        ? [
          "GitHub 插件已安装/刷新。",
          `- Plugin: \`${result.pluginPath}\``,
          `- Manifest: \`${result.manifestPath}\``,
          `- Marketplace: \`${result.marketplacePath}\``,
          "",
          "下一步执行 `/codex reload` 或重启 Codex app-server，让远端重新读取插件根目录。",
        ].join("\n")
        : result.errorText,
    });
    return;
  }

  if (action === "manifest") {
    const target = normalizePluginName(subject);
    if (!target) {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "用法：`/codex plugin manifest <name>`",
      });
      return;
    }
    const pluginPath = path.join(pluginRoot, target);
    const manifestResult = ensurePluginManifest({
      pluginPath,
      pluginName: target,
      displayName: toDisplayName(target),
      description: `${toDisplayName(target)} plugin for Codex`,
      installSource: target === "github" ? "github" : "local",
      force: true,
    });
    const manifest = readPluginManifest(pluginPath);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: manifestResult.ok
        ? [
          `plugin manifest 已写入：\`${manifestResult.manifestPath}\``,
          "",
          `- name: ${manifest?.name || target}`,
          `- version: ${manifest?.version || ""}`,
          `- enabled: ${manifest?.enabled !== false}`,
          `- install_source: ${manifest?.install_source || ""}`,
          `- skills: ${manifest?.skills || ""}`,
          `- tools: ${manifest?.tools || ""}`,
          `- mcpServers: ${manifest?.mcpServers || ""}`,
        ].join("\n")
        : manifestResult.errorText,
    });
    return;
  }

  if (action === "marketplace") {
    const target = normalizePluginName(subject);
    if (!target) {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "用法：`/codex plugin marketplace <name>`",
      });
      return;
    }
    const result = ensureMarketplaceEntry(marketplaceFile, target);
    const install = describePluginInstall({
      pluginPath: path.join(pluginRoot, target),
      manifestPath: path.join(pluginRoot, target, ".codex-plugin", "plugin.json"),
      marketplacePath: marketplaceFile,
      pluginName: target,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: result.ok
        ? [
          `marketplace 已写入：\`${marketplaceFile}\``,
          "",
          `- plugin: ${install.pluginName}`,
          `- installed: ${install.installed ? "yes" : "no"}`,
          `- marketplace linked: ${install.marketplaceLinked ? "yes" : "no"}`,
          `- source path: ${install.marketplaceEntry?.source?.path || `./plugins/${target}`}`,
        ].join("\n")
        : result.errorText,
    });
    return;
  }

  if (action === "create") {
    const targetName = normalizePluginName(subject);
    if (!targetName) {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "用法：`/codex plugin create <name>`",
      });
      return;
    }
    const result = ensurePluginSkeleton({
      pluginRoot,
      pluginName: targetName,
      displayName: toDisplayName(targetName),
      description: `${toDisplayName(targetName)} plugin for Codex`,
      installSource: "local",
      force: false,
    });
    const marketplaceResult = ensureMarketplaceEntry(marketplaceFile, targetName);
    const items = listInstalledPlugins(pluginRoot);
    runtime.sessionStore.setSkillStateForWorkspace(bindingKey, workspaceRoot, {
      skillRoot: currentState.skillRoot,
      pluginRoot,
      skillItems: currentState.skillItems,
      pluginItems: items,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: result.ok
        ? [
          `插件已创建：\`${result.pluginPath}\``,
          `- manifest: \`${result.manifestPath}\``,
          `- marketplace: \`${marketplaceResult.path || marketplaceFile}\``,
          "",
          "下一步执行 `/codex reload` 或重启 Codex app-server，让远端重新读取插件根目录。",
        ].join("\n")
        : result.errorText,
    });
    return;
  }

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: `不支持的插件操作：${action}`,
  });
}

async function handleUnknownCommand(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: "无效的 Codex 命令。\n\n可使用 `/codex help` 查看命令教程。",
  });
}

async function handleSendCommand(runtime, normalized) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
  });
  if (!workspaceContext) {
    return;
  }
  const { workspaceRoot } = workspaceContext;

  const requestedPath = extractSendPath(normalized.text);
  if (!requestedPath) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法：`/codex send <当前项目下的相对文件路径>`",
    });
    return;
  }

  const resolvedTarget = resolveWorkspaceSendTarget(workspaceRoot, requestedPath);
  if (resolvedTarget.errorText) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: resolvedTarget.errorText,
    });
    return;
  }

  let fileStats;
  try {
    fileStats = await fs.promises.stat(resolvedTarget.filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `文件不存在：${resolvedTarget.displayPath}`,
      });
      return;
    }
    throw error;
  }

  if (!fileStats.isFile()) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `只支持发送文件，不支持目录：${resolvedTarget.displayPath}`,
    });
    return;
  }

  if (fileStats.size <= 0) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `文件为空，无法发送：${resolvedTarget.displayPath}`,
    });
    return;
  }

  const attachmentKind = classifyLocalAttachment(resolvedTarget.filePath);
  const maxUploadBytes = attachmentKind === "image"
    ? MAX_FEISHU_UPLOAD_IMAGE_BYTES
    : MAX_FEISHU_UPLOAD_FILE_BYTES;
  const uploadLimitLabel = attachmentKind === "image" ? "10MB" : "30MB";
  if (fileStats.size > maxUploadBytes) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `文件过大，飞书当前只支持发送 ${uploadLimitLabel} 以内${attachmentKind === "image" ? "图片" : "文件"}：${resolvedTarget.displayPath}`,
    });
    return;
  }

  try {
    const fileBuffer = await fs.promises.readFile(resolvedTarget.filePath);
    const fileType = inferFeishuFileType(resolvedTarget.filePath);
    await runtime.sendLocalAttachmentToFeishu({
      kind: attachmentKind,
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      fileName: path.basename(resolvedTarget.filePath),
      fileBuffer,
      fileType,
      msgType: attachmentKind === "audio" ? "audio" : "file",
    });
    console.log(`[codex-im] attachment/send ok kind=${attachmentKind} workspace=${workspaceRoot} path=${resolvedTarget.displayPath}`);
  } catch (error) {
    console.warn(
      `[codex-im] attachment/send failed workspace=${workspaceRoot} path=${resolvedTarget.displayPath}: ${error.message}`
    );
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("发送附件失败", error),
    });
  }
}

async function handleModelCommand(runtime, normalized) {
  const workspaceContext = await resolveCodexSettingWorkspaceContext(runtime, normalized);
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const rawModel = extractModelValue(normalized.text);
  if (!rawModel) {
    const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const availableModelsResult = await loadAvailableModels(runtime, { forceRefresh: false });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelInfoText(workspaceRoot, current, availableModelsResult),
    });
    return;
  }

  const modelUpdateDirective = parseUpdateDirective(rawModel);
  if (modelUpdateDirective) {
    const availableModelsResult = await loadAvailableModels(runtime, { forceRefresh: true });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelListText(workspaceRoot, availableModelsResult, { refreshed: true }),
    });
    return;
  }

  const availableModelsResult = await loadAvailableModelsForSetting(runtime, normalized, { settingType: "model" });
  if (!availableModelsResult) {
    return;
  }

  const resolvedModel = resolveRequestedModel(availableModelsResult.models, rawModel);
  if (!resolvedModel) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelValidationErrorText(workspaceRoot, rawModel, availableModelsResult.models),
    });
    return;
  }

  const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: resolvedModel,
    effort: current.effort || "",
    accessMode: current.accessMode || "",
  });
  await runtime.showStatusPanel(normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: `已设置模型：${resolvedModel}`,
  });
}

async function handleEffortCommand(runtime, normalized) {
  const workspaceContext = await resolveCodexSettingWorkspaceContext(runtime, normalized);
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const rawEffort = extractEffortValue(normalized.text);
  if (!rawEffort) {
    const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const availableModelsResult = await loadAvailableModels(runtime, { forceRefresh: false });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildEffortInfoText(workspaceRoot, current, availableModelsResult),
    });
    return;
  }

  const availableModelsResult = await loadAvailableModelsForSetting(runtime, normalized, { settingType: "effort" });
  if (!availableModelsResult) {
    return;
  }

  const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const effectiveModel = resolveEffectiveModelForEffort(availableModelsResult.models, current.model);
  if (!effectiveModel) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前无法确定模型，请先执行 `/codex model` 并设置模型后再设置推理强度。",
    });
    return;
  }

  const resolvedEffort = resolveRequestedEffort(effectiveModel, rawEffort);
  if (!resolvedEffort) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildEffortValidationErrorText(workspaceRoot, effectiveModel, rawEffort),
    });
    return;
  }

  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: current.model || "",
    effort: resolvedEffort,
    accessMode: current.accessMode || "",
  });
  await runtime.showStatusPanel(normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: `已设置推理强度：${resolvedEffort}`,
  });
}

async function handleAccessCommand(runtime, normalized) {
  const workspaceContext = await resolveCodexSettingWorkspaceContext(runtime, normalized);
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;
  const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);

  const rawAccess = extractAccessValue(normalized.text);
  if (!rawAccess) {
    const effectiveAccess = current.accessMode || normalizeAccessMode(runtime.config.defaultCodexAccessMode) || "default";
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        `当前项目：\`${workspaceRoot}\``,
        `访问模式：${effectiveAccess}`,
        "",
        "用法：",
        "`/codex access`",
        "`/codex access default`",
        "`/codex access full-access`",
      ].join("\n"),
    });
    return;
  }

  const resolvedAccess = normalizeAccessMode(rawAccess);
  if (!resolvedAccess) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "无效的访问模式。可选：`default` 或 `full-access`。",
    });
    return;
  }

  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: current.model || "",
    effort: current.effort || "",
    accessMode: resolvedAccess,
  });
  await runtime.showStatusPanel(normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: `已设置访问模式：${resolvedAccess}`,
  });
}

async function handleWorkspacesCommand(runtime, normalized, { replyToMessageId } = {}) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  if (!items.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: buildMissingWorkspaceBindingText(),
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildWorkspaceBindingsCard(items),
  });
}

async function showThreadPicker(runtime, normalized, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: buildMissingWorkspaceBindingText(),
    });
    return;
  }

  const threads = await runtime.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot) || threads[0]?.id || "";
  if (!threads.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: `当前项目：\`${workspaceRoot}\`\n\n还没有可切换的历史线程。`,
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildThreadPickerCard({ workspaceRoot, threads, currentThreadId }),
  });
}

async function handleRemoveCommand(runtime, normalized) {
  const workspaceRoot = extractRemoveWorkspacePath(normalized.text);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法：`/codex remove /绝对路径`",
    });
    return;
  }

  if (!isAbsoluteWorkspacePath(workspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "路径必须是绝对路径。",
    });
    return;
  }

  await removeWorkspaceByPath(runtime, normalized, workspaceRoot, {
    replyToMessageId: normalized.messageId,
  });
}

async function switchWorkspaceByPath(runtime, normalized, workspaceRoot, { replyToMessageId } = {}) {
  const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "目标项目无效，请刷新后重试。",
    });
    return;
  }

  const { bindingKey } = runtime.getBindingContext(normalized);
  const currentWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "已经是当前项目，无需切换。",
    });
    return;
  }

  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "该项目未绑定到当前会话，请先执行 `/codex bind /绝对路径`。",
    });
    return;
  }

  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, targetWorkspaceRoot);
  await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot: targetWorkspaceRoot,
    normalized,
    autoSelectThread: true,
  });
  await handleWorkspacesCommand(runtime, normalized, {
    replyToMessageId: replyToMessageId || normalized.messageId,
  });
}

async function removeWorkspaceByPath(runtime, normalized, workspaceRoot, { replyToMessageId } = {}) {
  const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "目标项目无效，请刷新后重试。",
    });
    return;
  }

  const { bindingKey } = runtime.getBindingContext(normalized);
  const currentWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "该项目未绑定到当前会话，无需移除。",
    });
    return;
  }

  if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
    const fallbackWorkspaceRoot = items.find((item) => item.workspaceRoot !== targetWorkspaceRoot)?.workspaceRoot || "";
    if (fallbackWorkspaceRoot) {
      runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, fallbackWorkspaceRoot);
      await runtime.resolveWorkspaceThreadState({
        bindingKey,
        workspaceRoot: fallbackWorkspaceRoot,
        normalized,
        autoSelectThread: true,
      });
    }
  }

  runtime.sessionStore.removeWorkspace(bindingKey, targetWorkspaceRoot);
  const nextWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (nextWorkspaceRoot) {
    await runtime.showStatusPanel(normalized, {
      replyToMessageId: replyToMessageId || normalized.messageId,
      noticeText: "已移除项目，并切换到仍绑定的项目。",
    });
    return;
  }

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: replyToMessageId || normalized.messageId,
    text: buildWorkspaceRemovedText(targetWorkspaceRoot),
  });
}

function readAssetEntries(root) {
  if (!root) {
    return [];
  }
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function createCloudAssetScaffold({ kind, root, name }) {
  if (!root) {
    return { ok: false, errorText: "资产根目录未配置。" };
  }
  const basePath = path.join(root, name);
  fs.mkdirSync(basePath, { recursive: true });
  if (kind === "skill") {
    fs.writeFileSync(path.join(basePath, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`);
  }
  if (kind === "plugin") {
    fs.mkdirSync(path.join(basePath, ".codex-plugin"), { recursive: true });
    const manifest = {
      name,
      version: "0.1.0",
      description: `${name} plugin`,
      license: "MIT",
      interface: {
        displayName: name,
        shortDescription: `${name} plugin`,
        longDescription: `${name} plugin`,
        developerName: "Codex",
        category: "Productivity",
      },
    };
    fs.writeFileSync(path.join(basePath, ".codex-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { ok: true, path: basePath };
}

function formatAssetListText(title, root, items) {
  return [
    `${title}根目录：\`${root || "未配置"}\``,
    "",
    items.length ? items.map((item) => `- ${item}`).join("\n") : "当前没有可展示的条目。",
  ].join("\n");
}

function formatPluginListText({ pluginRoot, marketplaceFile, items, marketplaceItems }) {
  return [
    `插件目录：\`${pluginRoot || "未配置"}\``,
    `Marketplace：\`${marketplaceFile || "未配置"}\``,
    "",
    "**磁盘已安装**",
    items.length ? items.map((item) => `- ${item}`).join("\n") : "- 无",
    "",
    "**Marketplace 可见**",
    marketplaceItems.length
      ? marketplaceItems
        .map((item) => `- ${item.name} (${item.installation || "AVAILABLE"} / ${item.authentication || "ON_INSTALL"})`)
        .join("\n")
      : "- 无",
  ].join("\n");
}

function normalizeAssetName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildWorkspacePathStyleMismatchText(runtime, workspaceRoot) {
  const instanceLabel = runtime.describeInstanceLabel();
  const platformLabel = formatRuntimePlatformLabel(process.platform);
  return [
    `当前实例：${instanceLabel}`,
    `运行系统：${platformLabel}`,
    "",
    `这个路径风格和当前运行系统不匹配：\`${workspaceRoot}\``,
    "请在飞书 bot 实际运行的机器上绑定可访问的绝对路径。",
  ].join("\n");
}

function buildMissingWorkspaceBindingText() {
  return "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。";
}

function buildGoalCommandText(workspaceRoot, goal) {
  return [
    `当前项目：\`${workspaceRoot}\``,
    `项目目标：${goal || "未设置"}`,
    "",
    "说明：设置后，后续像“继续”“下一步”“接着做”这类短消息会默认按当前目标持续推进。",
    "",
    "用法：",
    "`/goal <目标内容>`",
    "`/goal clear`",
  ].join("\n");
}

function buildChatGoalCommandText(goal) {
  return [
    "当前会话：未绑定项目时的飞书聊天窗口",
    `会话目标：${goal || "未设置"}`,
    "",
    "说明：设置后，后续像“继续”“下一步”“接着做”这类短消息会默认按当前目标持续推进。",
    "",
    "用法：",
    "`/goal <目标内容>`",
    "`/goal clear`",
  ].join("\n");
}

function buildWorkspaceNotAccessibleText(runtime, workspaceRoot) {
  const instanceLabel = runtime.describeInstanceLabel();
  const platformLabel = formatRuntimePlatformLabel(process.platform);
  return [
    `当前实例：${instanceLabel}`,
    `运行系统：${platformLabel}`,
    "",
    `当前执行层无法访问这个路径：\`${workspaceRoot}\``,
    "请确认路径存在于飞书 bot 运行的机器上，并且进程有读取权限。",
  ].join("\n");
}

function buildWorkspaceRemovedText(workspaceRoot) {
  return [
    `已移除项目：\`${workspaceRoot}\``,
    "",
    buildMissingWorkspaceBindingText(),
  ].join("\n");
}

function resolveWorkspaceSendTarget(workspaceRoot, requestedPath) {
  const normalizedInput = normalizeWorkspacePath(requestedPath);
  if (!normalizedInput) {
    return { errorText: "用法：`/codex send <当前项目下的相对文件路径>`" };
  }
  if (isAbsoluteWorkspacePath(normalizedInput)) {
    return { errorText: "只支持当前项目下的相对路径，不支持绝对路径。" };
  }

  const filePath = path.resolve(workspaceRoot, requestedPath);
  const normalizedResolvedPath = normalizeWorkspacePath(filePath);
  if (!pathMatchesWorkspaceRoot(normalizedResolvedPath, workspaceRoot)) {
    return { errorText: "文件路径超出了当前项目根目录。" };
  }

  return {
    filePath,
    displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, filePath)) || path.basename(filePath),
  };
}

function parseUpdateDirective(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "update" ? { forceRefresh: true } : null;
}

function applyDefaultCodexParamsOnBind(runtime, bindingKey, workspaceRoot) {
  const current = runtime.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  if (current.model || current.effort || current.accessMode) {
    return;
  }

  const availableCatalog = runtime.sessionStore.getAvailableModelCatalog();
  const availableModels = Array.isArray(availableCatalog?.models) ? availableCatalog.models : [];
  const validatedDefaults = validateDefaultCodexParamsConfig(runtime, availableModels);
  if (!validatedDefaults.model && !validatedDefaults.effort && !validatedDefaults.accessMode) {
    return;
  }

  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, validatedDefaults);
}

function validateDefaultCodexParamsConfig(runtime, modelsInput) {
  const models = Array.isArray(modelsInput) ? modelsInput : [];
  const rawModel = normalizeText(runtime.config.defaultCodexModel);
  const rawEffort = normalizeEffort(runtime.config.defaultCodexEffort);
  const rawAccessMode = normalizeAccessMode(runtime.config.defaultCodexAccessMode);
  const result = { model: "", effort: "", accessMode: rawAccessMode };
  if (!rawModel && !rawEffort) {
    return result;
  }
  if (!models.length) {
    return result;
  }

  if (rawModel) {
    result.model = resolveRequestedModel(models, rawModel);
  }

  if (rawEffort) {
    const effectiveModel = resolveEffectiveModelForEffort(models, result.model || rawModel);
    if (effectiveModel) {
      result.effort = resolveRequestedEffort(effectiveModel, rawEffort);
    }
  }

  return result;
}

async function resolveCodexSettingWorkspaceContext(runtime, normalized) {
  return resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: buildMissingWorkspaceBindingText(),
  });
}

function normalizeEffort(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccessMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "default" || normalized === "full-access") {
    return normalized;
  }
  return "";
}

async function loadAvailableModelsForSetting(runtime, normalized, { settingType }) {
  const availableModelsResult = await loadAvailableModels(runtime, { forceRefresh: false });
  if (!availableModelsResult.error) {
    return availableModelsResult;
  }
  const isEffort = settingType === "effort";
  const actionLabel = isEffort ? "推理强度" : "模型";
  const listCommand = isEffort ? "/codex effort" : "/codex model";
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      `无法设置${actionLabel}：${availableModelsResult.error}`,
      "",
      `请先执行 \`${listCommand}\`，确认可用${actionLabel}后重试。`,
    ].join("\n"),
  });
  return null;
}

async function loadAvailableModels(runtime, { forceRefresh = false } = {}) {
  const cached = runtime.sessionStore.getAvailableModelCatalog();
  if (!forceRefresh && cached?.models?.length) {
    return {
      models: cached.models,
      error: "",
      source: "cache",
      updatedAt: cached.updatedAt || "",
    };
  }

  try {
    const response = await runtime.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      if (cached?.models?.length) {
        return {
          models: cached.models,
          error: "",
          source: "cache",
          updatedAt: cached.updatedAt || "",
          warning: "Codex 未返回模型列表，已回退本地缓存。",
        };
      }
      return {
        models: [],
        error: "Codex 未返回可用模型列表。",
        source: forceRefresh ? "refresh" : "live",
        updatedAt: "",
      };
    }
    const saved = runtime.sessionStore.setAvailableModelCatalog(models);
    return {
      models,
      error: "",
      source: forceRefresh ? "refresh" : "live",
      updatedAt: saved?.updatedAt || new Date().toISOString(),
    };
  } catch (error) {
    if (cached?.models?.length) {
      return {
        models: cached.models,
        error: "",
        source: "cache",
        updatedAt: cached.updatedAt || "",
        warning: `拉取失败，已回退本地缓存：${error?.message || "未知错误"}`,
      };
    }
    return {
      models: [],
      error: error?.message || "获取模型列表失败。",
      source: forceRefresh ? "refresh" : "live",
      updatedAt: "",
    };
  }
}

function resolveRequestedModel(models, rawInput) {
  const matched = findModelByQuery(models, rawInput);
  return matched?.model || matched?.id || "";
}

function resolveRequestedEffort(modelEntry, rawEffort) {
  if (!modelEntry) {
    return "";
  }
  const query = normalizeEffort(rawEffort);
  if (!query) {
    return "";
  }
  const availableEfforts = listModelEfforts(modelEntry, { withDefaultFallback: true });
  for (const effort of availableEfforts) {
    if (normalizeEffort(effort) === query) {
      return effort;
    }
  }
  return "";
}

function buildModelSelectOptions(models) {
  if (!Array.isArray(models) || !models.length) {
    return [];
  }
  return models
    .map((item) => normalizeText(item?.model))
    .filter(Boolean)
    .slice(0, 100)
    .map((model) => ({
      label: model,
      value: model,
    }));
}

function buildEffortSelectOptions(models, currentModel) {
  const effectiveModel = resolveEffectiveModelForEffort(models, currentModel);
  if (!effectiveModel) {
    return [];
  }
  const supported = listModelEfforts(effectiveModel, { withDefaultFallback: true });
  const options = [];
  const seen = new Set();
  for (const effort of supported) {
    const normalized = normalizeText(effort);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({ label: normalized, value: normalized });
  }
  return options.slice(0, 20);
}

function listModelEfforts(modelEntry, { withDefaultFallback = false } = {}) {
  const supported = Array.isArray(modelEntry?.supportedReasoningEfforts)
    ? modelEntry.supportedReasoningEfforts
    : [];
  if (supported.length) {
    return supported;
  }
  if (!withDefaultFallback) {
    return [];
  }
  const defaultEffort = normalizeText(modelEntry?.defaultReasoningEffort);
  return defaultEffort ? [defaultEffort] : [];
}

module.exports = {
  handleAccessCommand,
  handleBindCommand,
  handleDoctorCommand,
  handleEffortCommand,
  handleEvalCommand,
  handleGoalCommand,
  handleHelpCommand,
  handleMessageCommand,
  handleModelCommand,
  handlePluginCommand,
  handleRemoveCommand,
  handleScoreCommand,
  handleSendCommand,
  handleSkillCommand,
  handleUnknownCommand,
  handleWhereCommand,
  handleWorkspacesCommand,
  removeWorkspaceByPath,
  resolveWorkspaceContext,
  showStatusPanel,
  showThreadPicker,
  switchWorkspaceByPath,
  validateDefaultCodexParamsConfig,
};

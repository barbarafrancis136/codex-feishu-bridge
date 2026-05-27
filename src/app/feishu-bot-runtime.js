const { readConfig } = require("../infra/config/config");
const { SessionStore } = require("../infra/storage/session-store");
const { CodexRpcClient } = require("../infra/codex/rpc-client");
const {
  buildCardResponse,
  buildCardToast,
  buildEffortInfoText,
  buildEffortListText,
  buildEffortValidationErrorText,
  buildHelpCardText,
  buildModelInfoText,
  buildModelListText,
  buildModelValidationErrorText,
  buildStatusPanelCard,
  buildThreadMessagesSummary,
  buildThreadPickerCard,
  buildWorkspaceBindingsCard,
  listBoundWorkspaces,
} = require("../presentation/card/builders");
const {
  addPendingReaction,
  clearPendingReactionForBinding,
  clearPendingReactionForThread,
  disposeReplyRunState,
  flushAllAssistantReplyCards,
  flushAssistantReplyCardNow,
  handleCardAction,
  movePendingReactionToThread,
  patchInteractiveCard,
  queueCardActionWithFeedback,
  runCardActionTask,
  sendCardActionFeedback,
  sendCardActionFeedbackByContext,
  sendInfoCardMessage,
  sendPluginRouteCardMessage,
  sendInteractiveApprovalCard,
  sendInteractiveCard,
  updateInteractiveCard,
  upsertAssistantReplyCard,
} = require("../presentation/card/card-service");
const {
  FeishuClientAdapter,
  patchWsClientForCardCallbacks,
} = require("../infra/feishu/client-adapter");
const runtimeCommands = require("./command-dispatcher");
const approvalRuntime = require("../domain/approval/approval-service");
const runtimeState = require("../domain/session/binding-context");
const threadRuntime = require("../domain/thread/thread-service");
const workspaceRuntime = require("../domain/workspace/workspace-service");
const runtimeExtensions = require("./runtime-extensions");
const eventsRuntime = require("./codex-event-service");
const approvalPolicyRuntime = require("../domain/approval/approval-policy");
const appDispatcher = require("./dispatcher");
const { createCapabilityRegistry } = require("./capability-registry");
const { extractModelCatalogFromListResponse } = require("../shared/model-catalog");
const { extractProfileValue } = require("../shared/command-parsing");
const { createLogger } = require("../shared/logger");
const { formatRuntimePlatformLabel } = require("../shared/workspace-paths");
const {
  summarizeDirectoryFiles,
  normalizePositiveInt,
  formatBytes,
} = require("../shared/attachment-cache-stats");
const {
  listInstalledPlugins,
  listMarketplacePlugins,
} = require("../infra/plugins/plugin-registry");
const fs = require("fs");
const os = require("os");
const path = require("path");
const logger = createLogger("runtime");

function readTruthyEnvFlag(name) {
  return typeof process.env[name] === "string"
    ? ["1", "true", "yes", "on"].includes(process.env[name].trim().toLowerCase())
    : false;
}

function formatCapabilityVerificationStatus(enabled, unavailableLabel = "未验证") {
  return enabled ? "已验证" : unavailableLabel;
}

function buildMemoryUserIdFromBindingKey(bindingKey) {
  const match = String(bindingKey || "").match(/:sender:([^:]+)$/);
  const senderId = match?.[1] ? String(match[1]).trim() : "";
  if (!senderId) {
    return "";
  }
  const prefix = String(process.env.MEM0_USER_ID_PREFIX || "feishu").trim() || "feishu";
  return `${prefix}:${senderId}`;
}

function buildEvolvingMemoryDoctorLines(memoryStatus) {
  const status = memoryStatus && typeof memoryStatus === "object" ? memoryStatus : {};
  return [
    "**进化记忆**",
    `- 扩展文件：\`${escapeInline(status.extensionFile || "(not configured)")}\``,
    `- 已启用：${status.enabled ? "是" : "否"}`,
    `- Mem0 语义层：${status.mem0Enabled ? "是" : "否"}`,
    `- 存储文件：\`${escapeInline(status.storeFile || "(not configured)")}\``,
    `- 可访问：${status.accessible ? "是" : "否"}`,
    `- 已记忆用户：${Number.isFinite(status.totalUserCount) ? status.totalUserCount : 0}`,
    `- 记忆条数：${Number.isFinite(status.totalMemoryCount) ? status.totalMemoryCount : 0}`,
    `- 当前用户条数：${status.currentUserId ? (Number.isFinite(status.currentUserMemoryCount) ? status.currentUserMemoryCount : 0) : "无法识别当前用户"}`,
    `- 当前用户画像：${status.profileSummary ? status.profileSummary : "未形成"}`,
    ...(status.error ? [`- 读取错误：${escapeInline(status.error)}`] : []),
  ];
}


const CODEX_APP_SERVER_PROFILES = Object.freeze({
  main: "",
  default: "",
  openai: "",
  ...runtimeExtensions.codexProfiles.profiles,
});

class FeishuBotRuntime {
  constructor(config = readConfig()) {
    this.config = config;
    this.sessionStore = new SessionStore({ filePath: config.sessionsFile });
    this.capabilities = createCapabilityRegistry({
      config,
      sessionsFile: config.sessionsFile,
      instanceLabel: config.instanceLabel || "default",
    });
    this.optimizationManager = this.capabilities.optimizationManager;
    this.codex = new CodexRpcClient({
      endpoint: config.codexEndpoint,
      env: process.env,
      codexCommand: config.codexCommand,
      appServerProfile: config.codexAppServerProfile,
      requestTimeoutMs: config.codexRpcTimeoutMs,
      turnStartTimeoutMs: config.codexTurnStartTimeoutMs,
    });
    this.codexAppServerProfile = config.codexAppServerProfile || "";
    this.lark = null;
    this.client = null;
    this.wsClient = null;
    this.feishuAdapter = null;
    this.pendingChatContextByThreadId = new Map();
    this.pendingChatContextByBindingKey = new Map();
    this.activeTurnIdByThreadId = new Map();
    this.activeTurnStartedAtByThreadId = new Map();
    this.pendingApprovalByThreadId = new Map();
    this.replyCardByRunKey = new Map();
    this.currentRunKeyByThreadId = new Map();
    this.replyFlushTimersByRunKey = new Map();
    this.replyFlushInFlightByRunKey = new Map();
    this.replyFlushQueuedByRunKey = new Set();
    this.latestTokenUsageByThreadId = new Map();
    this.toolItemIdsByRunKey = new Map();
    this.toolTraceByRunKey = new Map();
    this.assistantDeltaSeenByRunKey = new Map();
    this.hiddenGoalDirectiveStateByRunKey = new Map();
    this.pendingReactionByBindingKey = new Map();
    this.pendingReactionByThreadId = new Map();
    this.bindingKeyByThreadId = new Map();
    this.workspaceRootByThreadId = new Map();
    this.approvalAllowlistByWorkspaceRoot = new Map();
    this.inFlightApprovalRequestKeys = new Set();
    this.sentAttachmentDirectiveKeys = new Set();
    this.resumedThreadIds = new Set();
    this.staleTurnWatchdog = null;
    this.shutdownPromise = null;
    this.extensions = runtimeExtensions;
    this.codex.onMessage((message) => appDispatcher.onCodexMessage(this, message));
  }

  async start() {
    this.validateConfig();
    this.initializeFeishuSdk();
    await this.codex.connect();
    await this.codex.initialize();
    await this.refreshAvailableModelCatalogAtStartup();
    this.startLongConnection();
    this.startStaleTurnWatchdog();
    await this.capabilities.start(this);
    logger.info("feishu-bot runtime ready", {
      appId: maskSecret(this.config.feishu.appId),
    });
  }

  validateConfig() {
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required for feishu-bot mode");
    }
    if (!String(this.config.defaultCodexModel || "").trim()) {
      throw new Error("CODEX_IM_DEFAULT_CODEX_MODEL is required");
    }
    if (!String(this.config.defaultCodexEffort || "").trim()) {
      throw new Error("CODEX_IM_DEFAULT_CODEX_EFFORT is required");
    }
    if (!String(this.config.defaultCodexAccessMode || "").trim()) {
      throw new Error(
        "CODEX_IM_DEFAULT_CODEX_ACCESS_MODE is required and must be one of: default, full-access"
      );
    }
  }

  initializeFeishuSdk() {
    try {
      // Official SDK: https://github.com/larksuite/node-sdk
      this.lark = require("@larksuiteoapi/node-sdk");
    } catch {
      throw new Error(
        "Missing @larksuiteoapi/node-sdk. Run `npm install` in codex-im before starting feishu-bot mode."
      );
    }

    this.client = new this.lark.Client({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      appType: this.lark.AppType.SelfBuild,
      domain: this.lark.Domain.Feishu,
      loggerLevel: this.lark.LoggerLevel.info,
    });

    this.wsClient = new this.lark.WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      appType: this.lark.AppType.SelfBuild,
      domain: this.lark.Domain.Feishu,
      loggerLevel: this.lark.LoggerLevel.info,
      wsConfig: {
        PingInterval: 30,
        PingTimeout: 5,
      },
    });
    this.feishuAdapter = new FeishuClientAdapter(this.client);
    patchWsClientForCardCallbacks(this.wsClient);
  }

  startLongConnection() {
    const eventDispatcher = new this.lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        appDispatcher.onFeishuTextEvent(this, data).catch((error) => {
          logger.error("failed to process Feishu message", { error });
        });
      },
      "card.action.trigger": async (data) => appDispatcher.onFeishuCardAction(this, data),
    });

    this.wsClient.start({ eventDispatcher });
    logger.info("Feishu long connection started");
  }

  async refreshAvailableModelCatalogAtStartup() {
    const response = await this.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      throw new Error("model/list returned no models at startup");
    }
    this.sessionStore.setAvailableModelCatalog(models);
    const validatedDefaults = workspaceRuntime.validateDefaultCodexParamsConfig(this, models);
    if (!validatedDefaults.model) {
      throw new Error(`Invalid CODEX_IM_DEFAULT_CODEX_MODEL: ${this.config.defaultCodexModel}`);
    }
    if (!validatedDefaults.effort) {
      throw new Error(
        `Invalid CODEX_IM_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${validatedDefaults.model}`
      );
    }
    logger.info("model catalog refreshed at startup", { modelCount: models.length });
  }

  startStaleTurnWatchdog() {
    const timeoutMs = Number(this.config.staleTurnTimeoutMs || 0);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || this.staleTurnWatchdog) {
      return;
    }
    const intervalMs = Math.max(30000, Math.min(60000, Math.floor(timeoutMs / 3)));
    this.staleTurnWatchdog = setInterval(() => {
      this.clearStaleTurns(timeoutMs).catch((error) => {
        logger.error("stale turn watchdog failed", { error });
      });
    }, intervalMs);
    if (typeof this.staleTurnWatchdog.unref === "function") {
      this.staleTurnWatchdog.unref();
    }
  }

  async clearStaleTurns(timeoutMs) {
    const now = Date.now();
    for (const [threadId, startedAt] of this.activeTurnStartedAtByThreadId.entries()) {
      if (!startedAt || now - startedAt < timeoutMs) {
        continue;
      }
      const context = this.pendingChatContextByThreadId.get(threadId);
      const turnId = this.activeTurnIdByThreadId.get(threadId) || "";
      logger.warn("stale turn detected", { threadId, turnId });
      this.cleanupThreadRuntimeState(threadId);
      if (context?.chatId) {
        await this.sendInfoCardMessage({
          chatId: context.chatId,
          replyToMessageId: context.messageId,
          text: "检测到 Codex 长时间没有返回完成事件，我已清理飞书端运行状态。可以继续发消息；如果上一个任务仍在终端侧运行，先发 `/codex stop` 再继续更稳。",
        });
      }
    }
  }

  resolveReplyToMessageId(normalized, replyToMessageId = "") {
    return replyToMessageId || normalized.messageId;
  }

  getBindingContext(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    let workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      workspaceRoot = this.inheritThreadBindingFromSender(normalized, bindingKey);
    }
    return { bindingKey, workspaceRoot };
  }

  inheritThreadBindingFromSender(normalized, bindingKey) {
    const threadKey = typeof normalized?.threadKey === "string" ? normalized.threadKey.trim() : "";
    const messageId = typeof normalized?.messageId === "string" ? normalized.messageId.trim() : "";
    const hasStableThreadKey = threadKey && threadKey !== messageId;
    if (!hasStableThreadKey) {
      return "";
    }

    const senderBindingKey = this.sessionStore.buildBindingKey({
      ...normalized,
      threadKey: "",
      messageId: "",
    });
    if (!senderBindingKey || senderBindingKey === bindingKey) {
      return "";
    }

    const inheritedChatThreadId = this.sessionStore.getChatThreadId(senderBindingKey);
    const inheritedChatGoal = this.sessionStore.getChatGoal(senderBindingKey);
    const inheritedChatGoalState = this.sessionStore.getChatGoalState(senderBindingKey);
    const inheritedWorkspaceRoot = this.resolveWorkspaceRootForBinding(senderBindingKey);
    if (!inheritedWorkspaceRoot && !inheritedChatThreadId && !inheritedChatGoal && !hasGoalState(inheritedChatGoalState)) {
      return "";
    }

    const inheritedMetadata = {
      workspaceId: normalized.workspaceId,
      chatId: normalized.chatId,
      threadKey: normalized.threadKey,
      senderId: normalized.senderId,
      inheritedFromBindingKey: senderBindingKey,
      threadScopedBinding: true,
    };

    if (inheritedChatThreadId) {
      this.sessionStore.setChatThreadId(bindingKey, inheritedChatThreadId, inheritedMetadata);
    }
    if (inheritedChatGoal) {
      this.sessionStore.setChatGoal(bindingKey, inheritedChatGoal);
    }
    if (hasGoalState(inheritedChatGoalState)) {
      this.sessionStore.setChatGoalState(bindingKey, inheritedChatGoalState);
    }
    if (!inheritedWorkspaceRoot) {
      return "";
    }

    const inheritedParams = this.sessionStore.getCodexParamsForWorkspace(
      senderBindingKey,
      inheritedWorkspaceRoot
    );
    const inheritedWorkspaceGoal = this.sessionStore.getGoalForWorkspace(senderBindingKey, inheritedWorkspaceRoot);
    const inheritedWorkspaceGoalState = this.sessionStore.getGoalStateForWorkspace(
      senderBindingKey,
      inheritedWorkspaceRoot
    );

    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      inheritedWorkspaceRoot,
      "",
      inheritedMetadata
    );
    if (inheritedParams.model || inheritedParams.effort) {
      this.sessionStore.setCodexParamsForWorkspace(bindingKey, inheritedWorkspaceRoot, inheritedParams);
    }
    if (inheritedWorkspaceGoal) {
      this.sessionStore.setGoalForWorkspace(bindingKey, inheritedWorkspaceRoot, inheritedWorkspaceGoal);
    }
    if (hasGoalState(inheritedWorkspaceGoalState)) {
      this.sessionStore.setGoalStateForWorkspace(bindingKey, inheritedWorkspaceRoot, inheritedWorkspaceGoalState);
    }

    console.log(
      `[codex-im] inherited workspace binding from sender binding for feishu thread=${threadKey} workspace=${inheritedWorkspaceRoot}`
    );
    return inheritedWorkspaceRoot;
  }

  getCurrentThreadContext(normalized) {
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    const threadId = workspaceRoot
      ? this.resolveThreadIdForBinding(bindingKey, workspaceRoot)
      : this.sessionStore.getChatThreadId(bindingKey);
    return { bindingKey, workspaceRoot, threadId };
  }

  requireFeishuAdapter() {
    if (!this.feishuAdapter) {
      throw new Error("Feishu adapter is not initialized");
    }
    return this.feishuAdapter;
  }

  describeInstanceLabel() {
    return String(this.config.instanceLabel || "default").trim() || "default";
  }

  async probeCapabilityStatus() {
    const availableCatalog = this.sessionStore.getAvailableModelCatalog();
    const hasModels = Array.isArray(availableCatalog?.models) && availableCatalog.models.length > 0;
    const codexCliOk = this.codex.mode === "spawn";
    const githubEnabled = readTruthyEnvFlag("CODEX_IM_GITHUB_ENABLED");
    const canvaEnabled = readTruthyEnvFlag("CODEX_IM_CANVA_ENABLED");
    const cloudflareEnabled = readTruthyEnvFlag("CODEX_IM_CLOUDFLARE_ENABLED");
    const chromeEnabled = readTruthyEnvFlag("CODEX_IM_CHROME_ENABLED");

    return {
      codexCliOk,
      hasModels,
      github: formatCapabilityVerificationStatus(githubEnabled),
      canva: formatCapabilityVerificationStatus(canvaEnabled),
      cloudflare: formatCapabilityVerificationStatus(cloudflareEnabled),
      chrome: formatCapabilityVerificationStatus(chromeEnabled, "未验证（当前实例暂不支持）"),
    };
  }


  async buildDoctorText({ bindingKey = "", workspaceRoot = "" } = {}) {
    const instanceLabel = this.describeInstanceLabel();
    const platformLabel = formatRuntimePlatformLabel(process.platform);
    const bridgeMode = String(this.config.bridgeMode || "thin").trim().toLowerCase();
    const directBridgeMode = bridgeMode === "direct";
    const workspaceGoal = bindingKey && workspaceRoot
      ? this.sessionStore.getGoalForWorkspace(bindingKey, workspaceRoot)
      : "";
    const chatGoal = bindingKey ? this.sessionStore.getChatGoal(bindingKey) : "";
    const goal = workspaceGoal || chatGoal;
    const goalState = bindingKey
      ? normalizeGoalState(
        workspaceRoot
          ? this.sessionStore.getGoalStateForWorkspace(bindingKey, workspaceRoot)
          : this.sessionStore.getChatGoalState(bindingKey)
      )
      : createEmptyGoalState();
    const threadId = bindingKey
      ? (workspaceRoot
        ? this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot)
        : this.sessionStore.getChatThreadId(bindingKey))
      : "";
    const codexParams = bindingKey && workspaceRoot
      ? this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot)
      : { model: "", effort: "", accessMode: "" };
    const stats = workspaceRoot ? await this.resolveWorkspaceStats(workspaceRoot) : null;
    const capabilityStatus = await this.probeCapabilityStatus();
    const attachmentCacheStatus = await this.resolveAttachmentCacheStatus();
    const evolvingMemoryStatus = await this.resolveEvolvingMemoryStatus({ bindingKey });
    const pluginRoot = String(this.config.pluginRoot || "").trim();
    const marketplaceRoot = String(this.config.marketplaceRoot || "").trim();
    const marketplaceFile = marketplaceRoot ? path.join(marketplaceRoot, "marketplace.json") : "";
    const installedPlugins = listInstalledPlugins(pluginRoot);
    const marketplacePlugins = listMarketplacePlugins(marketplaceFile);
    const capabilitySections = this.capabilities
      ? await this.capabilities.buildDoctorSections({
        runtime: this,
        bindingKey,
        workspaceRoot,
      })
      : [];

    const pathStatus = !workspaceRoot
      ? "当前会话还没有绑定项目"
      : !stats?.exists
        ? "当前实例执行层不可访问该路径"
        : !stats?.isDirectory
          ? "路径存在，但不是目录"
          : "当前实例可以访问该路径";

    return [
      "**Codex Doctor**",
      `实例标签：\`${instanceLabel}\``,
      `桥模式：${formatBridgeModeDoctorLabel(bridgeMode)}`,
      `运行系统：${platformLabel}`,
      `HOME：\`${escapeInline(os.homedir())}\``,
      `Codex 连接方式：${this.codex.mode === "spawn" ? "本地 CLI / app-server" : "外部 websocket"}`,
      `Codex CLI 基线：${capabilityStatus.codexCliOk ? "可用" : "未走本地 CLI 模式"}`,
      `模型目录：${capabilityStatus.hasModels ? "已加载" : "未加载"}`,
      "",
      `当前项目：${workspaceRoot ? `\`${escapeInline(workspaceRoot)}\`` : "未绑定"}`,
      `路径可达性：${pathStatus}`,
      `${workspaceRoot ? "当前线程" : "会话线程"}：${threadId ? `\`${escapeInline(threadId)}\`` : "未建立"}`,
      `访问模式：${codexParams.accessMode || this.config.defaultCodexAccessMode || "default"}`,
      `模型：${codexParams.model || this.config.defaultCodexModel || "默认"}`,
      `推理强度：${codexParams.effort || this.config.defaultCodexEffort || "默认"}`,
      ...(directBridgeMode
        ? []
        : [
          `${workspaceRoot ? "项目目标" : "会话目标"}：${goal ? goal : "未设置"}`,
          `目标状态：${formatGoalStateField(goalState.status)}`,
          `当前阶段：${formatGoalStateField(goalState.stage)}`,
          `下一步：${formatGoalStateField(goalState.nextStep)}`,
          `阶段摘要：${formatGoalStateField(goalState.summary)}`,
        ]),
      "",
      "**插件状态**",
      `- 插件目录：\`${escapeInline(pluginRoot || "未配置")}\``,
      `- Marketplace：\`${escapeInline(marketplaceFile || "未配置")}\``,
      `- 已安装插件：${installedPlugins.length}`,
      `- Marketplace 条目：${marketplacePlugins.length}`,
      "",
      "**附件缓存**",
      `- 目录：\`${escapeInline(attachmentCacheStatus.dir)}\``,
      `- 可访问：${attachmentCacheStatus.accessible ? "是" : "否"}`,
      `- 文件数：${attachmentCacheStatus.fileCount}`,
      `- 占用：${formatBytes(attachmentCacheStatus.totalBytes)}`,
      `- 自动清理：保留最近 ${attachmentCacheStatus.retentionHours} 小时`,
      "",
      ...buildEvolvingMemoryDoctorLines(evolvingMemoryStatus),
      "",
      "**能力状态**",
      `- GitHub：${capabilityStatus.github}`,
      `- Canva：${capabilityStatus.canva}`,
      `- Cloudflare：${capabilityStatus.cloudflare}`,
      `- Chrome：${capabilityStatus.chrome}`,
      ...(capabilitySections.length
        ? ["", ...capabilitySections.flatMap((section) => [section, ""]).slice(0, -1)]
        : []),
      "",
      "说明：会话里提到的项目路径，并不代表当前实例执行层一定可见。只有这里实际可访问的路径，才能绑定和操作。",
    ].join("\n");
  }

  describeCodexAppServerProfile() {
    return this.codexAppServerProfile || "main";
  }

  async switchCodexAppServerProfile(profileAlias) {
    const rawAlias = String(profileAlias || "").trim().toLowerCase();
    if (!rawAlias) {
      return {
        ok: false,
        message: `当前 Codex 运行档：${this.describeCodexAppServerProfile()}\n\n用法：${this.buildProfileUsageText()}`,
      };
    }
    if (!(rawAlias in CODEX_APP_SERVER_PROFILES)) {
      return {
        ok: false,
        message: `未知运行档。可用：${this.buildProfileAliasListText()}。`,
      };
    }
    if (this.activeTurnIdByThreadId.size > 0) {
      return {
        ok: false,
        message: "当前还有任务在运行。先等完成，或发送 `/codex stop` 后再切换运行档。",
      };
    }

    const nextProfile = CODEX_APP_SERVER_PROFILES[rawAlias];
    const currentProfile = this.codexAppServerProfile || "";
    if (nextProfile === currentProfile) {
      return {
        ok: true,
        message: `已经是当前运行档：${this.describeCodexAppServerProfile()}`,
      };
    }

    if (typeof this.extensions?.codexProfiles?.beforeSwitchCodexAppServerProfile === "function") {
      await this.extensions.codexProfiles.beforeSwitchCodexAppServerProfile(nextProfile, process.env);
    }

    await this.codex.restartSpawn({ appServerProfile: nextProfile });
    this.codexAppServerProfile = nextProfile;
    const response = await this.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (models.length) {
      this.sessionStore.setAvailableModelCatalog(models);
    }
    this.resumedThreadIds.clear();
    return {
      ok: true,
      message: `已切换 Codex 运行档：${this.describeCodexAppServerProfile()}`,
    };
  }

  async handleProfileCommand(normalized) {
    const value = extractProfileValue(normalized.text);
    if (!value) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: [
          `当前 Codex 运行档：${this.describeCodexAppServerProfile()}`,
          "",
          "用法：",
          "`/codex profile main`",
          ...this.getExtensionProfileHelpLines(),
          "",
          `说明：该命令会重启飞书桥背后的 Codex app-server${this.getExtensionProfileNote()}。`,
        ].join("\n"),
      });
      return;
    }
    try {
      const result = await this.switchCodexAppServerProfile(value);
      if (result.ok) {
        const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
        if (workspaceRoot) {
          this.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
            model: "",
            effort: "",
          });
        }
      }
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: result.ok
          ? `${result.message}\n\n当前项目的模型覆盖已清空，将使用该运行档默认模型。`
          : result.message,
      });
    } catch (error) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `切换 Codex 运行档失败：${error.message}`,
      });
    }
  }

  getExtensionProfileHelpLines() {
    const getLines = this.extensions?.codexProfiles?.getProfileHelpLines;
    return typeof getLines === "function" ? getLines() : [];
  }

  getExtensionProfileNote() {
    const getNote = this.extensions?.codexProfiles?.getProfileNote;
    return typeof getNote === "function" ? getNote() : "";
  }

  buildProfileUsageText() {
    return ["`/codex profile main`", ...this.getExtensionProfileHelpLines()].join(" 或 ");
  }

  buildProfileAliasListText() {
    const labels = ["`main`"];
    const displayNames = this.extensions?.codexProfiles?.displayNames || {};
    for (const name of Object.values(displayNames)) {
      labels.push(`\`${name}\``);
    }
    return labels.join("、");
  }

  async resolveWorkspaceStats(workspaceRoot) {
    try {
      const stats = await fs.promises.stat(workspaceRoot);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, isDirectory: false };
      }
      throw error;
    }
  }

  async resolveAttachmentCacheStatus() {
    const dir = String(this.config.attachmentsDir || "").trim();
    const retentionHours = normalizePositiveInt(
      process.env.CODEX_IM_ATTACHMENTS_RETENTION_HOURS,
      24
    );
    if (!dir) {
      return {
        dir: "(not configured)",
        accessible: false,
        fileCount: 0,
        totalBytes: 0,
        retentionHours,
      };
    }

    try {
      const stats = await fs.promises.stat(dir);
      if (!stats.isDirectory()) {
        return {
          dir,
          accessible: false,
          fileCount: 0,
          totalBytes: 0,
          retentionHours,
        };
      }

      const summary = await summarizeDirectoryFiles(dir);
      return {
        dir,
        accessible: true,
        fileCount: summary.fileCount,
        totalBytes: summary.totalBytes,
        retentionHours,
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          dir,
          accessible: false,
          fileCount: 0,
          totalBytes: 0,
          retentionHours,
        };
      }
      throw error;
    }
  }

  async resolveEvolvingMemoryStatus({ bindingKey = "" } = {}) {
    const extensionFile = String(process.env.CODEX_IM_EXTENSIONS_FILE || "").trim();
    const defaultStoreFile = path.resolve(__dirname, "..", "..", "extensions", ".data", "evolving-memory-store.json");
    const storeFile = String(process.env.CODEX_IM_EVOLVING_MEMORY_FILE || defaultStoreFile).trim();
    const currentUserId = buildMemoryUserIdFromBindingKey(bindingKey);
    const baseStatus = {
      enabled: path.basename(extensionFile) === "mem0-extension.js",
      mem0Enabled: readTruthyEnvFlag("MEM0_ENABLED"),
      extensionFile: extensionFile || "(not configured)",
      storeFile: storeFile || "(not configured)",
      accessible: false,
      totalUserCount: 0,
      totalMemoryCount: 0,
      currentUserId,
      currentUserMemoryCount: 0,
      profileSummary: "",
      error: "",
    };
    if (!storeFile) {
      return baseStatus;
    }

    try {
      const raw = JSON.parse(await fs.promises.readFile(storeFile, "utf8"));
      const users = raw && typeof raw === "object" && raw.users && typeof raw.users === "object"
        ? raw.users
        : {};
      const totalUserCount = Object.keys(users).length;
      const totalMemoryCount = Object.values(users).reduce((sum, userState) => {
        const memories = userState && typeof userState === "object" && userState.memories && typeof userState.memories === "object"
          ? userState.memories
          : {};
        return sum + Object.keys(memories).length;
      }, 0);
      const currentUser = currentUserId ? users[currentUserId] || null : null;
      const currentMemories = currentUser && typeof currentUser === "object" && currentUser.memories && typeof currentUser.memories === "object"
        ? currentUser.memories
        : {};
      return {
        ...baseStatus,
        accessible: true,
        totalUserCount,
        totalMemoryCount,
        currentUserMemoryCount: Object.keys(currentMemories).length,
        profileSummary: typeof currentUser?.profileSummary === "string" ? currentUser.profileSummary.trim() : "",
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return baseStatus;
      }
      return {
        ...baseStatus,
        error: String(error?.code || error?.message || "unknown error"),
      };
    }
  }

  async runBeforeMessageHook(args) {
    const hook = this.extensions?.hooks?.beforeMessage;
    let normalized = args?.normalized || null;
    if (this.capabilities?.applyBeforeMessage) {
      normalized = await this.capabilities.applyBeforeMessage({
        ...args,
        runtime: this,
        normalized,
      });
    }
    if (typeof hook !== "function") {
      return normalized;
    }
    try {
      const result = await hook({
        ...args,
        normalized,
      });
      return result || normalized;
    } catch (error) {
      logger.warn("beforeMessage hook failed", { error });
      return normalized;
    }
  }

  async runAfterCodexReplyHook(args) {
    const hook = this.extensions?.hooks?.afterCodexReply;
    if (typeof hook !== "function") {
      return String(args?.text || "");
    }
    try {
      const result = await hook(args);
      return typeof result === "string" ? result : String(args?.text || "");
    } catch (error) {
      logger.warn("afterCodexReply hook failed", { error });
      return String(args?.text || "");
    }
  }

  async runApprovalRequestHook(args) {
    const hook = this.extensions?.hooks?.onApprovalRequest;
    if (typeof hook !== "function") {
      return;
    }
    try {
      await hook(args);
    } catch (error) {
      logger.warn("onApprovalRequest hook failed", { error });
    }
  }

  async runUsageUpdateHook(args) {
    const hook = this.extensions?.hooks?.onUsageUpdate;
    if (typeof hook !== "function") {
      return;
    }
    try {
      await hook(args);
    } catch (error) {
      logger.warn("onUsageUpdate hook failed", { error });
    }
  }

  async shutdownGracefully({ signal = "" } = {}) {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = (async () => {
      if (this.staleTurnWatchdog) {
        clearInterval(this.staleTurnWatchdog);
        this.staleTurnWatchdog = null;
      }
      const signalLabel = String(signal || "").trim();
      const interruptionText = signalLabel
        ? `桥正在重启（${signalLabel}），这一轮回复被中断了。\n恢复后你直接发“继续”就行。`
        : "桥正在重启，这一轮回复被中断了。\n恢复后你直接发“继续”就行。";
      try {
        await flushAllAssistantReplyCards(this, { interruptionText });
      } catch (error) {
        logger.error("failed to flush assistant replies during shutdown", {
          signal: signalLabel,
          error,
        });
      }
    })();

    return this.shutdownPromise;
  }
}

function attachRuntimeForwarders() {
  const proto = FeishuBotRuntime.prototype;

  const plainForwarders = {
    buildCardResponse,
    buildCardToast,
    buildEffortInfoText,
    buildEffortListText,
    buildEffortValidationErrorText,
    buildHelpCardText,
    buildModelInfoText,
    buildModelListText,
    buildModelValidationErrorText,
    buildStatusPanelCard,
    buildThreadMessagesSummary,
    buildThreadPickerCard,
    buildWorkspaceBindingsCard,
    listBoundWorkspaces,
  };

  for (const [methodName, fn] of Object.entries(plainForwarders)) {
    proto[methodName] = function forwardedPlain(...args) {
      return fn(...args);
    };
  }

  const runtimeFirstForwarders = {
    dispatchTextCommand: runtimeCommands.dispatchTextCommand,
    resolveWorkspaceContext: workspaceRuntime.resolveWorkspaceContext,
    resolveWorkspaceThreadState: threadRuntime.resolveWorkspaceThreadState,
    ensureThreadAndSendMessage: threadRuntime.ensureThreadAndSendMessage,
    ensureThreadResumed: threadRuntime.ensureThreadResumed,
    resolveWorkspaceRootForBinding: runtimeState.resolveWorkspaceRootForBinding,
    resolveThreadIdForBinding: runtimeState.resolveThreadIdForBinding,
    setThreadBindingKey: runtimeState.setThreadBindingKey,
    setThreadWorkspaceRoot: runtimeState.setThreadWorkspaceRoot,
    setPendingBindingContext: runtimeState.setPendingBindingContext,
    setPendingThreadContext: runtimeState.setPendingThreadContext,
    setReplyCardEntry: runtimeState.setReplyCardEntry,
    setCurrentRunKeyForThread: runtimeState.setCurrentRunKeyForThread,
    resolveWorkspaceRootForThread: runtimeState.resolveWorkspaceRootForThread,
    rememberApprovalPrefixForWorkspace: approvalPolicyRuntime.rememberApprovalPrefixForWorkspace,
    shouldAutoApproveRequest: approvalPolicyRuntime.shouldAutoApproveRequest,
    tryAutoApproveRequest: approvalPolicyRuntime.tryAutoApproveRequest,
    applyApprovalDecision: approvalRuntime.applyApprovalDecision,
    sendApprovalPrompt: approvalRuntime.sendApprovalPrompt,
    handleBindCommand: workspaceRuntime.handleBindCommand,
    handleWhereCommand: workspaceRuntime.handleWhereCommand,
    handleDoctorCommand: workspaceRuntime.handleDoctorCommand,
    showStatusPanel: workspaceRuntime.showStatusPanel,
    handleMessageCommand: workspaceRuntime.handleMessageCommand,
    handleHelpCommand: workspaceRuntime.handleHelpCommand,
    handleUnknownCommand: workspaceRuntime.handleUnknownCommand,
    handleWorkspacesCommand: workspaceRuntime.handleWorkspacesCommand,
    handleGoalCommand: workspaceRuntime.handleGoalCommand,
    handleScoreCommand: workspaceRuntime.handleScoreCommand,
    handleEvalCommand: workspaceRuntime.handleEvalCommand,
    handleSkillCommand: workspaceRuntime.handleSkillCommand,
    handlePluginCommand: workspaceRuntime.handlePluginCommand,
    handlePotentialGoalMessage: (runtime, normalized) =>
      runtime.capabilities.handlePotentialGoalMessage(runtime, normalized),
    handlePotentialPluginIntentMessage: (runtime, normalized) =>
      runtime.capabilities.handlePotentialPluginIntentMessage(runtime, normalized),
    showThreadPicker: workspaceRuntime.showThreadPicker,
    handleNewCommand: threadRuntime.handleNewCommand,
    handleSwitchCommand: threadRuntime.handleSwitchCommand,
    handleRemoveCommand: workspaceRuntime.handleRemoveCommand,
    handleSendCommand: workspaceRuntime.handleSendCommand,
    handleModelCommand: workspaceRuntime.handleModelCommand,
    handleEffortCommand: workspaceRuntime.handleEffortCommand,
    handleAccessCommand: workspaceRuntime.handleAccessCommand,
    refreshWorkspaceThreads: threadRuntime.refreshWorkspaceThreads,
    describeWorkspaceStatus: threadRuntime.describeWorkspaceStatus,
    switchThreadById: threadRuntime.switchThreadById,
    handleStopCommand: eventsRuntime.handleStopCommand,
    handleApprovalCommand: approvalRuntime.handleApprovalCommand,
    deliverToFeishu: eventsRuntime.deliverToFeishu,
    sendInfoCardMessage,
    sendPluginRouteCardMessage,
    sendInteractiveApprovalCard,
    updateInteractiveCard,
    sendInteractiveCard,
    patchInteractiveCard,
    handleCardAction,
    dispatchCardAction: runtimeCommands.dispatchCardAction,
    handlePanelCardAction: runtimeCommands.handlePanelCardAction,
    handleThreadCardAction: runtimeCommands.handleThreadCardAction,
    handleWorkspaceCardAction: runtimeCommands.handleWorkspaceCardAction,
    queueCardActionWithFeedback,
    runCardActionTask,
    handleApprovalCardActionAsync: approvalRuntime.handleApprovalCardActionAsync,
    sendCardActionFeedbackByContext,
    sendCardActionFeedback,
    switchWorkspaceByPath: workspaceRuntime.switchWorkspaceByPath,
    removeWorkspaceByPath: workspaceRuntime.removeWorkspaceByPath,
    upsertAssistantReplyCard,
    flushAssistantReplyCardNow,
    addPendingReaction,
    movePendingReactionToThread,
    clearPendingReactionForBinding,
    clearPendingReactionForThread,
    disposeReplyRunState,
    cleanupThreadRuntimeState: runtimeState.cleanupThreadRuntimeState,
    pruneRuntimeMapSizes: runtimeState.pruneRuntimeMapSizes,
  };

  for (const [methodName, fn] of Object.entries(runtimeFirstForwarders)) {
    proto[methodName] = function forwardedRuntimeFirst(...args) {
      return fn(this, ...args);
    };
  }

  proto.getCodexParamsForWorkspace = function getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    return this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  };
}

attachRuntimeForwarders();

FeishuBotRuntime.prototype.sendFileMessage = function sendFileMessage(args) {
  return this.requireFeishuAdapter().sendFileMessage(args);
};

FeishuBotRuntime.prototype.sendImageMessage = function sendImageMessage(args) {
  return this.requireFeishuAdapter().sendImageMessage(args);
};

FeishuBotRuntime.prototype.sendLocalAttachmentToFeishu = function sendLocalAttachmentToFeishu(args) {
  return sendLocalAttachmentWithRuntime(this, args);
};

async function sendLocalAttachmentWithRuntime(runtime, {
  kind,
  chatId,
  fileName,
  fileBuffer,
  fileType = "stream",
  msgType = "file",
  replyToMessageId = "",
  replyInThread = false,
}) {
  if (kind === "image") {
    return runtime.sendImageMessage({
      chatId,
      imageBuffer: fileBuffer,
      replyToMessageId,
      replyInThread,
    });
  }
  return runtime.sendFileMessage({
    chatId,
    fileName,
    fileBuffer,
    fileType,
    msgType,
    replyToMessageId,
    replyInThread,
  });
}

function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function escapeInline(value) {
  return String(value || "").replace(/`/g, "\\`");
}

function createEmptyGoalState() {
  return {
    status: "",
    stage: "",
    nextStep: "",
    summary: "",
    updatedAt: "",
  };
}

function normalizeGoalState(goalState) {
  const input = goalState && typeof goalState === "object" ? goalState : {};
  return {
    status: typeof input.status === "string" ? input.status.trim().toLowerCase() : "",
    stage: typeof input.stage === "string" ? input.stage.trim() : "",
    nextStep: typeof input.nextStep === "string"
      ? input.nextStep.trim()
      : (typeof input.next_step === "string" ? input.next_step.trim() : ""),
    summary: typeof input.summary === "string" ? input.summary.trim() : "",
    updatedAt: typeof input.updatedAt === "string"
      ? input.updatedAt.trim()
      : (typeof input.updated_at === "string" ? input.updated_at.trim() : ""),
  };
}

function hasGoalState(goalState) {
  const normalized = normalizeGoalState(goalState);
  return !!(normalized.status || normalized.stage || normalized.nextStep || normalized.summary);
}

function formatBridgeModeDoctorLabel(bridgeMode) {
  if (bridgeMode === "standard") {
    return "standard / legacy local capabilities";
  }
  if (bridgeMode === "direct") {
    return "direct / transport shell";
  }
  return "thin / Codex-first pass-through";
}

function formatGoalStateField(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || "未设置";
}

module.exports = {
  FeishuBotRuntime,
};

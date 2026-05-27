const fs = require("fs");
const path = require("path");
const { normalizeModelCatalog } = require("../../shared/model-catalog");

class SessionStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    const parentDirectory = path.dirname(this.filePath);
    fs.mkdirSync(parentDirectory, { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.bindings) {
        this.state = {
          ...createEmptyState(),
          ...parsed,
          bindings: parsed.bindings || {},
          approvalCommandAllowlistByWorkspaceRoot: parsed.approvalCommandAllowlistByWorkspaceRoot || {},
          availableModelCatalog: parsed.availableModelCatalog || {
            models: [],
            updatedAt: "",
          },
          appointmentStateByChatScopeKey: normalizeObjectMap(
            parsed.appointmentStateByChatScopeKey,
            normalizeAppointmentScope
          ),
        };
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  getActiveWorkspaceRoot(bindingKey) {
    return this.state.bindings[bindingKey]?.activeWorkspaceRoot || "";
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const current = this.getBinding(bindingKey) || { threadIdByWorkspaceRoot: {} };
    const threadIdByWorkspaceRoot = getThreadMap(current);
    if (normalizedWorkspaceRoot && !(normalizedWorkspaceRoot in threadIdByWorkspaceRoot)) {
      threadIdByWorkspaceRoot[normalizedWorkspaceRoot] = "";
    }

    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  getThreadIdForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return "";
    }
    return this.state.bindings[bindingKey]?.threadIdByWorkspaceRoot?.[normalizedWorkspaceRoot] || "";
  }

  getChatThreadId(bindingKey) {
    return normalizeValue(this.state.bindings[bindingKey]?.chatThreadId);
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = {
      ...getThreadMap(current),
      [normalizedWorkspaceRoot]: threadId,
    };

    return this.updateBinding(bindingKey, {
      ...current,
      ...extra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  setChatThreadId(bindingKey, threadId, extra = {}) {
    const current = this.getBinding(bindingKey) || {};
    return this.updateBinding(bindingKey, {
      ...current,
      ...extra,
      chatThreadId: normalizeValue(threadId),
    });
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = {
      ...getThreadMap(current),
      [normalizedWorkspaceRoot]: "",
    };

    return this.updateBinding(bindingKey, {
      ...current,
      threadIdByWorkspaceRoot,
    });
  }

  clearChatThreadId(bindingKey) {
    const current = this.getBinding(bindingKey) || {};
    return this.updateBinding(bindingKey, {
      ...current,
      chatThreadId: "",
    });
  }

  getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return { model: "", effort: "", accessMode: "" };
    }
    const raw = this.state.bindings[bindingKey]?.codexParamsByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!raw || typeof raw !== "object") {
      return { model: "", effort: "", accessMode: "" };
    }
    return {
      model: normalizeValue(raw.model),
      effort: normalizeValue(raw.effort),
      accessMode: normalizeAccessMode(raw.accessMode),
    };
  }

  getGoalForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return "";
    }
    return normalizeValue(
      this.state.bindings[bindingKey]?.goalByWorkspaceRoot?.[normalizedWorkspaceRoot]
    );
  }

  getChatGoal(bindingKey) {
    return normalizeValue(this.state.bindings[bindingKey]?.chatGoalText);
  }

  getGoalStateForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return createEmptyGoalState();
    }
    return normalizeGoalState(
      this.state.bindings[bindingKey]?.goalStateByWorkspaceRoot?.[normalizedWorkspaceRoot]
    );
  }

  getChatGoalState(bindingKey) {
    return normalizeGoalState(this.state.bindings[bindingKey]?.chatGoalState);
  }

  getSkillStateForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return { skillRoot: "", pluginRoot: "", skillItems: [], pluginItems: [] };
    }
    const raw = this.state.bindings[bindingKey]?.skillStateByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!raw || typeof raw !== "object") {
      return { skillRoot: "", pluginRoot: "", skillItems: [], pluginItems: [] };
    }
    return {
      skillRoot: normalizeValue(raw.skillRoot),
      pluginRoot: normalizeValue(raw.pluginRoot),
      skillItems: normalizeStringArray(raw.skillItems),
      pluginItems: normalizeStringArray(raw.pluginItems),
    };
  }

  setSkillStateForWorkspace(bindingKey, workspaceRoot, nextState = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const currentState = this.getSkillStateForWorkspace(bindingKey, normalizedWorkspaceRoot);
    const skillStateByWorkspaceRoot = {
      ...getSkillStateMap(current),
      [normalizedWorkspaceRoot]: {
        skillRoot: hasOwn(nextState, "skillRoot") ? normalizeValue(nextState.skillRoot) : currentState.skillRoot,
        pluginRoot: hasOwn(nextState, "pluginRoot") ? normalizeValue(nextState.pluginRoot) : currentState.pluginRoot,
        skillItems: hasOwn(nextState, "skillItems") ? normalizeStringArray(nextState.skillItems) : currentState.skillItems,
        pluginItems: hasOwn(nextState, "pluginItems") ? normalizeStringArray(nextState.pluginItems) : currentState.pluginItems,
      },
    };

    return this.updateBinding(bindingKey, {
      ...current,
      skillStateByWorkspaceRoot,
    });
  }

  setGoalForWorkspace(bindingKey, workspaceRoot, goalText) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const goalByWorkspaceRoot = {
      ...getGoalMap(current),
    };
    const goalStateByWorkspaceRoot = {
      ...getGoalStateMap(current),
    };
    const previousGoalText = normalizeValue(goalByWorkspaceRoot[normalizedWorkspaceRoot]);
    const normalizedGoalText = normalizeValue(goalText);
    if (normalizedGoalText) {
      goalByWorkspaceRoot[normalizedWorkspaceRoot] = normalizedGoalText;
      if (previousGoalText && previousGoalText !== normalizedGoalText) {
        delete goalStateByWorkspaceRoot[normalizedWorkspaceRoot];
      }
    } else {
      delete goalByWorkspaceRoot[normalizedWorkspaceRoot];
      delete goalStateByWorkspaceRoot[normalizedWorkspaceRoot];
    }

    return this.updateBinding(bindingKey, {
      ...current,
      goalByWorkspaceRoot,
      goalStateByWorkspaceRoot,
    });
  }

  setChatGoal(bindingKey, goalText) {
    const current = this.getBinding(bindingKey) || {};
    const previousGoalText = normalizeValue(current.chatGoalText);
    const normalizedGoalText = normalizeValue(goalText);
    const nextBinding = {
      ...current,
      chatGoalText: normalizedGoalText,
    };
    if (!normalizedGoalText || (previousGoalText && previousGoalText !== normalizedGoalText)) {
      nextBinding.chatGoalState = createEmptyGoalState();
    }
    return this.updateBinding(bindingKey, nextBinding);
  }

  setGoalStateForWorkspace(bindingKey, workspaceRoot, nextState = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const currentState = this.getGoalStateForWorkspace(bindingKey, normalizedWorkspaceRoot);
    const normalizedState = buildNextGoalState(currentState, nextState);
    const goalStateByWorkspaceRoot = {
      ...getGoalStateMap(current),
    };
    if (isEmptyGoalState(normalizedState)) {
      delete goalStateByWorkspaceRoot[normalizedWorkspaceRoot];
    } else {
      goalStateByWorkspaceRoot[normalizedWorkspaceRoot] = normalizedState;
    }
    return this.updateBinding(bindingKey, {
      ...current,
      goalStateByWorkspaceRoot,
    });
  }

  setChatGoalState(bindingKey, nextState = {}) {
    const current = this.getBinding(bindingKey) || {};
    const currentState = this.getChatGoalState(bindingKey);
    const normalizedState = buildNextGoalState(currentState, nextState);
    return this.updateBinding(bindingKey, {
      ...current,
      chatGoalState: normalizedState,
    });
  }

  setCodexParamsForWorkspace(bindingKey, workspaceRoot, nextParams = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const currentParams = this.getCodexParamsForWorkspace(bindingKey, normalizedWorkspaceRoot);
    const codexParamsByWorkspaceRoot = {
      ...getCodexParamsMap(current),
      [normalizedWorkspaceRoot]: {
        model: hasOwn(nextParams, "model") ? normalizeValue(nextParams.model) : currentParams.model,
        effort: hasOwn(nextParams, "effort") ? normalizeValue(nextParams.effort) : currentParams.effort,
        accessMode: hasOwn(nextParams, "accessMode")
          ? normalizeAccessMode(nextParams.accessMode)
          : currentParams.accessMode,
      },
    };

    return this.updateBinding(bindingKey, {
      ...current,
      codexParamsByWorkspaceRoot,
    });
  }

  getApprovalCommandAllowlistForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return [];
    }
    const allowlist = this.state.approvalCommandAllowlistByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!Array.isArray(allowlist)) {
      return [];
    }
    return normalizeCommandAllowlist(allowlist);
  }

  getAvailableModelCatalog() {
    const raw = this.state.availableModelCatalog;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const models = normalizeModelCatalog(raw.models);
    if (!models.length) {
      return null;
    }
    const updatedAt = normalizeValue(raw.updatedAt);
    return {
      models,
      updatedAt,
    };
  }

  setAvailableModelCatalog(models) {
    const normalizedModels = normalizeModelCatalog(models);
    if (!normalizedModels.length) {
      return null;
    }

    this.state.availableModelCatalog = {
      models: normalizedModels,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.availableModelCatalog;
  }

  listBridgeWakeupTasks() {
    return normalizeObjectMap(this.state.bridgeWakeupTasksById, normalizeBridgeWakeupTask);
  }

  listDueBridgeWakeupTasks(now = new Date()) {
    const nowMs = normalizeDateToEpochMs(now);
    return Object.values(this.listBridgeWakeupTasks())
      .filter((task) => isBridgeWakeupTaskDue(task, nowMs))
      .sort((left, right) => left.runAt.localeCompare(right.runAt));
  }

  upsertBridgeWakeupTask(task = {}) {
    const normalizedTask = normalizeBridgeWakeupTask({
      ...task,
      updatedAt: new Date().toISOString(),
    });
    if (!normalizedTask.id) {
      return null;
    }
    this.state.bridgeWakeupTasksById = {
      ...(this.state.bridgeWakeupTasksById || {}),
      [normalizedTask.id]: normalizedTask,
    };
    this.save();
    return normalizedTask;
  }

  markBridgeWakeupTaskDelivered(taskId, deliveredAt = new Date().toISOString()) {
    const normalizedTaskId = normalizeValue(taskId);
    if (!normalizedTaskId) {
      return null;
    }
    const existing = this.listBridgeWakeupTasks()[normalizedTaskId];
    if (!existing) {
      return null;
    }
    return this.upsertBridgeWakeupTask({
      ...existing,
      status: "delivered",
      deliveredAt: normalizeValue(deliveredAt) || new Date().toISOString(),
      lastError: "",
    });
  }

  markBridgeWakeupTaskFailed(taskId, errorMessage) {
    const normalizedTaskId = normalizeValue(taskId);
    if (!normalizedTaskId) {
      return null;
    }
    const existing = this.listBridgeWakeupTasks()[normalizedTaskId];
    if (!existing) {
      return null;
    }
    return this.upsertBridgeWakeupTask({
      ...existing,
      status: "failed",
      lastError: normalizeValue(errorMessage),
    });
  }

  pruneDeliveredBridgeWakeupTasks({
    olderThanMs = 7 * 24 * 60 * 60 * 1000,
    now = new Date(),
  } = {}) {
    const cutoffMs = normalizeDateToEpochMs(now) - Math.max(0, Number(olderThanMs) || 0);
    const currentTasks = this.listBridgeWakeupTasks();
    let changed = false;
    const nextTasks = {};
    Object.entries(currentTasks).forEach(([taskId, task]) => {
      const deliveredAtMs = normalizeDateToEpochMs(task.deliveredAt);
      const shouldDrop = (task.status === "delivered" || task.status === "cancelled")
        && deliveredAtMs > 0
        && deliveredAtMs <= cutoffMs;
      if (shouldDrop) {
        changed = true;
        return;
      }
      nextTasks[taskId] = task;
    });
    if (!changed) {
      return 0;
    }
    this.state.bridgeWakeupTasksById = nextTasks;
    this.save();
    return 1;
  }

  rememberApprovalCommandPrefixForWorkspace(workspaceRoot, commandTokens) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedTokens = normalizeCommandTokens(commandTokens);
    if (!normalizedWorkspaceRoot || !normalizedTokens.length) {
      return null;
    }

    const currentAllowlist = this.getApprovalCommandAllowlistForWorkspace(normalizedWorkspaceRoot);
    const exists = currentAllowlist.some((prefix) => (
      prefix.length === normalizedTokens.length
      && prefix.every((token, index) => token === normalizedTokens[index])
    ));
    if (exists) {
      return currentAllowlist;
    }

    this.state.approvalCommandAllowlistByWorkspaceRoot = {
      ...(this.state.approvalCommandAllowlistByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: [...currentAllowlist, normalizedTokens],
    };
    this.save();
    return this.state.approvalCommandAllowlistByWorkspaceRoot[normalizedWorkspaceRoot];
  }

  buildChatScopeKey({ workspaceId, chatId }) {
    const normalizedWorkspaceId = normalizeValue(workspaceId);
    const normalizedChatId = normalizeValue(chatId);
    return normalizedWorkspaceId && normalizedChatId
      ? `${normalizedWorkspaceId}:${normalizedChatId}`
      : "";
  }

  getAppointmentScope(chatScopeKey) {
    const normalizedChatScopeKey = normalizeValue(chatScopeKey);
    if (!normalizedChatScopeKey) {
      return createEmptyAppointmentScope();
    }
    return normalizeAppointmentScope(
      this.state.appointmentStateByChatScopeKey?.[normalizedChatScopeKey]
    );
  }

  getAllAppointmentScopes() {
    const scopes = this.state.appointmentStateByChatScopeKey || {};
    return Object.entries(scopes).map(([chatScopeKey, scope]) => ({
      chatScopeKey,
      scope: normalizeAppointmentScope(scope),
    }));
  }

  updateAppointmentScope(chatScopeKey, updater) {
    const normalizedChatScopeKey = normalizeValue(chatScopeKey);
    if (!normalizedChatScopeKey || typeof updater !== "function") {
      return createEmptyAppointmentScope();
    }

    const current = cloneAppointmentScope(this.getAppointmentScope(normalizedChatScopeKey));
    const nextValue = updater(current);
    const nextScope = normalizeAppointmentScope(nextValue);
    const map = {
      ...(this.state.appointmentStateByChatScopeKey || {}),
    };
    if (isEmptyAppointmentScope(nextScope)) {
      delete map[normalizedChatScopeKey];
    } else {
      map[normalizedChatScopeKey] = nextScope;
    }
    this.state.appointmentStateByChatScopeKey = map;
    this.save();
    return nextScope;
  }

  removeWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = getThreadMap(current);
    const codexParamsByWorkspaceRoot = getCodexParamsMap(current);
    const goalByWorkspaceRoot = getGoalMap(current);
    const goalStateByWorkspaceRoot = getGoalStateMap(current);
    const skillStateByWorkspaceRoot = getSkillStateMap(current);
    const hasWorkspaceEntry = Object.prototype.hasOwnProperty.call(
      threadIdByWorkspaceRoot,
      normalizedWorkspaceRoot
    );
    const activeWorkspaceRoot = normalizeValue(current.activeWorkspaceRoot);
    if (!hasWorkspaceEntry && activeWorkspaceRoot !== normalizedWorkspaceRoot) {
      return current;
    }

    delete threadIdByWorkspaceRoot[normalizedWorkspaceRoot];
    delete codexParamsByWorkspaceRoot[normalizedWorkspaceRoot];
    delete goalByWorkspaceRoot[normalizedWorkspaceRoot];
    delete goalStateByWorkspaceRoot[normalizedWorkspaceRoot];
    delete skillStateByWorkspaceRoot[normalizedWorkspaceRoot];

    const nextActiveWorkspaceRoot = activeWorkspaceRoot === normalizedWorkspaceRoot
      ? (Object.keys(threadIdByWorkspaceRoot).sort((left, right) => left.localeCompare(right))[0] || "")
      : activeWorkspaceRoot;

    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: nextActiveWorkspaceRoot,
      codexParamsByWorkspaceRoot,
      goalByWorkspaceRoot,
      goalStateByWorkspaceRoot,
      skillStateByWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...nextBinding,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  buildBindingKey({ workspaceId, chatId, threadKey, senderId, messageId }) {
    const normalizedThreadKey = normalizeValue(threadKey);
    const normalizedMessageId = normalizeValue(messageId);
    const hasStableThreadKey = normalizedThreadKey && normalizedThreadKey !== normalizedMessageId;

    if (hasStableThreadKey) {
      return `${workspaceId}:${chatId}:thread:${normalizedThreadKey}`;
    }
    return `${workspaceId}:${chatId}:sender:${senderId}`;
  }

}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAccessMode(value) {
  const normalized = normalizeValue(value).toLowerCase();
  if (normalized === "default" || normalized === "full-access") {
    return normalized;
  }
  return "";
}

function createEmptyState() {
  return {
    bindings: {},
    approvalCommandAllowlistByWorkspaceRoot: {},
    availableModelCatalog: {
      models: [],
      updatedAt: "",
    },
    appointmentStateByChatScopeKey: {},
    skillStateByWorkspaceRoot: {},
    bridgeWakeupTasksById: {},
  };
}

function getThreadMap(binding) {
  return { ...(binding?.threadIdByWorkspaceRoot || {}) };
}

function getCodexParamsMap(binding) {
  return { ...(binding?.codexParamsByWorkspaceRoot || {}) };
}

function getGoalMap(binding) {
  return { ...(binding?.goalByWorkspaceRoot || {}) };
}

function getGoalStateMap(binding) {
  return { ...(binding?.goalStateByWorkspaceRoot || {}) };
}

function getSkillStateMap(binding) {
  return { ...(binding?.skillStateByWorkspaceRoot || {}) };
}

function normalizeCommandTokens(tokens) {
  if (!Array.isArray(tokens)) {
    return [];
  }
  return tokens
    .map((token) => (typeof token === "string" ? token.trim() : ""))
    .filter(Boolean);
}

function normalizeCommandAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) {
    return [];
  }
  return allowlist
    .map((tokens) => normalizeCommandTokens(tokens))
    .filter((tokens) => tokens.length > 0);
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => normalizeValue(value))
    .filter(Boolean);
}

function normalizeBridgeWakeupTask(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    id: normalizeValue(input.id),
    chatId: normalizeValue(input.chatId),
    threadId: normalizeValue(input.threadId),
    threadKey: normalizeValue(input.threadKey),
    replyToMessageId: normalizeValue(input.replyToMessageId),
    replyInThread: Boolean(input.replyInThread),
    bindingKey: normalizeValue(input.bindingKey),
    workspaceRoot: normalizeValue(input.workspaceRoot),
    sourceMessageId: normalizeValue(input.sourceMessageId),
    sourceTurnId: normalizeValue(input.sourceTurnId),
    title: normalizeValue(input.title),
    text: normalizeValue(input.text),
    runAt: normalizeValue(input.runAt),
    dedupeKey: normalizeValue(input.dedupeKey),
    status: normalizeBridgeWakeupTaskStatus(input.status),
    createdAt: normalizeValue(input.createdAt) || new Date().toISOString(),
    updatedAt: normalizeValue(input.updatedAt) || new Date().toISOString(),
    deliveredAt: normalizeValue(input.deliveredAt),
    lastError: normalizeValue(input.lastError),
  };
}

function normalizeBridgeWakeupTaskStatus(value) {
  const normalized = normalizeValue(value).toLowerCase();
  if (normalized === "delivered" || normalized === "failed" || normalized === "cancelled") {
    return normalized;
  }
  return "pending";
}

function normalizeDateToEpochMs(value) {
  const numeric = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(numeric) ? numeric : -1;
}

function isBridgeWakeupTaskDue(task, nowMs) {
  if (!task || task.status !== "pending") {
    return false;
  }
  if (!task.chatId || !task.text || !task.runAt) {
    return false;
  }
  const runAtMs = normalizeDateToEpochMs(task.runAt);
  return runAtMs > 0 && runAtMs <= nowMs;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
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

function normalizeGoalState(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    status: normalizeGoalStatus(input.status),
    stage: normalizeValue(input.stage),
    nextStep: normalizeValue(input.nextStep || input.next_step),
    summary: normalizeValue(input.summary),
    updatedAt: normalizeValue(input.updatedAt || input.updated_at),
  };
}

function buildNextGoalState(currentState, nextState) {
  const current = normalizeGoalState(currentState);
  const input = nextState && typeof nextState === "object" ? nextState : {};
  const merged = {
    status: hasOwn(input, "status") ? normalizeGoalStatus(input.status) : current.status,
    stage: hasOwn(input, "stage") ? normalizeValue(input.stage) : current.stage,
    nextStep: hasOwn(input, "nextStep")
      ? normalizeValue(input.nextStep)
      : (hasOwn(input, "next_step") ? normalizeValue(input.next_step) : current.nextStep),
    summary: hasOwn(input, "summary") ? normalizeValue(input.summary) : current.summary,
    updatedAt: "",
  };
  if (isEmptyGoalState(merged)) {
    return createEmptyGoalState();
  }
  merged.updatedAt = normalizeValue(input.updatedAt || input.updated_at) || new Date().toISOString();
  return merged;
}

function isEmptyGoalState(state) {
  const normalized = normalizeGoalState(state);
  return !normalized.status && !normalized.stage && !normalized.nextStep && !normalized.summary;
}

function normalizeGoalStatus(value) {
  return normalizeValue(value).toLowerCase();
}

function createEmptyAppointmentScope() {
  return {
    chatId: "",
    workspaceId: "",
    appointmentsById: {},
    customerProfilesByName: {},
    pendingDraftsById: {},
    sequenceByDate: {},
  };
}

function normalizeAppointmentScope(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    chatId: normalizeValue(input.chatId),
    workspaceId: normalizeValue(input.workspaceId),
    appointmentsById: normalizeObjectMap(input.appointmentsById, normalizeAppointmentRecord),
    customerProfilesByName: normalizeObjectMap(input.customerProfilesByName, normalizeCustomerProfile),
    pendingDraftsById: normalizeObjectMap(input.pendingDraftsById, normalizeAppointmentDraft),
    sequenceByDate: normalizeNumberMap(input.sequenceByDate),
  };
}

function cloneAppointmentScope(scope) {
  return {
    chatId: normalizeValue(scope?.chatId),
    workspaceId: normalizeValue(scope?.workspaceId),
    appointmentsById: cloneObjectMap(scope?.appointmentsById),
    customerProfilesByName: cloneObjectMap(scope?.customerProfilesByName),
    pendingDraftsById: cloneObjectMap(scope?.pendingDraftsById),
    sequenceByDate: { ...(scope?.sequenceByDate || {}) },
  };
}

function normalizeAppointmentRecord(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    id: normalizeValue(input.id),
    chatId: normalizeValue(input.chatId),
    workspaceId: normalizeValue(input.workspaceId),
    customerName: normalizeValue(input.customerName),
    normalizedCustomerName: normalizeValue(input.normalizedCustomerName),
    serviceName: normalizeValue(input.serviceName),
    appointmentAt: normalizeValue(input.appointmentAt),
    reminderAt: normalizeValue(input.reminderAt),
    note: normalizeValue(input.note),
    status: normalizeAppointmentStatus(input.status),
    createdAt: normalizeValue(input.createdAt),
    updatedAt: normalizeValue(input.updatedAt),
    confirmedAt: normalizeValue(input.confirmedAt),
    reminderSentAt: normalizeValue(input.reminderSentAt),
    sourceMessageId: normalizeValue(input.sourceMessageId),
    sourceSenderId: normalizeValue(input.sourceSenderId),
    kind: normalizeValue(input.kind),
    title: normalizeValue(input.title),
  };
}

function normalizeCustomerProfile(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    displayName: normalizeValue(input.displayName),
    normalizedName: normalizeValue(input.normalizedName),
    profileNote: normalizeValue(input.profileNote),
    historyAppointmentIds: normalizeStringArray(input.historyAppointmentIds),
    updatedAt: normalizeValue(input.updatedAt),
  };
}

function normalizeAppointmentDraft(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    draftId: normalizeValue(input.draftId),
    chatId: normalizeValue(input.chatId),
    workspaceId: normalizeValue(input.workspaceId),
    customerName: normalizeValue(input.customerName),
    normalizedCustomerName: normalizeValue(input.normalizedCustomerName),
    serviceName: normalizeValue(input.serviceName),
    appointmentAt: normalizeValue(input.appointmentAt),
    reminderAt: normalizeValue(input.reminderAt),
    note: normalizeValue(input.note),
    sourceText: normalizeValue(input.sourceText),
    sourceMessageId: normalizeValue(input.sourceMessageId),
    sourceSenderId: normalizeValue(input.sourceSenderId),
    createdAt: normalizeValue(input.createdAt),
  };
}

function normalizeAppointmentStatus(value) {
  const normalized = normalizeValue(value).toLowerCase();
  if (normalized === "cancelled" || normalized === "completed") {
    return normalized;
  }
  return "pending";
}

function normalizeObjectMap(raw, normalizer) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const entries = Object.entries(raw)
    .map(([key, value]) => [normalizeValue(key), normalizer(value)])
    .filter(([key]) => !!key);
  return Object.fromEntries(entries);
}

function normalizeNumberMap(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const next = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = normalizeValue(key);
    const parsed = Number.parseInt(String(value || "").trim(), 10);
    if (!normalizedKey || !Number.isInteger(parsed) || parsed < 0) {
      continue;
    }
    next[normalizedKey] = parsed;
  }
  return next;
}

function cloneObjectMap(raw) {
  const next = {};
  for (const [key, value] of Object.entries(raw || {})) {
    next[key] = value && typeof value === "object" ? { ...value } : value;
  }
  return next;
}

function isEmptyAppointmentScope(scope) {
  return !Object.keys(scope?.appointmentsById || {}).length
    && !Object.keys(scope?.customerProfilesByName || {}).length
    && !Object.keys(scope?.pendingDraftsById || {}).length
    && !Object.keys(scope?.sequenceByDate || {}).length;
}

module.exports = { SessionStore };

#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SessionStore } = require("../src/infra/storage/session-store");
const { EvolvingMemoryStore } = require("../src/infra/memory/evolving-memory-store");
const { normalizeFeishuTextEvent } = require("../src/presentation/message/normalizers");
const { buildStatusPanelCard, buildWorkspaceBindingsCard } = require("../src/presentation/card/builders");
const dispatcher = require("../src/app/dispatcher");
const codexEvents = require("../src/app/codex-event-service");
const bridgeWakeupService = require("../src/domain/automation/bridge-wakeup-service");
const threadService = require("../src/domain/thread/thread-service");
const workspaceService = require("../src/domain/workspace/workspace-service");
const { FeishuBotRuntime } = require("../src/app/feishu-bot-runtime");
const mem0Extension = require("../extensions/mem0-extension");

async function main() {
  testCommandParsing();
  testDirectModeCoercesBridgeCommandsToMessages();
  testGoalPersistenceAndRemoval();
  testChatGoalPersistence();
  testGoalStatePersistence();
  testChatGoalStatePersistence();
  testAppointmentStatePersistsOnLoad();
  testGoalIsolationAcrossWorkspaces();
  await testGoalInjectionLifecycle();
  await testDirectModeSkipsGoalInjection();
  await testChatGoalInjectionLifecycle();
  await testGoalContinuationInjectionLifecycle();
  await testGoalStateDirectivePersistenceAndStrip();
  await testChatGoalStateDirectivePersistenceAndStrip();
  await testDirectModeStripsButDoesNotPersistGoalStateDirective();
  testStructuredMemoryStoreEvolutionLifecycle();
  await testMemoryEvolutionDirectivePersistenceAndStrip();
  await testMemoryInjectionIncludesStructuredContextAndContract();
  await testGoalStateInjectionLifecycle();
  await testBlockedGoalContinuationInjectionLifecycle();
  testGoalStateStreamingDirectiveHiddenFromDisplay();
  await testBridgeWakeupDirectivePersistenceAndDelivery();
  await testGoalSharedAcrossThreads();
  await testGoalCommandTextConsistency();
  await testChatGoalCommandWithoutWorkspace();
  await testThinModeGoalCommandHandledLocally();
  await testThinModeNaturalLanguageGoalBootstrap();
  await testProjectGoalClearOnlyClearsCurrentWorkspace();
  await testUnboundChatMessageCanFlowWithoutWorkspace();
  await testRemoveWorkspaceClearsGoalAndFallsBack();
  testStatusPanelGoalVisibility();
  await testEvolvingMemoryStatusResolution();
  await testAttachmentCacheDoctorText();
  await testDirectDoctorTextHidesBridgeGoalProgress();
  console.log("goal and doctor fixtures ok");
}

function testCommandParsing() {
  const config = { defaultWorkspaceId: "default" };
  const sender = { sender_id: { open_id: "ou_test" } };

  const goalShow = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_goal_show",
      content: JSON.stringify({ text: "/goal" }),
    },
  }, config);
  assert.strictEqual(goalShow.command, "goal");

  const goalSet = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_goal_set",
      content: JSON.stringify({ text: "/goal finish the deployment guide" }),
    },
  }, config);
  assert.strictEqual(goalSet.command, "goal");

  const doctor = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_doctor",
      content: JSON.stringify({ text: "/codex doctor" }),
    },
  }, config);
  assert.strictEqual(doctor.command, "doctor");

  const directGoal = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_goal_direct",
      content: JSON.stringify({ text: "/goal keep going" }),
    },
  }, {
    ...config,
    bridgeMode: "direct",
  });
  assert.strictEqual(directGoal.command, "message");
  assert.strictEqual(directGoal.text, "/goal keep going");
}

function testDirectModeCoercesBridgeCommandsToMessages() {
  const directGoal = dispatcher.coerceDirectModeCommandToMessage({
    command: "goal",
    text: "/goal finish the deployment guide",
  }, { bridgeMode: "direct" });
  assert.strictEqual(directGoal.command, "message");
  assert.strictEqual(directGoal.bridgeOriginalCommand, "goal");
  assert.strictEqual(dispatcher.shouldPassthroughToCodex(directGoal, { bridgeMode: "direct" }), true);

  const directDoctor = dispatcher.coerceDirectModeCommandToMessage({
    command: "doctor",
    text: "/codex doctor",
  }, { bridgeMode: "direct" });
  assert.strictEqual(directDoctor.command, "message");
  assert.strictEqual(directDoctor.bridgeOriginalCommand, "doctor");
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "unsupported_message",
  }, { bridgeMode: "direct" }), true);

  const thinGoal = dispatcher.coerceDirectModeCommandToMessage({
    command: "goal",
    text: "/goal finish the deployment guide",
  }, { bridgeMode: "thin" });
  assert.strictEqual(thinGoal.command, "goal");
}

function testGoalPersistenceAndRemoval() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-goal-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";
  const workspaceRoot = "/srv/project";

  store.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
  store.setGoalForWorkspace(bindingKey, workspaceRoot, "ship the cloud bot safely");
  assert.strictEqual(
    store.getGoalForWorkspace(bindingKey, workspaceRoot),
    "ship the cloud bot safely"
  );

  const reloaded = new SessionStore({ filePath });
  assert.strictEqual(
    reloaded.getGoalForWorkspace(bindingKey, workspaceRoot),
    "ship the cloud bot safely"
  );

  reloaded.removeWorkspace(bindingKey, workspaceRoot);
  assert.strictEqual(reloaded.getGoalForWorkspace(bindingKey, workspaceRoot), "");
}

function testChatGoalPersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-chat-goal-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";

  store.setChatGoal(bindingKey, "act like the current Codex chat window");
  store.setChatThreadId(bindingKey, "thread_chat_1");
  assert.strictEqual(store.getChatGoal(bindingKey), "act like the current Codex chat window");
  assert.strictEqual(store.getChatThreadId(bindingKey), "thread_chat_1");

  const reloaded = new SessionStore({ filePath });
  assert.strictEqual(reloaded.getChatGoal(bindingKey), "act like the current Codex chat window");
  assert.strictEqual(reloaded.getChatThreadId(bindingKey), "thread_chat_1");
}

function testGoalStatePersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-goal-state-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";
  const workspaceRoot = "/srv/project";

  store.setGoalForWorkspace(bindingKey, workspaceRoot, "ship the cloud bot safely");
  store.setGoalStateForWorkspace(bindingKey, workspaceRoot, {
    status: "active",
    stage: "finish goal-state delivery",
    nextStep: "wire doctor output",
    summary: "working through the first milestone",
  });

  const saved = store.getGoalStateForWorkspace(bindingKey, workspaceRoot);
  assert.strictEqual(saved.status, "active");
  assert.strictEqual(saved.stage, "finish goal-state delivery");
  assert.strictEqual(saved.nextStep, "wire doctor output");
  assert.strictEqual(saved.summary, "working through the first milestone");
  assert.ok(saved.updatedAt);

  const reloaded = new SessionStore({ filePath });
  const persisted = reloaded.getGoalStateForWorkspace(bindingKey, workspaceRoot);
  assert.strictEqual(persisted.status, "active");
  assert.strictEqual(persisted.stage, "finish goal-state delivery");

  reloaded.setGoalForWorkspace(bindingKey, workspaceRoot, "");
  assert.deepStrictEqual(reloaded.getGoalStateForWorkspace(bindingKey, workspaceRoot), {
    status: "",
    stage: "",
    nextStep: "",
    summary: "",
    updatedAt: "",
  });
}

function testChatGoalStatePersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-chat-goal-state-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";

  store.setChatGoal(bindingKey, "act like the current Codex chat window");
  store.setChatGoalState(bindingKey, {
    status: "blocked",
    stage: "waiting on browser",
    nextStep: "enable cloud browser runtime",
  });

  const saved = store.getChatGoalState(bindingKey);
  assert.strictEqual(saved.status, "blocked");
  assert.strictEqual(saved.stage, "waiting on browser");
  assert.strictEqual(saved.nextStep, "enable cloud browser runtime");
  assert.ok(saved.updatedAt);

  const reloaded = new SessionStore({ filePath });
  const persisted = reloaded.getChatGoalState(bindingKey);
  assert.strictEqual(persisted.status, "blocked");
  assert.strictEqual(persisted.stage, "waiting on browser");

  reloaded.setChatGoal(bindingKey, "");
  assert.deepStrictEqual(reloaded.getChatGoalState(bindingKey), {
    status: "",
    stage: "",
    nextStep: "",
    summary: "",
    updatedAt: "",
  });
}

function testAppointmentStatePersistsOnLoad() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-persist-load-"));
  const filePath = path.join(tempDir, "sessions.json");
  fs.writeFileSync(filePath, JSON.stringify({
    bindings: {
      "default:oc_test:sender:ou_test": {
        updatedAt: "2026-05-26T00:00:00.000Z",
      },
    },
    appointmentStateByChatScopeKey: {
      "default:oc_test": {
        appointmentsById: {
          "260525-001": {
            id: "260525-001",
            title: "legacy appointment",
          },
        },
      },
    },
  }, null, 2));

  const store = new SessionStore({ filePath });
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const scope = store.getAppointmentScope("default:oc_test");

  assert.strictEqual(store.getBinding("default:oc_test:sender:ou_test").updatedAt, "2026-05-26T00:00:00.000Z");
  assert.ok(Object.prototype.hasOwnProperty.call(persisted, "appointmentStateByChatScopeKey"));
  assert.ok(scope.appointmentsById["260525-001"]);
  assert.strictEqual(scope.appointmentsById["260525-001"].title, "legacy appointment");
  assert.strictEqual(scope.appointmentsById["260525-001"].status, "pending");
}

function testGoalIsolationAcrossWorkspaces() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-goal-isolation-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";
  const workspaceA = "/srv/project-a";
  const workspaceB = "/srv/project-b";

  store.setActiveWorkspaceRoot(bindingKey, workspaceA);
  store.setGoalForWorkspace(bindingKey, workspaceA, "finish project A");
  store.setActiveWorkspaceRoot(bindingKey, workspaceB);
  store.setGoalForWorkspace(bindingKey, workspaceB, "finish project B");

  assert.strictEqual(store.getGoalForWorkspace(bindingKey, workspaceA), "finish project A");
  assert.strictEqual(store.getGoalForWorkspace(bindingKey, workspaceB), "finish project B");

  store.removeWorkspace(bindingKey, workspaceA);
  assert.strictEqual(store.getGoalForWorkspace(bindingKey, workspaceA), "");
  assert.strictEqual(store.getGoalForWorkspace(bindingKey, workspaceB), "finish project B");
}

async function testGoalInjectionLifecycle() {
  const withGoal = await captureGoalWrappedMessage("close the deployment checklist", "ship safely today");
  assert.ok(withGoal.includes("<feishu-project-goal>"));
  assert.ok(withGoal.includes("<feishu-goal-contract>"));
  assert.ok(withGoal.includes("[[codex-goal-state:"));
  assert.ok(withGoal.includes("ship safely today"));
  assert.ok(withGoal.endsWith("close the deployment checklist"));

  const clearedGoal = await captureGoalWrappedMessage("close the deployment checklist", "");
  assert.ok(!clearedGoal.includes("</feishu-project-goal>"));
  assert.ok(clearedGoal.includes("<feishu-bridge-capabilities>"));
  assert.ok(clearedGoal.endsWith("close the deployment checklist"));
}

async function testDirectModeSkipsGoalInjection() {
  const directMessage = await captureGoalWrappedMessage(
    "close the deployment checklist",
    "ship safely today",
    null,
    { bridgeMode: "direct" }
  );
  assert.ok(directMessage.includes("<feishu-bridge-capabilities>"));
  assert.ok(!directMessage.includes("<feishu-project-goal>"));
  assert.ok(!directMessage.includes("<feishu-goal-contract>"));
  assert.ok(!directMessage.includes("codex-goal-state"));
  assert.ok(directMessage.endsWith("close the deployment checklist"));
}

async function testChatGoalInjectionLifecycle() {
  const withGoal = await captureChatGoalWrappedMessage("keep going in the same Feishu chat", "act like this Codex window");
  assert.ok(withGoal.includes("<feishu-chat-goal>"));
  assert.ok(withGoal.includes("<feishu-goal-contract>"));
  assert.ok(withGoal.includes("act like this Codex window"));
  assert.ok(withGoal.endsWith("keep going in the same Feishu chat"));

  const clearedGoal = await captureChatGoalWrappedMessage("keep going in the same Feishu chat", "");
  assert.ok(!clearedGoal.includes("</feishu-chat-goal>"));
  assert.ok(clearedGoal.includes("<feishu-bridge-capabilities>"));
}

async function testGoalContinuationInjectionLifecycle() {
  const projectContinue = await captureGoalWrappedMessage("继续", "ship safely today");
  assert.ok(projectContinue.includes("<feishu-goal-mode>"));
  assert.ok(projectContinue.includes("continuation against the active goal"));
  assert.ok(projectContinue.endsWith("继续"));

  const chatContinue = await captureChatGoalWrappedMessage(
    "continue",
    "act like this Codex window",
    {
      status: "active",
      stage: "goal-state delivery complete",
      nextStep: "start sub-stage advancement",
      summary: "first milestone finished",
    }
  );
  assert.ok(chatContinue.includes("<feishu-goal-mode>"));
  assert.ok(chatContinue.includes("Resume from the most recent progress"));
  assert.ok(chatContinue.includes("The current remembered stage is: goal-state delivery complete"));
  assert.ok(chatContinue.includes("start by executing this remembered next step first: start sub-stage advancement"));
  assert.ok(chatContinue.endsWith("continue"));

  const nonContinuation = await captureGoalWrappedMessage("close the deployment checklist", "ship safely today");
  assert.ok(!nonContinuation.includes("<feishu-goal-mode>"));
}

async function testGoalStateDirectivePersistenceAndStrip() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-goal-state-directive-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";
  const workspaceRoot = "/srv/project";
  store.setGoalForWorkspace(bindingKey, workspaceRoot, "ship safely today");

  const cleaned = await mem0Extension.hooks.afterCodexReply({
    event: {
      payload: {
        mode: "completed_snapshot",
        normalized: {
          workspaceId: "default",
          chatId: "oc_test",
          threadKey: "",
          senderId: "ou_test",
          messageId: "om_state",
          command: "message",
          text: "continue",
          workspaceRoot,
        },
      },
    },
    text: [
      "Milestone one is done.",
      "",
      "[[codex-goal-state:{\"status\":\"active\",\"stage\":\"goal detection done\",\"nextStep\":\"wire stage display\",\"summary\":\"first milestone complete\"}]]",
    ].join("\n"),
    runtime: {
      sessionStore: store,
      resolveWorkspaceRootForBinding(key) {
        return store.getActiveWorkspaceRoot(key);
      },
    },
  });

  assert.ok(!cleaned.includes("codex-goal-state"));
  assert.ok(cleaned.includes("Milestone one is done."));
  const state = store.getGoalStateForWorkspace(bindingKey, workspaceRoot);
  assert.strictEqual(state.status, "active");
  assert.strictEqual(state.stage, "goal detection done");
  assert.strictEqual(state.nextStep, "wire stage display");
  assert.strictEqual(state.summary, "first milestone complete");
}

async function testChatGoalStateDirectivePersistenceAndStrip() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-chat-goal-state-directive-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";
  store.setChatGoal(bindingKey, "act like the current Codex chat window");

  const cleaned = await mem0Extension.hooks.afterCodexReply({
    event: {
      payload: {
        mode: "completed_snapshot",
        normalized: {
          workspaceId: "default",
          chatId: "oc_test",
          threadKey: "",
          senderId: "ou_test",
          messageId: "om_chat_state",
          command: "message",
          text: "continue",
        },
      },
    },
    text: [
      "Chat milestone done.",
      "",
      "[[codex-goal-state:{\"status\":\"completed\",\"stage\":\"chat baseline ready\",\"nextStep\":\"\",\"summary\":\"chat-only goal is done\"}]]",
    ].join("\n"),
    runtime: {
      sessionStore: store,
      resolveWorkspaceRootForBinding() {
        return "";
      },
    },
  });

  assert.ok(!cleaned.includes("codex-goal-state"));
  assert.ok(cleaned.includes("Chat milestone done."));
  const state = store.getChatGoalState(bindingKey);
  assert.strictEqual(state.status, "completed");
  assert.strictEqual(state.stage, "chat baseline ready");
  assert.strictEqual(state.summary, "chat-only goal is done");
}

async function testDirectModeStripsButDoesNotPersistGoalStateDirective() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-goal-state-direct-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";
  const workspaceRoot = "/srv/project";
  store.setGoalForWorkspace(bindingKey, workspaceRoot, "ship safely today");

  const cleaned = await mem0Extension.hooks.afterCodexReply({
    event: {
      payload: {
        mode: "completed_snapshot",
        normalized: {
          workspaceId: "default",
          chatId: "oc_test",
          threadKey: "",
          senderId: "ou_test",
          messageId: "om_state_direct",
          command: "message",
          text: "continue",
          workspaceRoot,
        },
      },
    },
    text: [
      "Milestone one is done.",
      "",
      "[[codex-goal-state:{\"status\":\"active\",\"stage\":\"goal detection done\",\"nextStep\":\"wire stage display\",\"summary\":\"first milestone complete\"}]]",
    ].join("\n"),
    runtime: {
      config: {
        bridgeMode: "direct",
      },
      sessionStore: store,
      resolveWorkspaceRootForBinding(key) {
        return store.getActiveWorkspaceRoot(key);
      },
    },
  });

  assert.ok(!cleaned.includes("codex-goal-state"));
  assert.ok(cleaned.includes("Milestone one is done."));
  assert.deepStrictEqual(store.getGoalStateForWorkspace(bindingKey, workspaceRoot), {
    status: "",
    stage: "",
    nextStep: "",
    summary: "",
    updatedAt: "",
  });
}

function testStructuredMemoryStoreEvolutionLifecycle() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-evolving-memory-"));
  const filePath = path.join(tempDir, "memory.json");
  const store = new EvolvingMemoryStore({ filePath, retrievalLimit: 6 });
  const userId = "feishu:ou_test_memory";

  const first = store.applyEvolution({
    userId,
    evolution: {
      upserts: [
        {
          key: "pref_direct_execution",
          kind: "preference",
          summary: "User prefers direct execution when it is safe.",
          confidence: "high",
          relevanceHints: ["execute", "direct", "safe"],
        },
        {
          key: "constraint_codex_1_cloud_only",
          kind: "constraint",
          summary: "Codex-1 refers to the cloud Feishu-side runtime only.",
          confidence: "high",
          relevanceHints: ["Codex-1", "cloud", "Feishu"],
        },
      ],
      profileSummary: "Prefers direct execution and keeps Codex-1 scoped to the cloud side.",
    },
  });
  assert.deepStrictEqual(first.deletedKeys, []);
  assert.deepStrictEqual(first.upsertedKeys.sort(), [
    "constraint_codex_1_cloud_only",
    "pref_direct_execution",
  ]);

  const second = store.applyEvolution({
    userId,
    evolution: {
      upserts: [
        {
          key: "pref_direct_execution_no_loops",
          kind: "preference",
          summary: "User prefers direct execution with minimal confirmation loops.",
          confidence: "high",
          supersedes: ["pref_direct_execution"],
          relevanceHints: ["direct", "confirmation", "loops"],
        },
      ],
      deleteKeys: ["constraint_codex_1_cloud_only"],
      profileSummary: "Prefers direct execution with minimal loops.",
    },
  });
  assert.ok(second.deletedKeys.includes("pref_direct_execution"));
  assert.ok(second.deletedKeys.includes("constraint_codex_1_cloud_only"));

  const profile = store.getUserProfile(userId);
  assert.strictEqual(profile.profileSummary, "Prefers direct execution with minimal loops.");
  assert.strictEqual(profile.memories.length, 1);
  assert.strictEqual(profile.memories[0].key, "pref_direct_execution_no_loops");

  const relevant = store.getRelevantMemories({
    userId,
    query: "Can you execute directly without asking in loops?",
  });
  assert.strictEqual(relevant.length, 1);
  assert.strictEqual(relevant[0].key, "pref_direct_execution_no_loops");
}

async function testMemoryEvolutionDirectivePersistenceAndStrip() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-memory-directive-"));
  const filePath = path.join(tempDir, "memory.json");
  const store = new EvolvingMemoryStore({ filePath, retrievalLimit: 6 });
  mem0Extension.__testing.setDependencies({
    mem0Client: {
      isEnabled() {
        return false;
      },
      buildUserId(senderId) {
        return senderId ? `feishu:${senderId}` : "";
      },
    },
    structuredMemoryStore: store,
  });

  try {
    const cleaned = await mem0Extension.hooks.afterCodexReply({
      event: {
        payload: {
          mode: "completed_snapshot",
          normalized: {
            workspaceId: "default",
            chatId: "oc_test",
            threadKey: "",
            senderId: "ou_memory",
            messageId: "om_memory_state",
            command: "message",
            text: "Remember how I prefer you to work.",
          },
        },
      },
      text: [
        "I will remember that.",
        "",
        "[[codex-memory-evolution:{\"upserts\":[{\"key\":\"pref_goal_mode_until_done\",\"kind\":\"workflow\",\"summary\":\"User wants goal-mode execution until the task is fully done.\",\"confidence\":\"high\",\"evidence\":\"The user repeatedly asks to keep going until completion.\",\"relevanceHints\":[\"goal mode\",\"continue\",\"done\"]}],\"profileSummary\":\"Prefers goal-mode execution until completion.\"}]]",
      ].join("\n"),
      runtime: {
        sessionStore: new SessionStore({ filePath: path.join(tempDir, "sessions.json") }),
      },
    });

    assert.ok(!cleaned.includes("codex-memory-evolution"));
    assert.ok(cleaned.includes("I will remember that."));

    const profile = store.getUserProfile("feishu:ou_memory");
    assert.strictEqual(profile.profileSummary, "Prefers goal-mode execution until completion.");
    assert.strictEqual(profile.memories.length, 1);
    assert.strictEqual(profile.memories[0].key, "pref_goal_mode_until_done");
    assert.strictEqual(profile.memories[0].kind, "workflow");
  } finally {
    mem0Extension.__testing.resetDependencies();
  }
}

async function testMemoryInjectionIncludesStructuredContextAndContract() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-memory-injection-"));
  const filePath = path.join(tempDir, "memory.json");
  const store = new EvolvingMemoryStore({ filePath, retrievalLimit: 6 });
  const userId = "feishu:ou_memory";
  store.applyEvolution({
    userId,
    evolution: {
      upserts: [
        {
          key: "pref_direct_execution",
          kind: "preference",
          summary: "User prefers direct execution when it is safe.",
          confidence: "high",
          relevanceHints: ["execute", "direct", "safe"],
        },
      ],
      profileSummary: "Prefers direct execution when it is safe.",
    },
  });

  mem0Extension.__testing.setDependencies({
    mem0Client: {
      isEnabled() {
        return false;
      },
      buildUserId(senderId) {
        return senderId ? `feishu:${senderId}` : "";
      },
    },
    structuredMemoryStore: store,
  });

  try {
    const enriched = await mem0Extension.hooks.beforeMessage({
      normalized: {
        command: "message",
        text: "Please continue and execute directly if it is safe.",
        senderId: "ou_memory",
      },
    });

    assert.ok(enriched.text.includes("<feishu-user-memory>"));
    assert.ok(enriched.text.includes("Prefers direct execution when it is safe."));
    assert.ok(enriched.text.includes("<feishu-memory-contract>"));
    assert.ok(enriched.text.includes("codex-memory-evolution"));
    assert.ok(enriched.text.includes("下面是用户当前这条新消息"));
  } finally {
    mem0Extension.__testing.resetDependencies();
  }
}

async function testGoalStateInjectionLifecycle() {
  const withState = await captureGoalWrappedMessage(
    "continue",
    "ship safely today",
    {
      status: "active",
      stage: "goal-state delivery complete",
      nextStep: "start sub-stage advancement",
      summary: "first milestone finished",
    }
  );
  assert.ok(withState.includes("<feishu-goal-state>"));
  assert.ok(withState.includes("<feishu-goal-contract>"));
  assert.ok(withState.includes("status: active"));
  assert.ok(withState.includes("stage: goal-state delivery complete"));
  assert.ok(withState.includes("next_step: start sub-stage advancement"));
  assert.ok(withState.includes("summary: first milestone finished"));
  assert.ok(withState.includes("Keep stage names stable across nearby turns."));
  assert.ok(withState.includes("do not restart discovery or ask what to do next"));
  assert.ok(withState.includes("nextStep should name the single best immediate action after this reply"));
}

async function testBlockedGoalContinuationInjectionLifecycle() {
  const blockedContinue = await captureChatGoalWrappedMessage(
    "继续",
    "act like this Codex window",
    {
      status: "blocked",
      stage: "waiting on browser runtime",
      nextStep: "enable browser runtime",
      summary: "execution paused on missing runtime",
    }
  );
  assert.ok(blockedContinue.includes("The remembered goal state is blocked."));
  assert.ok(blockedContinue.includes("single unblock request"));
  assert.ok(blockedContinue.includes("The current remembered stage is: waiting on browser runtime"));
}

function testGoalStateStreamingDirectiveHiddenFromDisplay() {
  const runtime = {
    hiddenGoalDirectiveStateByRunKey: new Map(),
    currentRunKeyByThreadId: new Map([
      ["thread_test", "thread_test:turn_test"],
    ]),
    activeTurnIdByThreadId: new Map([
      ["thread_test", "turn_test"],
    ]),
  };

  const first = codexEvents.stripHiddenGoalStateDirectiveForDisplay(runtime, {
    threadId: "thread_test",
    turnId: "turn_test",
    text: "FIRST_OK\n[[codex-goal-state:{\"status\":\"active\"",
    mode: "delta",
  });
  assert.strictEqual(first, "FIRST_OK\n");

  const second = codexEvents.stripHiddenGoalStateDirectiveForDisplay(runtime, {
    threadId: "thread_test",
    turnId: "turn_test",
    text: ",\"stage\":\"phase one\"}]]SECOND_OK",
    mode: "delta",
  });
  assert.strictEqual(second, "SECOND_OK");

  const memoryFirst = codexEvents.stripHiddenGoalStateDirectiveForDisplay(runtime, {
    threadId: "thread_test",
    turnId: "turn_test",
    text: "VISIBLE\n[[codex-memory-evolution:{\"upserts\":[{\"key\":\"pref_direct_execution\"",
    mode: "delta",
  });
  assert.strictEqual(memoryFirst, "VISIBLE\n");

  const memorySecond = codexEvents.stripHiddenGoalStateDirectiveForDisplay(runtime, {
    threadId: "thread_test",
    turnId: "turn_test",
    text: ",\"kind\":\"preference\",\"summary\":\"Direct execution.\"}]}]]DONE",
    mode: "delta",
  });
  assert.strictEqual(memorySecond, "DONE");

  const finalSnapshot = codexEvents.stripHiddenGoalStateDirectiveForDisplay(runtime, {
    threadId: "thread_test",
    turnId: "turn_test",
    text: "DONE\n[[codex-goal-state:{\"status\":\"completed\"}]]",
    mode: "completed_snapshot",
  });
  assert.strictEqual(finalSnapshot, "DONE\n");
  assert.strictEqual(runtime.hiddenGoalDirectiveStateByRunKey.size, 0);
}

async function testBridgeWakeupDirectivePersistenceAndDelivery() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-bridge-wakeup-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const sent = [];
  const runtime = {
    config: {
      feishuStreamingOutput: true,
      attachmentsDir: "",
    },
    sessionStore: store,
    hiddenGoalDirectiveStateByRunKey: new Map(),
    currentRunKeyByThreadId: new Map([["thread_test", "thread_test:turn_test"]]),
    activeTurnIdByThreadId: new Map([["thread_test", "turn_test"]]),
    sentAttachmentDirectiveKeys: new Set(),
    workspaceRootByThreadId: new Map(),
    runAfterCodexReplyHook({ text }) {
      return Promise.resolve(text);
    },
    upsertAssistantReplyCard(payload) {
      sent.push(["card", payload.text]);
      return Promise.resolve();
    },
    flushAssistantReplyCardNow() {
      return Promise.resolve();
    },
    cleanupThreadRuntimeState() {},
    requireFeishuAdapter() {
      return {
        sendTextByChatId(payload) {
          sent.push(["text", payload]);
          return Promise.resolve();
        },
      };
    },
    resolveWorkspaceRootForThread() {
      return "";
    },
    sendInfoCardMessage() {
      return Promise.resolve();
    },
    sendLocalAttachmentToFeishu() {
      return Promise.resolve();
    },
    getBindingContext(normalized) {
      return {
        bindingKey: `binding:${normalized.messageId}`,
        workspaceRoot: "/srv/project",
      };
    },
  };

  await codexEvents.deliverToFeishu(runtime, {
    type: "im.agent_reply",
    payload: {
      threadId: "thread_test",
      turnId: "turn_test",
      chatId: "oc_test",
      text: "VISIBLE\n[[codex-feishu-wakeup:{\"runAt\":\"2026-05-26T10:00:00+08:00\",\"text\":\"18:50 记得带电动螺丝刀回家\",\"title\":\"带回家\",\"replyInThread\":true}]]",
      mode: "completed_snapshot",
      normalized: {
        messageId: "om_source",
        threadKey: "thread_key_test",
      },
    },
  });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][0], "card");
  assert.strictEqual(sent[0][1], "VISIBLE\n");

  const tasks = store.listBridgeWakeupTasks();
  const taskIds = Object.keys(tasks);
  assert.strictEqual(taskIds.length, 1);
  assert.strictEqual(tasks[taskIds[0]].text, "18:50 记得带电动螺丝刀回家");
  assert.strictEqual(tasks[taskIds[0]].chatId, "oc_test");
  assert.strictEqual(tasks[taskIds[0]].replyToMessageId, "om_source");

  await bridgeWakeupService.flushDueBridgeWakeupTasks(runtime, new Date("2026-05-26T02:01:00.000Z"));

  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1][0], "text");
  assert.strictEqual(sent[1][1].chatId, "oc_test");
  assert.strictEqual(sent[1][1].text, "18:50 记得带电动螺丝刀回家");

  const deliveredTask = store.listBridgeWakeupTasks()[taskIds[0]];
  assert.strictEqual(deliveredTask.status, "delivered");
  assert.ok(deliveredTask.deliveredAt);
}

async function testGoalSharedAcrossThreads() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-goal-threads-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";
  const workspaceRoot = "/srv/project";

  store.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
  store.setGoalForWorkspace(bindingKey, workspaceRoot, "ship safely today");
  store.setThreadIdForWorkspace(bindingKey, workspaceRoot, "thread_a");

  const threadA = await captureGoalWrappedMessage(
    "close the deployment checklist",
    store.getGoalForWorkspace(bindingKey, workspaceRoot)
  );
  store.setThreadIdForWorkspace(bindingKey, workspaceRoot, "thread_b");
  const threadB = await captureGoalWrappedMessage(
    "answer the next question",
    store.getGoalForWorkspace(bindingKey, workspaceRoot)
  );

  assert.ok(threadA.includes("ship safely today"));
  assert.ok(threadB.includes("ship safely today"));
  assert.ok(threadB.endsWith("answer the next question"));
}

async function testGoalCommandTextConsistency() {
  const sent = [];
  const runtime = {
    sendInfoCardMessage(payload) {
      sent.push(payload.text);
      return Promise.resolve();
    },
    resolveReplyToMessageId(normalized, replyToMessageId) {
      return replyToMessageId || normalized.messageId;
    },
    getBindingContext() {
      return {
        bindingKey: "default:oc_test:sender:ou_test",
        workspaceRoot: "/srv/project",
      };
    },
    sessionStore: {
      getGoalForWorkspace() {
        return "ship safely today";
      },
      getChatGoal() {
        return "";
      },
    },
  };

  await workspaceService.handleGoalCommand(runtime, {
    chatId: "oc_test",
    messageId: "om_goal_show",
    text: "/goal",
  });

  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].includes("/srv/project"));
  assert.ok(sent[0].includes("ship safely today"));
  assert.ok(sent[0].includes("继续"));
  assert.ok(sent[0].includes("`/goal clear`"));
}

async function testChatGoalCommandWithoutWorkspace() {
  const sent = [];
  let chatGoal = "";
  const runtime = {
    sendInfoCardMessage(payload) {
      sent.push(payload.text);
      return Promise.resolve();
    },
    getBindingContext() {
      return { bindingKey: "default:oc_test:sender:ou_test", workspaceRoot: "" };
    },
    sessionStore: {
      getChatGoal() {
        return chatGoal;
      },
      setChatGoal(_bindingKey, nextGoal) {
        chatGoal = nextGoal;
      },
    },
  };

  await workspaceService.handleGoalCommand(runtime, { chatId: "oc_test", messageId: "om_goal_show_chat", text: "/goal" });
  await workspaceService.handleGoalCommand(runtime, { chatId: "oc_test", messageId: "om_goal_set_chat", text: "/goal 像当前 Codex 窗口一样持续推进" });
  await workspaceService.handleGoalCommand(runtime, { chatId: "oc_test", messageId: "om_goal_clear_chat", text: "/goal clear" });

  assert.strictEqual(sent.length, 3);
  assert.ok(sent[0].includes("当前会话：未绑定项目时的飞书聊天窗口"));
  assert.ok(sent[1].includes("已更新当前会话目标"));
  assert.ok(sent[2].includes("已清除当前会话目标"));
  assert.ok(sent[0].includes("继续"));
  assert.strictEqual(chatGoal, "");
}

async function testThinModeGoalCommandHandledLocally() {
  const config = {
    defaultWorkspaceId: "default",
    bridgeMode: "thin",
  };
  const sender = { sender_id: { open_id: "ou_test" } };
  const event = {
    sender,
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_goal_thin",
      content: JSON.stringify({ text: "/goal keep the current cloud objective moving" }),
    },
  };

  const dispatchedCommands = [];
  const ensured = [];
  const runtime = {
    config,
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialAppointmentMessage: async (normalized) => normalized,
    handlePotentialPluginIntentMessage: async (normalized) => normalized,
    runBeforeMessageHook: async ({ normalized }) => normalized,
    dispatchTextCommand: async (normalized) => {
      dispatchedCommands.push(normalized.command);
      return normalized.command === "goal";
    },
    getCurrentThreadContext() {
      return { bindingKey: "default:oc_test:sender:ou_test", workspaceRoot: "", threadId: "" };
    },
    setPendingBindingContext() {},
    setPendingThreadContext() {},
    addPendingReaction: async () => {},
    movePendingReactionToThread() {},
    clearPendingReactionForBinding: async () => {},
    sendInfoCardMessage: async () => {},
    ensureThreadAndSendMessage: async (payload) => {
      ensured.push(payload);
      return "thread_should_not_start";
    },
  };

  await dispatcher.onFeishuTextEvent(runtime, event);

  assert.deepStrictEqual(dispatchedCommands, ["goal"]);
  assert.strictEqual(ensured.length, 0);
}

async function testThinModeNaturalLanguageGoalBootstrap() {
  const config = {
    defaultWorkspaceId: "default",
    bridgeMode: "thin",
    goalNaturalLanguageInterceptEnabled: true,
  };
  const sender = { sender_id: { open_id: "ou_test" } };
  const event = {
    sender,
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_goal_bootstrap",
      content: JSON.stringify({ text: "目标是让codex-1能力非常的强，按goal模式去做" }),
    },
  };

  const ensured = [];
  const store = new SessionStore({
    filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-goal-bootstrap-")), "sessions.json"),
  });
  const runtime = {
    config,
    sessionStore: store,
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialAppointmentMessage: async (normalized) => normalized,
    handlePotentialGoalMessage: async (normalized) => {
      const goalService = require("../src/domain/goal/service");
      return goalService.handlePotentialGoalMessage(runtime, normalized);
    },
    handlePotentialPluginIntentMessage: async (normalized) => normalized,
    runBeforeMessageHook: async ({ normalized }) => normalized,
    dispatchTextCommand: async () => false,
    getCurrentThreadContext() {
      return { bindingKey: "default:oc_test:sender:ou_test", workspaceRoot: "", threadId: "" };
    },
    setPendingBindingContext() {},
    setPendingThreadContext() {},
    addPendingReaction: async () => {},
    movePendingReactionToThread() {},
    clearPendingReactionForBinding: async () => {},
    sendInfoCardMessage: async () => {},
    ensureThreadAndSendMessage: async (payload) => {
      ensured.push(payload);
      return "thread_goal_bootstrap";
    },
  };

  await dispatcher.onFeishuTextEvent(runtime, event);

  assert.strictEqual(ensured.length, 1);
  assert.strictEqual(store.getChatGoal("default:oc_test:sender:ou_test"), "让codex-1能力非常的强");
  const state = store.getChatGoalState("default:oc_test:sender:ou_test");
  assert.strictEqual(state.status, "active");
  assert.ok(state.stage);
  assert.ok(state.nextStep.includes("继续按当前目标推进"));
}

async function testProjectGoalClearOnlyClearsCurrentWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-goal-clear-current-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";
  const workspaceA = "/srv/project-a";
  const workspaceB = "/srv/project-b";
  store.setGoalForWorkspace(bindingKey, workspaceA, "finish project A");
  store.setGoalForWorkspace(bindingKey, workspaceB, "finish project B");
  store.setChatGoal(bindingKey, "keep chat goal");

  const statusCalls = [];
  const infoCalls = [];
  const runtime = {
    sessionStore: store,
    getBindingContext() {
      return { bindingKey, workspaceRoot: workspaceA };
    },
    showStatusPanel(normalized, options) {
      statusCalls.push({ normalized, options });
      return Promise.resolve();
    },
    sendInfoCardMessage(payload) {
      infoCalls.push(payload.text);
      return Promise.resolve();
    },
  };

  await workspaceService.handleGoalCommand(runtime, {
    chatId: "oc_test",
    messageId: "om_goal_clear_project",
    text: "/goal clear",
  });

  assert.strictEqual(store.getGoalForWorkspace(bindingKey, workspaceA), "");
  assert.strictEqual(store.getGoalForWorkspace(bindingKey, workspaceB), "finish project B");
  assert.strictEqual(store.getChatGoal(bindingKey), "keep chat goal");
  assert.strictEqual(statusCalls.length, 1);
  assert.strictEqual(statusCalls[0].options.noticeText, "已清除当前项目目标。");
  assert.strictEqual(infoCalls.length, 0);
}

async function testUnboundChatMessageCanFlowWithoutWorkspace() {
  const ensured = [];
  const config = { defaultWorkspaceId: "default" };
  const sender = { sender_id: { open_id: "ou_test" } };
  const event = {
    sender,
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_unbound_chat",
      content: JSON.stringify({ text: "继续，像这个窗口一样聊下去" }),
    },
  };
  const runtime = {
    config,
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialAppointmentMessage: async (normalized) => normalized,
    handlePotentialPluginIntentMessage: async (normalized) => normalized,
    runBeforeMessageHook: async ({ normalized }) => normalized,
    dispatchTextCommand: async () => false,
    getCurrentThreadContext() {
      return { bindingKey: "default:oc_test:sender:ou_test", workspaceRoot: "", threadId: "" };
    },
    setPendingBindingContext() {},
    setPendingThreadContext() {},
    addPendingReaction: async () => {},
    movePendingReactionToThread() {},
    clearPendingReactionForBinding: async () => {},
    sendInfoCardMessage: async () => {},
    ensureThreadAndSendMessage: async (payload) => {
      ensured.push(payload);
      return "thread_chat_unbound";
    },
  };

  await dispatcher.onFeishuTextEvent(runtime, event);

  assert.strictEqual(ensured.length, 1);
  assert.strictEqual(ensured[0].workspaceRoot, "");
  assert.strictEqual(ensured[0].bindingKey, "default:oc_test:sender:ou_test");
}

async function testRemoveWorkspaceClearsGoalAndFallsBack() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-goal-remove-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });
  const bindingKey = "default:oc_test:sender:ou_test";
  const workspaceA = "/srv/project-a";
  const workspaceB = "/srv/project-b";
  store.setThreadIdForWorkspace(bindingKey, workspaceA, "thread_a");
  store.setGoalForWorkspace(bindingKey, workspaceA, "finish project A");
  store.setThreadIdForWorkspace(bindingKey, workspaceB, "thread_b");
  store.setGoalForWorkspace(bindingKey, workspaceB, "finish project B");
  store.setActiveWorkspaceRoot(bindingKey, workspaceA);

  const statusCalls = [];
  const infoCalls = [];
  const runtime = {
    sessionStore: store,
    getBindingContext() {
      return { bindingKey, workspaceRoot: workspaceA };
    },
    resolveWorkspaceRootForBinding(key) {
      return store.getActiveWorkspaceRoot(key);
    },
    listBoundWorkspaces(binding) {
      return [
        {
          workspaceRoot: workspaceA,
          isActive: binding.activeWorkspaceRoot === workspaceA,
          threadId: store.getThreadIdForWorkspace(bindingKey, workspaceA),
          goal: store.getGoalForWorkspace(bindingKey, workspaceA),
        },
        {
          workspaceRoot: workspaceB,
          isActive: binding.activeWorkspaceRoot === workspaceB,
          threadId: store.getThreadIdForWorkspace(bindingKey, workspaceB),
          goal: store.getGoalForWorkspace(bindingKey, workspaceB),
        },
      ].filter((item) => item.threadId || item.goal || item.isActive);
    },
    resolveWorkspaceThreadState() {
      return Promise.resolve({ threads: [], threadId: "thread_b" });
    },
    showStatusPanel(normalized, options) {
      statusCalls.push({ normalized, options });
      return Promise.resolve();
    },
    sendInfoCardMessage(payload) {
      infoCalls.push(payload.text);
      return Promise.resolve();
    },
  };

  await workspaceService.removeWorkspaceByPath(runtime, {
    chatId: "oc_test",
    messageId: "om_remove_workspace",
    text: `/codex remove ${workspaceA}`,
  }, workspaceA, { replyToMessageId: "om_remove_workspace" });

  assert.strictEqual(store.getGoalForWorkspace(bindingKey, workspaceA), "");
  assert.strictEqual(store.getActiveWorkspaceRoot(bindingKey), workspaceB);
  assert.strictEqual(statusCalls.length, 1);
  assert.strictEqual(statusCalls[0].options.noticeText, "已移除项目，并切换到仍绑定的项目。");
  assert.strictEqual(infoCalls.length, 0);
}

function testStatusPanelGoalVisibility() {
  const withGoalCard = buildStatusPanelCard({
    workspaceRoot: "/srv/project",
    codexParams: { model: "", effort: "", accessMode: "default" },
    goal: "ship safely today",
    goalState: {
      status: "active",
      stage: "phase one complete",
      nextStep: "advance to phase two",
      summary: "first checkpoint saved",
    },
    memoryStatus: {
      enabled: true,
      currentUserMemoryCount: 2,
      totalMemoryCount: 3,
      profileSummary: "Prefers goal-mode execution until completion.",
    },
    modelOptions: [],
    effortOptions: [],
    threadId: "",
    currentThread: null,
    recentThreads: [],
    totalThreadCount: 0,
    status: { code: "idle", label: "绌洪棽" },
    noticeText: "",
  });
  const withGoalText = JSON.stringify(withGoalCard);
  assert.ok(withGoalText.includes("项目目标"));
  assert.ok(withGoalText.includes("ship safely today"));

  assert.ok(withGoalText.includes("phase one complete"));
  assert.ok(withGoalText.includes("advance to phase two"));
  assert.ok(withGoalText.includes("first checkpoint saved"));
  assert.ok(withGoalText.includes("进化记忆"));
  assert.ok(withGoalText.includes("当前用户 2 条 / 累计 3 条"));
  assert.ok(withGoalText.includes("Prefers goal-mode execution until completion"));

  const withoutGoalCard = buildStatusPanelCard({
    workspaceRoot: "/srv/project",
    codexParams: { model: "", effort: "", accessMode: "default" },
    goal: "",
    goalState: null,
    modelOptions: [],
    effortOptions: [],
    threadId: "",
    currentThread: null,
    recentThreads: [],
    totalThreadCount: 0,
    status: { code: "idle", label: "绌洪棽" },
    noticeText: "",
  });
  const withoutGoalText = JSON.stringify(withoutGoalCard);
  assert.ok(withoutGoalText.includes("项目目标"));
  assert.ok(withoutGoalText.includes("未设置"));

  const workspaceBindingsCard = buildWorkspaceBindingsCard([
    {
      workspaceRoot: "/srv/project-a",
      isActive: true,
      threadId: "thread_a",
      goal: "finish project A",
      goalState: {
        status: "blocked",
        stage: "waiting on browser runtime",
        nextStep: "enable browser runtime",
        summary: "execution paused on missing runtime",
      },
    },
    {
      workspaceRoot: "/srv/project-b",
      isActive: false,
      threadId: "",
      goal: "",
      goalState: null,
    },
  ]);
  const workspaceBindingsText = JSON.stringify(workspaceBindingsCard);
  assert.ok(workspaceBindingsText.includes("finish project A"));
  assert.ok(workspaceBindingsText.includes("waiting on browser runtime"));
  assert.ok(workspaceBindingsText.includes("enable browser runtime"));
  assert.ok(workspaceBindingsText.includes("未设置"));
}

async function testEvolvingMemoryStatusResolution() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-memory-status-"));
  const storeFile = path.join(tempDir, "evolving-memory.json");
  const store = new EvolvingMemoryStore({ filePath: storeFile, retrievalLimit: 6 });
  store.applyEvolution({
    userId: "feishu:ou_test",
    evolution: {
      profileSummary: "Prefers goal-mode execution until completion.",
      upserts: [
        {
          key: "pref_goal_mode_until_done",
          kind: "workflow",
          summary: "User wants goal-mode execution until the task is fully done.",
          confidence: "high",
        },
      ],
    },
  });

  const previousExtensionFile = process.env.CODEX_IM_EXTENSIONS_FILE;
  const previousStoreFile = process.env.CODEX_IM_EVOLVING_MEMORY_FILE;
  const previousMem0Enabled = process.env.MEM0_ENABLED;
  const previousUserPrefix = process.env.MEM0_USER_ID_PREFIX;
  process.env.CODEX_IM_EXTENSIONS_FILE = path.join(tempDir, "mem0-extension.js");
  process.env.CODEX_IM_EVOLVING_MEMORY_FILE = storeFile;
  process.env.MEM0_ENABLED = "true";
  process.env.MEM0_USER_ID_PREFIX = "feishu";

  try {
    const status = await FeishuBotRuntime.prototype.resolveEvolvingMemoryStatus.call({}, {
      bindingKey: "default:oc_test:sender:ou_test",
    });
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.mem0Enabled, true);
    assert.strictEqual(status.accessible, true);
    assert.strictEqual(status.totalUserCount, 1);
    assert.strictEqual(status.totalMemoryCount, 1);
    assert.strictEqual(status.currentUserMemoryCount, 1);
    assert.strictEqual(status.profileSummary, "Prefers goal-mode execution until completion.");
  } finally {
    restoreEnvValue("CODEX_IM_EXTENSIONS_FILE", previousExtensionFile);
    restoreEnvValue("CODEX_IM_EVOLVING_MEMORY_FILE", previousStoreFile);
    restoreEnvValue("MEM0_ENABLED", previousMem0Enabled);
    restoreEnvValue("MEM0_USER_ID_PREFIX", previousUserPrefix);
  }
}

async function testAttachmentCacheDoctorText() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-doctor-"));
  const cacheDir = path.join(tempDir, "attachments");
  fs.mkdirSync(path.join(cacheDir, "2026-05-19"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "2026-05-19", "image.jpg"), Buffer.alloc(1536, 1));

  const runtime = {
    config: {
      instanceLabel: "default",
      bridgeMode: "thin",
      defaultCodexAccessMode: "default",
      defaultCodexModel: "",
      defaultCodexEffort: "",
      pluginRoot: "",
      marketplaceRoot: "",
    },
    codex: { mode: "spawn" },
    sessionStore: {
      getGoalForWorkspace() {
        return "";
      },
      getChatGoal() {
        return "act like the current Codex chat window";
      },
      getGoalStateForWorkspace() {
        return {
          status: "",
          stage: "",
          nextStep: "",
          summary: "",
          updatedAt: "",
        };
      },
      getChatGoalState() {
        return {
          status: "active",
          stage: "chat baseline ready",
          nextStep: "add goal completion detection",
          summary: "continuing the cloud thread hardening",
          updatedAt: "2026-05-25T09:00:00.000Z",
        };
      },
      getChatThreadId() {
        return "thread_chat_unbound";
      },
      getThreadIdForWorkspace() {
        return "";
      },
      getCodexParamsForWorkspace() {
        return { model: "", effort: "", accessMode: "" };
      },
      getAvailableModelCatalog() {
        return { models: [{ id: "gpt-5.5" }] };
      },
    },
    describeInstanceLabel: FeishuBotRuntime.prototype.describeInstanceLabel,
    probeCapabilityStatus: async () => ({
      codexCliOk: true,
      hasModels: true,
      github: "已验证",
      canva: "已验证",
      cloudflare: "未验证",
      chrome: "未验证（当前实例暂不支持）",
    }),
    resolveWorkspaceStats: async () => ({ exists: false, isDirectory: false }),
    resolveAttachmentCacheStatus: async () => ({
      dir: cacheDir,
      accessible: true,
      fileCount: 1,
      totalBytes: 1536,
      retentionHours: 24,
    }),
    resolveEvolvingMemoryStatus: async () => ({
      enabled: true,
      mem0Enabled: true,
      extensionFile: "/srv/app/extensions/mem0-extension.js",
      storeFile: "/srv/app/extensions/.data/evolving-memory-store.json",
      accessible: true,
      totalUserCount: 1,
      totalMemoryCount: 2,
      currentUserId: "feishu:ou_test",
      currentUserMemoryCount: 2,
      profileSummary: "Prefers goal-mode execution until completion.",
      error: "",
    }),
  };

  const text = await FeishuBotRuntime.prototype.buildDoctorText.call(runtime, {
    bindingKey: "default:oc_test:sender:ou_test",
    workspaceRoot: "",
  });
  assert.ok(text.includes("会话线程"));
  assert.ok(text.includes("桥模式：thin / Codex-first pass-through"));
  assert.ok(text.includes("会话目标"));
  assert.ok(text.includes("Cloudflare"));
  assert.ok(text.includes("已验证"));
  assert.ok(text.includes("未验证"));
  assert.ok(text.includes("thread_chat_unbound"));
  assert.ok(text.includes("act like the current Codex chat window"));
  assert.ok(text.includes("chat baseline ready"));
  assert.ok(text.includes("add goal completion detection"));
  assert.ok(text.includes("continuing the cloud thread hardening"));
  assert.ok(text.includes("进化记忆"));
  assert.ok(text.includes("当前用户条数：2"));
  assert.ok(text.includes("Prefers goal-mode execution until completion."));

  const {
    summarizeDirectoryFiles,
    formatBytes,
    normalizePositiveInt,
  } = require("../src/shared/attachment-cache-stats");
  const summary = await summarizeDirectoryFiles(cacheDir);
  assert.strictEqual(summary.fileCount, 1);
  assert.strictEqual(summary.totalBytes, 1536);
  assert.strictEqual(formatBytes(summary.totalBytes), "1.5 KB");
  assert.strictEqual(normalizePositiveInt("24", 72), 24);
}

async function testDirectDoctorTextHidesBridgeGoalProgress() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-direct-doctor-"));
  const cacheDir = path.join(tempDir, "attachments");
  fs.mkdirSync(cacheDir, { recursive: true });

  const runtime = {
    config: {
      instanceLabel: "cloud",
      bridgeMode: "direct",
      defaultCodexAccessMode: "full-access",
      defaultCodexModel: "gpt-5.5",
      defaultCodexEffort: "xhigh",
      pluginRoot: "",
      marketplaceRoot: "",
    },
    codex: { mode: "spawn" },
    capabilities: {
      async buildDoctorSections() {
        return ["**Internal Capabilities**\n- bridge mode: direct\n- native automation: disabled\n- native wake-to-feishu: disabled"];
      },
    },
    sessionStore: {
      getGoalForWorkspace() {
        return "";
      },
      getChatGoal() {
        return "act like the current Codex chat window";
      },
      getGoalStateForWorkspace() {
        return {
          status: "",
          stage: "",
          nextStep: "",
          summary: "",
          updatedAt: "",
        };
      },
      getChatGoalState() {
        return {
          status: "active",
          stage: "chat baseline ready",
          nextStep: "add goal completion detection",
          summary: "continuing the cloud thread hardening",
          updatedAt: "2026-05-25T09:00:00.000Z",
        };
      },
      getChatThreadId() {
        return "thread_chat_direct";
      },
      getThreadIdForWorkspace() {
        return "";
      },
      getCodexParamsForWorkspace() {
        return { model: "", effort: "", accessMode: "" };
      },
      getAvailableModelCatalog() {
        return { models: [{ id: "gpt-5.5" }] };
      },
    },
    describeInstanceLabel: FeishuBotRuntime.prototype.describeInstanceLabel,
    probeCapabilityStatus: async () => ({
      codexCliOk: true,
      hasModels: true,
      github: "verified",
      canva: "verified",
      cloudflare: "verified",
      chrome: "unavailable",
    }),
    resolveWorkspaceStats: async () => ({ exists: false, isDirectory: false }),
    resolveAttachmentCacheStatus: async () => ({
      dir: cacheDir,
      accessible: true,
      fileCount: 0,
      totalBytes: 0,
      retentionHours: 24,
    }),
    resolveEvolvingMemoryStatus: async () => ({
      enabled: true,
      mem0Enabled: true,
      extensionFile: "/srv/app/extensions/mem0-extension.js",
      storeFile: "/srv/app/extensions/.data/evolving-memory-store.json",
      accessible: true,
      totalUserCount: 1,
      totalMemoryCount: 2,
      currentUserId: "feishu:ou_test",
      currentUserMemoryCount: 2,
      profileSummary: "Prefers goal-mode execution until completion.",
      error: "",
    }),
  };

  const text = await FeishuBotRuntime.prototype.buildDoctorText.call(runtime, {
    bindingKey: "default:oc_test:sender:ou_test",
    workspaceRoot: "",
  });
  assert.ok(text.includes("direct / transport shell"));
  assert.ok(!text.includes("act like the current Codex chat window"));
  assert.ok(!text.includes("chat baseline ready"));
  assert.ok(!text.includes("add goal completion detection"));
  assert.ok(!text.includes("continuing the cloud thread hardening"));
}

function restoreEnvValue(name, value) {
  if (typeof value === "string") {
    process.env[name] = value;
    return;
  }
  delete process.env[name];
}

function captureGoalWrappedMessage(text, goal, goalState = null, options = {}) {
  const calls = [];
  const runtime = buildThreadRuntime({
    goal,
    goalState,
    bridgeMode: options.bridgeMode || "thin",
    calls,
  });

  return threadService.ensureThreadAndSendMessage(runtime, {
    bindingKey: "default:oc_test:sender:ou_test",
    workspaceRoot: "/srv/project",
    normalized: {
      text,
      attachments: [],
    },
    threadId: "thread_existing",
  }).then(() => {
    assert.strictEqual(calls.length, 1);
    return calls[0].text;
  });
}

function captureChatGoalWrappedMessage(text, goal, chatGoalState = null, options = {}) {
  const calls = [];
  const runtime = buildThreadRuntime({
    goal: "",
    chatGoal: goal,
    chatGoalState,
    bridgeMode: options.bridgeMode || "thin",
    calls,
  });

  return threadService.ensureThreadAndSendMessage(runtime, {
    bindingKey: "default:oc_test:sender:ou_test",
    workspaceRoot: "",
    normalized: { text, attachments: [] },
    threadId: "thread_existing",
  }).then(() => {
    assert.strictEqual(calls.length, 1);
    return calls[0].text;
  });
}

function buildThreadRuntime({
  goal,
  chatGoal = "",
  goalState = null,
  chatGoalState = null,
  bridgeMode = "thin",
  calls,
}) {
  return {
    config: {
      bridgeMode,
      defaultCodexAccessMode: "default",
    },
    sessionStore: {
      getGoalForWorkspace() {
        return goal;
      },
      getChatGoal() {
        return chatGoal;
      },
      getGoalStateForWorkspace() {
        return goalState || {
          status: "",
          stage: "",
          nextStep: "",
          summary: "",
          updatedAt: "",
        };
      },
      getChatGoalState() {
        return chatGoalState || {
          status: "",
          stage: "",
          nextStep: "",
          summary: "",
          updatedAt: "",
        };
      },
      setChatThreadId() {},
      setThreadIdForWorkspace() {},
      clearChatThreadId() {},
      clearThreadIdForWorkspace() {},
    },
    getCodexParamsForWorkspace() {
      return {
        model: "",
        effort: "",
        accessMode: "",
      };
    },
    codex: {
      async sendUserMessage(payload) {
        calls.push(payload);
        return { ok: true };
      },
      async resumeThread() {
        return { ok: true };
      },
      async startThread() {
        return { result: { thread: { id: "thread_created" } } };
      },
      async listThreads() {
        return { result: { data: [] } };
      },
    },
    resumedThreadIds: new Set(["thread_existing"]),
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    setPendingThreadContext() {},
  };

}

Promise.resolve(main()).catch((error) => {
  console.error(error);
  process.exit(1);
});

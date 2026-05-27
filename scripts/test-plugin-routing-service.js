#!/usr/bin/env node

const assert = require("assert");
const dispatcher = require("../src/app/dispatcher");
const pluginRoutingService = require("../src/domain/plugin-routing/service");

async function main() {
  testNotionIntentDetection();
  testFigmaIntentDetection();
  testSemrushIntentDetection();
  testParticlIntentDetection();
  testZhihuIntentDetection();
  testAmbiguousIntentDetection();
  testOrdinaryChatFallsThrough();
  await testPluginRouteUsesDedicatedCardChannel();
  await testDispatcherLetsPluginIntentReachCodexByDefault();
  await testDispatcherCanOptIntoPluginRouteIntercept();
  await testThinBridgeSendsPluginCommandToCodex();
  await testThinBridgeKeepsCoreCommandsLocalWithoutHooks();
  console.log("plugin routing ok");
}

function testNotionIntentDetection() {
  const route = pluginRoutingService.detectFirstBatchPluginIntent("把这段聊天整理成需求文档");
  assert.ok(route);
  assert.strictEqual(route.kind, "plugin");
  assert.strictEqual(route.pluginId, "notion");
  assert.ok(pluginRoutingService.buildPluginRouteText(route).includes("Notion"));
}

function testFigmaIntentDetection() {
  const route = pluginRoutingService.detectFirstBatchPluginIntent("帮我看这个设计稿的重点");
  assert.ok(route);
  assert.strictEqual(route.kind, "plugin");
  assert.strictEqual(route.pluginId, "figma");
}

function testSemrushIntentDetection() {
  const route = pluginRoutingService.detectFirstBatchPluginIntent("帮我查这个关键词值不值得做");
  assert.ok(route);
  assert.strictEqual(route.kind, "plugin");
  assert.strictEqual(route.pluginId, "semrush");
}

function testParticlIntentDetection() {
  const route = pluginRoutingService.detectFirstBatchPluginIntent("帮我看这个品类最近趋势");
  assert.ok(route);
  assert.strictEqual(route.kind, "plugin");
  assert.strictEqual(route.pluginId, "particl-market-research");
}

function testZhihuIntentDetection() {
  const route = pluginRoutingService.detectFirstBatchPluginIntent(
    "知乎正式推出官方 api、mcp 和 skill，帮我用知乎热榜整理自媒体选题素材"
  );
  assert.ok(route);
  assert.strictEqual(route.kind, "plugin");
  assert.strictEqual(route.pluginId, "zhihu");
  assert.ok(pluginRoutingService.buildPluginRouteText(route).includes("知乎开发者 Token"));
}

function testAmbiguousIntentDetection() {
  const route = pluginRoutingService.detectFirstBatchPluginIntent("帮我分析这个竞品的关键词 SEO 和卖点");
  assert.ok(route);
  assert.strictEqual(route.kind, "ambiguous");
  assert.ok(pluginRoutingService.buildAmbiguousPluginRouteText(route).includes("插件分流建议"));
}

function testOrdinaryChatFallsThrough() {
  const route = pluginRoutingService.detectFirstBatchPluginIntent("预约功能为什么不能用");
  assert.strictEqual(route, null);
}

async function testPluginRouteUsesDedicatedCardChannel() {
  let pluginCardArgs = null;
  let infoCardCalled = false;
  const normalized = {
    command: "message",
    chatId: "oc_test",
    messageId: "om_plugin_card",
    text: "notion 帮我整理成需求文档",
  };

  const result = await pluginRoutingService.handlePotentialPluginIntentMessage({
    sendPluginRouteCardMessage: async (args) => {
      pluginCardArgs = args;
      return { ok: true };
    },
    sendInfoCardMessage: async () => {
      infoCardCalled = true;
      return { ok: true };
    },
  }, normalized);

  assert.strictEqual(result, null);
  assert.ok(pluginCardArgs);
  assert.strictEqual(pluginCardArgs.chatId, normalized.chatId);
  assert.strictEqual(pluginCardArgs.replyToMessageId, normalized.messageId);
  assert.strictEqual(pluginCardArgs.route.pluginId, "notion");
  assert.strictEqual(infoCardCalled, false);
}

async function testDispatcherLetsPluginIntentReachCodexByDefault() {
  const event = buildTextEvent("把这段聊天整理成需求文档", "om_plugin_route");
  let pluginInterceptCalled = false;
  let beforeHookCalled = false;
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgePassthroughToCodex: false,
    },
    handlePotentialAppointmentMessage: async (normalized) => normalized,
    handlePotentialPluginIntentMessage: async (normalized) => {
      pluginInterceptCalled = true;
      return normalized;
    },
    runBeforeMessageHook: async (args) => {
      beforeHookCalled = true;
      return args.normalized;
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    dispatchTextCommand: async (normalized) => {
      seen.push(["local-command", normalized.command]);
      return true;
    },
    getCurrentThreadContext() {
      return {
        bindingKey: "default:oc_test:sender:ou_test",
        workspaceRoot: "",
        threadId: "",
      };
    },
    setPendingBindingContext() {},
    setPendingThreadContext() {},
    async addPendingReaction() {},
    movePendingReactionToThread() {},
    async clearPendingReactionForBinding() {},
    async ensureThreadAndSendMessage({ normalized }) {
      seen.push(["codex", normalized.command, normalized.text]);
      return "thread_plugin_passthrough";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.strictEqual(pluginInterceptCalled, false);
  assert.strictEqual(beforeHookCalled, false);
  assert.deepStrictEqual(seen, [["codex", "message", "把这段聊天整理成需求文档"]]);
}

async function testDispatcherCanOptIntoPluginRouteIntercept() {
  const event = buildTextEvent("把这段聊天整理成需求文档", "om_plugin_route_intercept");
  let pluginInterceptCalled = false;
  let beforeHookCalled = false;

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "standard",
      bridgePassthroughToCodex: false,
      pluginRouteInterceptEnabled: true,
    },
    handlePotentialAppointmentMessage: async (normalized) => normalized,
    handlePotentialPluginIntentMessage: async () => {
      pluginInterceptCalled = true;
      return null;
    },
    runBeforeMessageHook: async (args) => {
      beforeHookCalled = true;
      return args.normalized;
    },
  }, event);

  assert.strictEqual(pluginInterceptCalled, true);
  assert.strictEqual(beforeHookCalled, false);
}

async function testThinBridgeSendsPluginCommandToCodex() {
  const event = buildTextEvent("/codex plugin list", "om_thin_plugin_command");
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "thin",
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    runBeforeMessageHook: async (args) => args.normalized,
    dispatchTextCommand: async (normalized) => {
      seen.push(["local-command", normalized.command]);
      return true;
    },
    getCurrentThreadContext() {
      return {
        bindingKey: "default:oc_test:sender:ou_test",
        workspaceRoot: "",
        threadId: "",
      };
    },
    setPendingBindingContext() {},
    setPendingThreadContext() {},
    async addPendingReaction() {},
    movePendingReactionToThread() {},
    async clearPendingReactionForBinding() {},
    async ensureThreadAndSendMessage({ normalized }) {
      seen.push(["codex", normalized.command, normalized.bridgeOriginalCommand]);
      return "thread_thin_plugin";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.deepStrictEqual(seen, [["codex", "message", "plugin"]]);
}

async function testThinBridgeKeepsCoreCommandsLocalWithoutHooks() {
  const event = buildTextEvent("/codex doctor", "om_thin_core_command");
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "thin",
    },
    handlePotentialAppointmentMessage: async (normalized) => {
      seen.push(["appointment-intercept", normalized.command]);
      return normalized;
    },
    handlePotentialPluginIntentMessage: async (normalized) => {
      seen.push(["plugin-intercept", normalized.command]);
      return normalized;
    },
    runBeforeMessageHook: async (args) => {
      seen.push(["before-hook", args.normalized.command]);
      return args.normalized;
    },
    dispatchTextCommand: async (normalized) => {
      seen.push(["local-command", normalized.command]);
      return true;
    },
  }, event);

  assert.deepStrictEqual(seen, [["local-command", "doctor"]]);
}

function buildTextEvent(text, messageId) {
  return {
    sender: {
      sender_id: {
        open_id: "ou_test",
      },
    },
    message: {
      message_type: "text",
      chat_id: "oc_test",
      root_id: "",
      message_id: messageId,
      content: JSON.stringify({ text }),
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

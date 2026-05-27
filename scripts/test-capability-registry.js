#!/usr/bin/env node

const assert = require("assert");
const { createCapabilityRegistry } = require("../src/app/capability-registry");

async function main() {
  await testRegistryStartsEnabledCapabilitiesSafely();
  await testRegistryBuildsDoctorSectionsAndMessagePrefix();
  await testRegistryDelegatesLiveCapabilities();
  await testThinBridgeDisablesLocalInjectionButReportsNativeCapabilityState();
  await testDirectBridgeDisablesLocalBusinessCapabilities();
  await testBridgeWakeupCapabilityStartsAndAppearsInDoctor();
  console.log("capability registry ok");
}

async function testRegistryStartsEnabledCapabilitiesSafely() {
  const calls = [];
  const registry = createCapabilityRegistry({
    config: {
      bridgeMode: "standard",
      morningBriefingEnabled: true,
      morningBriefingWorkspaceRoot: "/srv/morning",
      pluginRouteInterceptEnabled: false,
    },
    sessionsFile: "/tmp/sessions.json",
    instanceLabel: "cloud",
    dependencies: {
      morningBriefingRuntime: {
        startMorningBriefingScheduler() {
          calls.push("morning");
          throw new Error("boom");
        },
      },
      pluginRoutingRuntime: {
        handlePotentialPluginIntentMessage(_runtime, normalized) {
          return Promise.resolve(normalized);
        },
      },
      createOptimizationManager() {
        return buildFakeOptimizationManager();
      },
    },
  });

  await registry.start({});
  assert.deepStrictEqual(calls, ["morning"]);
}

async function testRegistryBuildsDoctorSectionsAndMessagePrefix() {
  const optimizationManager = buildFakeOptimizationManager({
    prefix: "<memory-prefix>\n",
    doctorSection: "**Optimization Memory**\n- latest-score: ready",
    routingHints: { minRouteScore: 3, ambiguousScoreGap: 2 },
  });
  const registry = createCapabilityRegistry({
    config: {
      bridgeMode: "standard",
      morningBriefingEnabled: false,
      goalNaturalLanguageInterceptEnabled: true,
      pluginRouteInterceptEnabled: true,
      nativeAutomationAvailable: false,
      nativeWakeToFeishuAvailable: false,
    },
    sessionsFile: "/tmp/sessions.json",
    instanceLabel: "cloud",
    dependencies: {
      morningBriefingRuntime: {
        startMorningBriefingScheduler() {},
      },
      pluginRoutingRuntime: {
        handlePotentialPluginIntentMessage(_runtime, normalized) {
          return Promise.resolve(normalized);
        },
      },
      createOptimizationManager() {
        return optimizationManager;
      },
    },
  });

  const sections = await registry.buildDoctorSections({
    runtime: {},
    bindingKey: "binding",
    workspaceRoot: "/srv/project",
  });
  assert.strictEqual(sections.length, 2);
  assert.ok(sections[0].includes("Internal Capabilities"));
  assert.ok(sections[0].includes("morning-briefing scheduler: disabled"));
  assert.ok(sections[0].includes("goal NL intercept: enabled"));
  assert.ok(sections[0].includes("plugin routing intercept: enabled"));
  assert.ok(sections[0].includes("native automation: disabled"));
  assert.ok(sections[0].includes("native wake-to-feishu: disabled"));
  assert.ok(sections[0].includes("bridge timed wakeup: disabled"));
  assert.ok(sections[1].includes("Optimization Memory"));

  const nextNormalized = await registry.applyBeforeMessage({
    runtime: {},
    normalized: {
      command: "message",
      text: "hello",
    },
  });
  assert.strictEqual(nextNormalized.text, "<memory-prefix>\nhello");
  assert.deepStrictEqual(registry.getRoutingHints(), { minRouteScore: 3, ambiguousScoreGap: 2 });
}

async function testRegistryDelegatesLiveCapabilities() {
  const calls = [];
  const registry = createCapabilityRegistry({
    config: {
      bridgeMode: "standard",
    },
    sessionsFile: "/tmp/sessions.json",
    instanceLabel: "cloud",
    dependencies: {
      morningBriefingRuntime: {
        startMorningBriefingScheduler() {},
      },
      goalRuntime: {
        handlePotentialGoalMessage(runtime, normalized) {
          calls.push(["goal-message", runtime.tag, normalized.messageId]);
          return Promise.resolve(normalized);
        },
      },
      pluginRoutingRuntime: {
        handlePotentialPluginIntentMessage(runtime, normalized) {
          calls.push(["plugin-message", runtime.tag, normalized.messageId]);
          return Promise.resolve(null);
        },
      },
      createOptimizationManager() {
        return buildFakeOptimizationManager({
          handleCommand({ runtime, normalized }) {
            calls.push(["optimization-command", runtime.tag, normalized.messageId]);
            return Promise.resolve();
          },
          handleRollback({ runtime, normalized }) {
            calls.push(["optimization-rollback", runtime.tag, normalized.messageId]);
            return Promise.resolve();
          },
        });
      },
    },
  });

  const runtime = { tag: "runtime" };
  await registry.handlePotentialGoalMessage(runtime, { messageId: "m1" });
  await registry.handlePotentialPluginIntentMessage(runtime, { messageId: "m2" });
  await registry.handleOptimizationCommand({
    surface: "chat",
    runtime,
    normalized: { messageId: "m3" },
  });
  await registry.handleOptimizationRollback({
    surface: "chat",
    runtime,
    normalized: { messageId: "m4" },
  });

  assert.deepStrictEqual(calls, [
    ["goal-message", "runtime", "m1"],
    ["plugin-message", "runtime", "m2"],
    ["optimization-command", "runtime", "m3"],
    ["optimization-rollback", "runtime", "m4"],
  ]);
}

async function testThinBridgeDisablesLocalInjectionButReportsNativeCapabilityState() {
  const calls = [];
  const registry = createCapabilityRegistry({
    config: {
      bridgeMode: "thin",
      morningBriefingEnabled: true,
      morningBriefingWorkspaceRoot: "/srv/morning",
      goalNaturalLanguageInterceptEnabled: true,
      pluginRouteInterceptEnabled: true,
      nativeAutomationAvailable: true,
      nativeWakeToFeishuAvailable: false,
      bridgeWakeupEnabled: true,
    },
    sessionsFile: "/tmp/sessions.json",
    instanceLabel: "cloud",
    dependencies: {
      morningBriefingRuntime: {
        startMorningBriefingScheduler() {
          calls.push("morning");
        },
      },
      goalRuntime: {
        handlePotentialGoalMessage(_runtime, normalized) {
          return Promise.resolve(normalized);
        },
      },
      pluginRoutingRuntime: {
        handlePotentialPluginIntentMessage(_runtime, normalized) {
          return Promise.resolve(normalized);
        },
      },
      createOptimizationManager() {
        return buildFakeOptimizationManager({
          prefix: "<memory-prefix>\n",
          doctorSection: "**Optimization Memory**\n- ready",
        });
      },
    },
  });

  await registry.start({});
  assert.deepStrictEqual(calls, []);

  const normalized = {
    command: "message",
    text: "hello",
  };
  const nextNormalized = await registry.applyBeforeMessage({
    runtime: {},
    normalized,
  });
  assert.strictEqual(nextNormalized, normalized);

  const sections = await registry.buildDoctorSections({
    runtime: {},
    bindingKey: "binding",
    workspaceRoot: "/srv/project",
  });
  assert.strictEqual(sections.length, 1);
  assert.ok(sections[0].includes("bridge mode: thin"));
  assert.ok(sections[0].includes("morning-briefing scheduler: disabled"));
  assert.ok(sections[0].includes("goal NL intercept: enabled"));
  assert.ok(sections[0].includes("plugin routing intercept: disabled"));
  assert.ok(sections[0].includes("native automation: enabled"));
  assert.ok(sections[0].includes("native wake-to-feishu: disabled"));
  assert.ok(sections[0].includes("bridge timed wakeup: enabled"));
  assert.ok(sections[0].includes("optimization memory: disabled in thin mode"));
}

async function testDirectBridgeDisablesLocalBusinessCapabilities() {
  const calls = [];
  const registry = createCapabilityRegistry({
    config: {
      bridgeMode: "direct",
      morningBriefingEnabled: true,
      morningBriefingWorkspaceRoot: "/srv/morning",
      goalNaturalLanguageInterceptEnabled: true,
      pluginRouteInterceptEnabled: true,
      nativeAutomationAvailable: false,
      nativeWakeToFeishuAvailable: false,
      bridgeWakeupEnabled: true,
    },
    sessionsFile: "/tmp/sessions.json",
    instanceLabel: "cloud",
    dependencies: {
      morningBriefingRuntime: {
        startMorningBriefingScheduler() {
          calls.push("morning");
        },
      },
      goalRuntime: {
        handlePotentialGoalMessage(_runtime, normalized) {
          return Promise.resolve(normalized);
        },
      },
      pluginRoutingRuntime: {
        handlePotentialPluginIntentMessage(_runtime, normalized) {
          return Promise.resolve(normalized);
        },
      },
      createOptimizationManager() {
        calls.push("optimization-manager");
        return buildFakeOptimizationManager({
          prefix: "<memory-prefix>\n",
          doctorSection: "**Optimization Memory**\n- ready",
        });
      },
    },
  });

  await registry.start({});
  assert.deepStrictEqual(calls, []);

  const normalized = {
    command: "message",
    text: "hello",
  };
  const nextNormalized = await registry.applyBeforeMessage({
    runtime: {},
    normalized,
  });
  assert.strictEqual(nextNormalized, normalized);

  const sections = await registry.buildDoctorSections({
    runtime: {},
    bindingKey: "binding",
    workspaceRoot: "/srv/project",
  });
  assert.strictEqual(sections.length, 1);
  assert.ok(sections[0].includes("bridge mode: direct"));
  assert.ok(sections[0].includes("native automation: disabled"));
  assert.ok(sections[0].includes("native wake-to-feishu: disabled"));
  assert.ok(sections[0].includes("bridge timed wakeup: enabled"));
  assert.ok(!sections[0].includes("morning-briefing scheduler"));
  assert.ok(!sections[0].includes("goal NL intercept"));
  assert.ok(!sections[0].includes("plugin routing intercept"));
  assert.ok(!sections[0].includes("optimization memory"));
}

async function testBridgeWakeupCapabilityStartsAndAppearsInDoctor() {
  const calls = [];
  const registry = createCapabilityRegistry({
    config: {
      bridgeMode: "direct",
      bridgeWakeupEnabled: true,
      bridgeWakeupScanIntervalSec: 9,
      nativeAutomationAvailable: false,
      nativeWakeToFeishuAvailable: false,
    },
    sessionsFile: "/tmp/sessions.json",
    instanceLabel: "cloud",
    dependencies: {
      morningBriefingRuntime: {
        startMorningBriefingScheduler() {},
      },
      bridgeWakeupRuntime: {
        startBridgeWakeupScheduler(_runtime, options) {
          calls.push(options.scanIntervalSec);
        },
      },
      goalRuntime: {
        handlePotentialGoalMessage(_runtime, normalized) {
          return Promise.resolve(normalized);
        },
      },
      pluginRoutingRuntime: {
        handlePotentialPluginIntentMessage(_runtime, normalized) {
          return Promise.resolve(normalized);
        },
      },
      createOptimizationManager() {
        return buildFakeOptimizationManager();
      },
    },
  });

  await registry.start({});
  assert.deepStrictEqual(calls, [9]);

  const sections = await registry.buildDoctorSections({
    runtime: {},
    bindingKey: "binding",
    workspaceRoot: "/srv/project",
  });
  assert.ok(sections[0].includes("bridge timed wakeup: enabled"));
}

function buildFakeOptimizationManager({
  prefix = "",
  doctorSection = "",
  routingHints = {},
  handleCommand = () => Promise.resolve(),
  handleRollback = () => Promise.resolve(),
} = {}) {
  return {
    async buildMessagePrefix() {
      return prefix;
    },
    async buildDoctorSection() {
      return doctorSection;
    },
    getRoutingHints() {
      return routingHints;
    },
    handleCommand,
    handleRollback,
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

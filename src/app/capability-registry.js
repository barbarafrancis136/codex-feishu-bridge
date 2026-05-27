const morningBriefingRuntime = require("../morning/service");
const goalRuntime = require("../domain/goal/service");
const pluginRoutingRuntime = require("../domain/plugin-routing/service");
const bridgeWakeupRuntime = require("../domain/automation/bridge-wakeup-service");
const { createLogger } = require("../shared/logger");

let createOptimizationManager = createUnavailableOptimizationManager();
try {
  ({ createOptimizationManager } = require("../domain/optimization/service"));
} catch (error) {
  createOptimizationManager = createUnavailableOptimizationManager(error);
}

const logger = createLogger("capability-registry");

function createCapabilityRegistry({
  config = {},
  sessionsFile = "",
  instanceLabel = "default",
  dependencies = {},
} = {}) {
  const morningService = dependencies.morningBriefingRuntime || morningBriefingRuntime;
  const goalService = dependencies.goalRuntime || goalRuntime;
  const pluginRoutingService = dependencies.pluginRoutingRuntime || pluginRoutingRuntime;
  const wakeupService = dependencies.bridgeWakeupRuntime || bridgeWakeupRuntime;
  const optimizationFactory = dependencies.createOptimizationManager || createOptimizationManager;
  const bridgeMode = getBridgeMode(config);
  const standardBridgeMode = bridgeMode === "standard";

  const optimizationManager = standardBridgeMode
    ? optimizationFactory({
      sessionsFile,
      instanceLabel,
    })
    : null;

  const registry = {
    optimizationManager,

    async start(runtime) {
      safeStartCapability("morning-briefing", () => standardBridgeMode && shouldEnableMorningBriefing(config), () =>
        morningService.startMorningBriefingScheduler(runtime));
      safeStartCapability("bridge-wakeup", () => shouldEnableBridgeWakeup(config), () =>
        wakeupService.startBridgeWakeupScheduler(runtime, {
          scanIntervalSec: config.bridgeWakeupScanIntervalSec,
        }));
    },

    async applyBeforeMessage({ runtime, normalized }) {
      let nextNormalized = normalized || null;
      if (!standardBridgeMode) {
        return nextNormalized;
      }
      if (nextNormalized?.command === "message" && optimizationManager) {
        try {
          const prefix = await optimizationManager.buildMessagePrefix({
            runtime,
            normalized: nextNormalized,
          });
          if (prefix) {
            nextNormalized = {
              ...nextNormalized,
              text: `${prefix}${nextNormalized.text || ""}`,
            };
          }
        } catch (error) {
          logger.warn("optimization memory injection failed", { error });
        }
      }
      return nextNormalized;
    },

    async buildDoctorSections({ runtime, bindingKey = "", workspaceRoot = "" } = {}) {
      const sections = [];
      const capabilitySection = buildInternalCapabilitiesSection(config);
      if (capabilitySection) {
        sections.push(capabilitySection);
      }
      if (optimizationManager?.buildDoctorSection) {
        try {
          const optimizationSection = await optimizationManager.buildDoctorSection({
            runtime,
            bindingKey,
            workspaceRoot,
          });
          if (optimizationSection) {
            sections.push(optimizationSection);
          }
        } catch (error) {
          logger.warn("failed to build optimization doctor section", { error });
        }
      }
      return sections;
    },

    getRoutingHints() {
      if (!optimizationManager?.getRoutingHints) {
        return {};
      }
      try {
        return optimizationManager.getRoutingHints() || {};
      } catch (error) {
        logger.warn("failed to read optimization routing hints", { error });
        return {};
      }
    },

    handleOptimizationCommand({ surface, normalized, runtime }) {
      if (!optimizationManager) {
        return Promise.resolve();
      }
      return optimizationManager.handleCommand({ surface, normalized, runtime });
    },

    handleOptimizationRollback({ surface, normalized, runtime }) {
      if (!optimizationManager) {
        return Promise.resolve();
      }
      return optimizationManager.handleRollback({ surface, normalized, runtime });
    },

    handlePotentialGoalMessage(runtime, normalized) {
      return goalService.handlePotentialGoalMessage(runtime, normalized);
    },

    handlePotentialPluginIntentMessage(runtime, normalized) {
      return pluginRoutingService.handlePotentialPluginIntentMessage(runtime, normalized);
    },
  };

  return registry;
}

function shouldEnableMorningBriefing(config = {}) {
  return Boolean(config.morningBriefingEnabled && config.morningBriefingWorkspaceRoot);
}

function buildInternalCapabilitiesSection(config = {}) {
  const bridgeMode = getBridgeMode(config);
  const standardBridgeMode = bridgeMode === "standard";
  const directBridgeMode = bridgeMode === "direct";
  const nativeAutomationAvailable = isNativeAutomationAvailable(config);
  const nativeWakeToFeishuAvailable = isNativeWakeToFeishuAvailable(config);
  if (directBridgeMode) {
    return [
      "**Internal Capabilities**",
      `- bridge mode: ${bridgeMode}`,
      `- native automation: ${formatEnabled(nativeAutomationAvailable)}`,
      `- native wake-to-feishu: ${formatEnabled(nativeWakeToFeishuAvailable)}`,
      `- bridge timed wakeup: ${formatEnabled(shouldEnableBridgeWakeup(config))}`,
    ].join("\n");
  }
  return [
    "**Internal Capabilities**",
    `- bridge mode: ${bridgeMode}`,
    `- morning-briefing scheduler: ${formatEnabled(standardBridgeMode && shouldEnableMorningBriefing(config))}`,
    `- goal NL intercept: ${formatEnabled(!directBridgeMode && Boolean(config.goalNaturalLanguageInterceptEnabled))}`,
    `- plugin routing intercept: ${formatEnabled(standardBridgeMode && config.pluginRouteInterceptEnabled)}`,
    `- native automation: ${formatEnabled(nativeAutomationAvailable)}`,
    `- native wake-to-feishu: ${formatEnabled(nativeWakeToFeishuAvailable)}`,
    `- bridge timed wakeup: ${formatEnabled(shouldEnableBridgeWakeup(config))}`,
    `- optimization memory: ${standardBridgeMode ? "enabled" : `disabled in ${bridgeMode} mode`}`,
  ].join("\n");
}

function isNativeAutomationAvailable(config = {}) {
  return Boolean(config.nativeAutomationAvailable);
}

function isNativeWakeToFeishuAvailable(config = {}) {
  return Boolean(config.nativeWakeToFeishuAvailable);
}

function shouldEnableBridgeWakeup(config = {}) {
  return Boolean(config.bridgeWakeupEnabled);
}

function getBridgeMode(config = {}) {
  return String(config.bridgeMode || "thin").trim().toLowerCase();
}

function formatEnabled(value) {
  return value ? "enabled" : "disabled";
}

function safeStartCapability(label, isEnabled, startFn) {
  let enabled = false;
  try {
    enabled = Boolean(isEnabled());
  } catch (error) {
    logger.warn("failed to resolve capability enablement", {
      capability: label,
      error,
    });
    return;
  }

  if (!enabled) {
    logger.info("capability disabled", { capability: label });
    return;
  }

  try {
    startFn();
    logger.info("capability started", { capability: label });
  } catch (error) {
    logger.error("capability start failed", {
      capability: label,
      error,
    });
  }
}

function createUnavailableOptimizationManager(error = null) {
  return function unavailableOptimizationManagerFactory() {
    throw error || new Error("optimization manager is unavailable");
  };
}

module.exports = {
  createCapabilityRegistry,
};

const appointmentService = require("../../src/domain/appointment/service");

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const SERVICE_HINT_RE = /(染发|染头发|剪发|剪头发|烫发|做头发|漂发|护理|洗剪吹|补色)/;
const PRODUCT_DISCUSSION_RE = /(预约功能|预约系统|预约模块|预约能力|预约逻辑|为什么|不能用|怎么用|如何用|帮我查|查询|列表)/;
const CUSTOMER_PREFIX_RE = /^[A-Za-z\u4e00-\u9fa5]{2,12}(?=\s*预约)/;

class AppointmentParserProvider {
  constructor(options = {}) {
    this.options = options;
  }

  id() {
    return this.options.id || "appointment-parser-local";
  }

  async callApi(prompt, context = {}) {
    const vars = context.vars || {};
    const sourceText = String(prompt || vars.input || "").trim();
    const timezone = String(vars.timezone || this.options.timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
    const now = vars.now_iso ? new Date(vars.now_iso) : new Date();
    const parsed = appointmentService.parseNaturalLanguageAppointmentText(sourceText, {
      now,
      timezone,
    });

    const output = {
      input: sourceText,
      timezone,
      nowIso: Number.isFinite(now.getTime()) ? now.toISOString() : "",
      currentRoute: deriveCurrentRoute(parsed),
      suggestedRoute: deriveSuggestedRoute(sourceText, parsed),
      intentDetected: Boolean(parsed.intentDetected),
      datetimeDetected: Boolean(parsed.datetimeDetected),
      ok: Boolean(parsed.ok),
      customerName: parsed.customerName || "",
      serviceName: parsed.serviceName || "",
      note: parsed.note || "",
      appointmentAtIso: toIso(parsed.appointmentAt),
      reminderAtIso: toIso(parsed.reminderAt),
      message: parsed.message || "",
    };

    return {
      output: JSON.stringify(output, null, 2),
      metadata: {
        currentRoute: output.currentRoute,
        suggestedRoute: output.suggestedRoute,
      },
    };
  }
}

function deriveCurrentRoute(parsed) {
  if (!parsed?.intentDetected || !parsed?.datetimeDetected) {
    return "fallthrough";
  }
  return parsed.ok ? "create" : "error";
}

function deriveSuggestedRoute(sourceText, parsed) {
  if (parsed?.ok) {
    return "create";
  }
  if (!parsed?.intentDetected && !parsed?.datetimeDetected) {
    return "fallthrough";
  }
  if (parsed?.datetimeDetected && !parsed?.ok) {
    return "error";
  }
  if (hasStrongAppointmentSignal(sourceText)) {
    return "clarify";
  }
  return "fallthrough";
}

function hasStrongAppointmentSignal(sourceText) {
  const text = String(sourceText || "").replace(/\s+/g, " ").trim();
  if (!text.includes("预约")) {
    return false;
  }
  if (PRODUCT_DISCUSSION_RE.test(text)) {
    return false;
  }
  return CUSTOMER_PREFIX_RE.test(text) || SERVICE_HINT_RE.test(text);
}

function toIso(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return "";
  }
  return value.toISOString();
}

module.exports = AppointmentParserProvider;

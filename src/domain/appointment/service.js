const { extractAppointmentValue } = require("../../shared/command-parsing");
const { createLogger } = require("../../shared/logger");

const logger = createLogger("appointment");

const APPOINTMENT_COMMAND = "appointment";
const APPOINTMENT_KIND = "appointment";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_SCAN_INTERVAL_SEC = 60;
const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const REMINDER_GRACE_WINDOW_MS = 5 * ONE_MINUTE_MS;
const PERSONAL_REMINDER_LATE_WINDOW_MS = ONE_DAY_MS;
const MAX_HISTORY_ITEMS = 3;
const DRAFT_RETENTION_MS = 7 * ONE_DAY_MS;

function handlePotentialAppointmentMessage(runtime, normalized) {
  if (normalized?.command !== "message" || !normalized?.chatId) {
    return Promise.resolve(normalized);
  }

  const timezone = resolveAppointmentTimezone(runtime);
  const now = new Date();
  const chatScopeKey = buildChatScopeKey(runtime, normalized);
  const query = parseNaturalLanguageAppointmentQuery(normalized.text, {
    now,
    timezone,
  });
  if (query && chatScopeKey) {
    const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
    return runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildAppointmentQueryReplyText(scope, query, {
        timezone,
        now,
      }),
    }).then(() => null);
  }

  const personalParsed = parseNaturalLanguagePersonalAppointmentText(normalized.text, {
    now,
    timezone,
  });
  if (personalParsed.intentDetected) {
    if (!personalParsed.ok) {
      return runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: personalParsed.message,
        kind: "error",
      }).then(() => null);
    }
    if (!chatScopeKey) {
      return Promise.resolve(normalized);
    }
    const result = createPersonalAppointment(runtime, chatScopeKey, personalParsed, normalized, {
      now,
      timezone,
    });
    return runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: result.text,
      kind: result.ok ? "success" : "error",
    }).then(() => null);
  }

  const parsed = parseNaturalLanguageAppointmentText(normalized.text, {
    now,
    timezone,
  });

  if (!parsed.intentDetected || !parsed.datetimeDetected) {
    return Promise.resolve(normalized);
  }

  if (!parsed.ok) {
    return runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: parsed.message,
      kind: "error",
    }).then(() => null);
  }

  if (!chatScopeKey) {
    return Promise.resolve(normalized);
  }

  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const draft = createAppointmentDraft(parsed, normalized);
  const history = summarizeCustomerHistory(scope, draft.normalizedCustomerName, {
    timezone,
    now,
    includeCurrentPending: true,
  });

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, (current) => {
    const next = ensureScopeDefaults(current, normalized);
    pruneExpiredDrafts(next, Date.now());
    next.pendingDraftsById[draft.draftId] = draft;
    return next;
  });

  return runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    card: buildAppointmentDraftCard({
      draft,
      history,
      timezone,
    }),
  }).then(() => null);
}

function handlePotentialPersonalReminderMessage(runtime, normalized) {
  if (normalized?.command !== "message" || !normalized?.chatId) {
    return Promise.resolve(normalized);
  }

  const timezone = resolveAppointmentTimezone(runtime);
  const now = new Date();
  const chatScopeKey = buildChatScopeKey(runtime, normalized);
  const personalParsed = parseNaturalLanguagePersonalAppointmentText(normalized.text, {
    now,
    timezone,
  });

  if (!personalParsed.intentDetected || !personalParsed.datetimeDetected) {
    return Promise.resolve(normalized);
  }

  if (!personalParsed.ok) {
    return runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: personalParsed.message,
      kind: "error",
    }).then(() => null);
  }

  if (!chatScopeKey) {
    return Promise.resolve(normalized);
  }

  const result = createPersonalAppointment(runtime, chatScopeKey, personalParsed, normalized, {
    now,
    timezone,
  });
  return runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: result.text,
    kind: result.ok ? "success" : "error",
  }).then(() => null);
}

async function handleAppointmentCommand(runtime, normalized) {
  const chatScopeKey = buildChatScopeKey(runtime, normalized);
  if (!chatScopeKey) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话没有可用的聊天上下文，暂时无法管理预约。",
      kind: "error",
    });
    return;
  }

  const now = new Date();
  const timezone = resolveAppointmentTimezone(runtime);
  const body = extractAppointmentValue(normalized.text);
  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);

  if (!body) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildAppointmentHelpText(scope, { timezone, now }),
    });
    return;
  }

  const command = parseAppointmentCommand(body);
  if (!command) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildAppointmentHelpText(scope, { timezone, now }),
      kind: "error",
    });
    return;
  }

  if (command.type === "list") {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildAppointmentListText(scope, {
        filter: command.filter,
        timezone,
        now,
      }),
    });
    return;
  }

  if (command.type === "cancel") {
    const result = cancelAppointment(runtime, chatScopeKey, command.appointmentId, now);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: result.text,
      kind: result.ok ? "success" : "error",
    });
    return;
  }

  if (command.type === "edit") {
    const result = await editAppointment(runtime, normalized, {
      chatScopeKey,
      appointmentId: command.appointmentId,
      fields: command.fields,
      now,
      timezone,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: result.text,
      kind: result.ok ? "success" : "error",
    });
    return;
  }

  if (command.type === "customer_note") {
    const result = updateCustomerProfileNote(runtime, chatScopeKey, {
      customerName: command.customerName,
      note: command.note,
      normalized,
      now,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: result.text,
      kind: result.ok ? "success" : "error",
    });
    return;
  }

  if (command.type === "customer") {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildCustomerProfileText(scope, command.customerName, {
        timezone,
        now,
      }),
    });
  }
}

function handleAppointmentCardAction(runtime, action, normalized) {
  if (action?.kind !== APPOINTMENT_KIND) {
    return null;
  }

  if (action.action === "confirm_create") {
    return runtime.queueCardActionWithFeedback(
      normalized,
      "正在保存预约...",
      async () => {
        const result = await confirmAppointmentDraft(runtime, action, normalized);
        await runtime.patchInteractiveCard({
          messageId: normalized.messageId,
          card: buildAppointmentResolvedCard(result.cardData, {
            statusText: result.cardText,
            template: result.ok ? "green" : "red",
            timezone: resolveAppointmentTimezone(runtime),
          }),
        });
        await runtime.sendInfoCardMessage({
          chatId: normalized.chatId,
          replyToMessageId: normalized.messageId,
          text: result.text,
          kind: result.ok ? "success" : "error",
        });
      }
    );
  }

  if (action.action === "cancel_create") {
    return runtime.queueCardActionWithFeedback(
      normalized,
      "正在取消预约创建...",
      async () => {
        const result = cancelAppointmentDraft(runtime, action, normalized);
        await runtime.patchInteractiveCard({
          messageId: normalized.messageId,
          card: buildAppointmentResolvedCard(result.cardData, {
            statusText: result.cardText,
            template: "grey",
            timezone: resolveAppointmentTimezone(runtime),
          }),
        });
        await runtime.sendInfoCardMessage({
          chatId: normalized.chatId,
          replyToMessageId: normalized.messageId,
          text: result.text,
          kind: result.ok ? "success" : "error",
        });
      }
    );
  }

  return runtime.buildCardToast("未支持的预约卡片操作。");
}

function startAppointmentReminderScheduler(runtime) {
  if (!runtime?.config?.appointmentReminderEnabled) {
    return null;
  }

  const intervalSec = normalizePositiveInt(
    runtime.config.appointmentReminderScanIntervalSec,
    DEFAULT_SCAN_INTERVAL_SEC
  );
  runAppointmentReminderScan(runtime).catch((error) => {
    logger.error("appointment reminder initial scan failed", { error });
  });

  const timer = setInterval(() => {
    runAppointmentReminderScan(runtime).catch((error) => {
      logger.error("appointment reminder scan failed", { error });
    });
  }, intervalSec * 1000);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  logger.info("appointment reminder scheduler started", {
    intervalSec,
    timezone: resolveAppointmentTimezone(runtime),
  });
  return timer;
}

async function runAppointmentReminderScan(runtime, { now = new Date() } = {}) {
  const timezone = resolveAppointmentTimezone(runtime);
  const scopes = runtime.sessionStore.getAllAppointmentScopes();
  for (const { chatScopeKey, scope } of scopes) {
    const dueAppointments = Object.values(scope.appointmentsById || {})
      .filter((item) => shouldSendReminder(item, now))
      .sort((left, right) => left.reminderAt.localeCompare(right.reminderAt));

    for (const appointment of dueAppointments) {
      try {
        const reminderText = buildAppointmentReminderText(scope, appointment, {
          timezone,
          now,
        });
        await runtime.sendInfoCardMessage({
          chatId: appointment.chatId || scope.chatId,
          text: reminderText,
          kind: "info",
        });
        runtime.sessionStore.updateAppointmentScope(chatScopeKey, (current) => {
          const next = cloneScope(current);
          const currentAppointment = next.appointmentsById[appointment.id];
          if (currentAppointment) {
            currentAppointment.reminderSentAt = now.toISOString();
            currentAppointment.updatedAt = now.toISOString();
          }
          return next;
        });
      } catch (error) {
        logger.error("failed to send appointment reminder", {
          chatScopeKey,
          appointmentId: appointment.id,
          error,
        });
      }
    }
  }
}

function parseNaturalLanguageAppointmentText(text, { now = new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  const sourceText = String(text || '').trim();
  if (!sourceText) {
    return { intentDetected: false, datetimeDetected: false, ok: false, message: '' };
  }

  const appointmentIndex = sourceText.indexOf('\u9884\u7ea6');
  if (appointmentIndex >= 0) {
    return parseExplicitAppointmentText(sourceText, appointmentIndex, { now, timezone });
  }

  const dateTimeResult = parseAppointmentDateTime(sourceText, {
    now,
    timezone,
  });
  if (!dateTimeResult) {
    return { intentDetected: false, datetimeDetected: false, ok: false, message: '' };
  }

  if (!dateTimeResult.ok) {
    return {
      intentDetected: true,
      datetimeDetected: true,
      ok: false,
      message: dateTimeResult.message,
    };
  }

  const implicitParts = splitImplicitAppointmentText(sourceText, dateTimeResult);
  if (!isLikelyImplicitAppointmentText(sourceText, implicitParts)) {
    return { intentDetected: false, datetimeDetected: false, ok: false, message: '' };
  }

  const customerCandidate = cleanCustomerName(implicitParts.customerText);
  const noteResult = extractNoteSegment(implicitParts.serviceText);
  const serviceName = cleanServiceName(
    stripDetectedDateTimeText(noteResult.baseText, dateTimeResult)
      .replace(/[\uFF0C,\u3002\uFF1B;:\uFF1A]+/g, ' ')
  );

  if (!customerCandidate) {
    return buildParseError('\u6211\u8bc6\u522b\u5230\u4e86\u9884\u7ea6\u65f6\u95f4\uff0c\u4f46\u8fd8\u6ca1\u8bc6\u522b\u51fa\u5ba2\u6237\u59d3\u540d\u3002\u8bf7\u7528\u201c\u5f20\u4e09\u9884\u7ea6\u660e\u5929\u4e0b\u5348\u4e09\u70b9\u67d3\u53d1\u201d\u8fd9\u79cd\u683c\u5f0f\u3002');
  }
  if (!serviceName) {
    return buildParseError('\u6211\u8bc6\u522b\u5230\u4e86\u9884\u7ea6\u65f6\u95f4\uff0c\u4f46\u8fd8\u6ca1\u8bc6\u522b\u51fa\u670d\u52a1\u9879\u76ee\u3002\u8bf7\u8865\u4e0a\u7c7b\u4f3c\u201c\u67d3\u53d1\u201d\u201c\u526a\u53d1\u201d\u201c\u70eb\u53d1\u201d\u7684\u9879\u76ee\u3002');
  }

  const appointmentAt = dateTimeResult.date;
  if (!(appointmentAt instanceof Date) || Number.isNaN(appointmentAt.getTime())) {
    return buildParseError('\u8fd9\u6761\u9884\u7ea6\u7684\u65f6\u95f4\u6ca1\u6709\u89e3\u6790\u6210\u529f\uff0c\u8bf7\u6362\u6210\u201c\u660e\u5929\u4e0b\u5348\u4e09\u70b9\u201d\u6216\u201c5\u670821\u53f7 15:00\u201d\u518d\u53d1\u4e00\u6b21\u3002');
  }

  if (appointmentAt.getTime() <= now.getTime()) {
    return buildParseError('\u8fd9\u6761\u9884\u7ea6\u65f6\u95f4\u5df2\u7ecf\u8fc7\u53bb\u4e86\uff0c\u6211\u6ca1\u6709\u4fdd\u5b58\u3002\u8bf7\u53d1\u4e00\u4e2a\u672a\u6765\u65f6\u95f4\u3002');
  }

  const reminderAt = computeReminderTime(appointmentAt, now, timezone);
  return {
    intentDetected: true,
    datetimeDetected: true,
    ok: true,
    customerName: customerCandidate,
    normalizedCustomerName: normalizeCustomerName(customerCandidate),
    serviceName,
    appointmentAt,
    reminderAt,
    note: noteResult.note,
    sourceText,
  };
}

function parseNaturalLanguagePersonalAppointmentText(text, { now = new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  const sourceText = String(text || "").trim();
  if (!sourceText || !hasPersonalReminderIntent(sourceText)) {
    return { intentDetected: false, datetimeDetected: false, ok: false, message: "" };
  }
  if (looksLikeCustomerAppointmentWithReminder(sourceText)) {
    return { intentDetected: false, datetimeDetected: false, ok: false, message: "" };
  }

  const appointmentResult = parsePersonalAppointmentDateTime(sourceText, { now, timezone });
  if (!appointmentResult) {
    return {
      intentDetected: true,
      datetimeDetected: false,
      ok: false,
      message: "我识别到这是个人提醒，但还没识别出事项时间。请用“今晚7点提醒我带东西”或“预约19:00，18:50提醒我”。",
    };
  }
  if (!appointmentResult.ok) {
    return {
      intentDetected: true,
      datetimeDetected: true,
      ok: false,
      message: appointmentResult.message,
    };
  }

  const appointmentAt = appointmentResult.date;
  if (!(appointmentAt instanceof Date) || Number.isNaN(appointmentAt.getTime())) {
    return buildParseError("这条个人事项的时间没有解析成功，请换成“今晚7点”或“2026-05-25 19:00”。");
  }
  if (appointmentAt.getTime() <= now.getTime()) {
    return buildParseError("这条个人事项的时间已经过去了，我没有保存。请发一个未来时间。");
  }

  const explicitReminderAt = parsePersonalReminderDateTime(sourceText, appointmentAt, {
    now,
    timezone,
  });
  const reminderAt = explicitReminderAt
    || (appointmentResult.isRelative ? appointmentAt : computeReminderTime(appointmentAt, now, timezone));
  const title = buildPersonalAppointmentTitle(sourceText, appointmentResult);

  return {
    intentDetected: true,
    datetimeDetected: true,
    ok: true,
    customerName: "我",
    normalizedCustomerName: "我",
    serviceName: title,
    appointmentAt,
    reminderAt,
    note: "个人事项",
    sourceText,
    kind: "personal_event",
    title,
  };
}

function parseExplicitAppointmentText(sourceText, appointmentIndex, { now, timezone }) {
  const rawCustomerText = sourceText.slice(0, appointmentIndex);
  const afterKeyword = sourceText.slice(appointmentIndex + '\u9884\u7ea6'.length).trim();
  const noteResult = extractNoteSegment(afterKeyword);
  const dateTimeResult = parseAppointmentDateTime(noteResult.baseText, {
    now,
    timezone,
  }) || parseAppointmentDateTime(rawCustomerText, {
    now,
    timezone,
  }) || parseAppointmentDateTime(sourceText, {
    now,
    timezone,
  });
  const customerCandidate = cleanCustomerName(
    dateTimeResult
      ? stripDetectedDateTimeText(rawCustomerText, dateTimeResult)
      : rawCustomerText
  );
  const serviceTextWithoutDateTime = removeDateLikeFragments(noteResult.baseText);
  const serviceName = cleanServiceName(
    serviceTextWithoutDateTime.replace(/[\uFF0C,\u3002\uFF1B;:\uFF1A]+/g, ' ')
  );

  if (!dateTimeResult) {
    return {
      intentDetected: true,
      datetimeDetected: false,
      ok: false,
      customerName: customerCandidate,
      normalizedCustomerName: normalizeCustomerName(customerCandidate),
      serviceName,
      note: noteResult.note,
      sourceText,
      message: '',
    };
  }

  if (!dateTimeResult.ok) {
    return {
      intentDetected: true,
      datetimeDetected: true,
      ok: false,
      message: dateTimeResult.message,
    };
  }

  const resolvedServiceName = cleanServiceName(
    stripDetectedDateTimeText(noteResult.baseText, dateTimeResult)
      .replace(/[\uFF0C,\u3002\uFF1B;:\uFF1A]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  const normalizedServiceName = cleanServiceName(
    removeDateLikeFragments(
      stripDetectedDateTimeText(noteResult.baseText, dateTimeResult)
      .replace(/[\uFF0C,\u3002\uFF1B;:\uFF1A]+/g, ' ')
    )
  );
  const finalServiceName = normalizedServiceName || resolvedServiceName;

  if (!customerCandidate) {
    return buildParseError('\u6211\u8bc6\u522b\u5230\u4e86\u9884\u7ea6\u65f6\u95f4\uff0c\u4f46\u8fd8\u6ca1\u8bc6\u522b\u51fa\u5ba2\u6237\u59d3\u540d\u3002\u8bf7\u7528\u201c\u5f20\u4e09\u9884\u7ea6\u660e\u5929\u4e0b\u5348\u4e09\u70b9\u67d3\u53d1\u201d\u8fd9\u79cd\u683c\u5f0f\u3002');
  }
  if (!finalServiceName) {
    return buildParseError('\u6211\u8bc6\u522b\u5230\u4e86\u9884\u7ea6\u65f6\u95f4\uff0c\u4f46\u8fd8\u6ca1\u8bc6\u522b\u51fa\u670d\u52a1\u9879\u76ee\u3002\u8bf7\u8865\u4e0a\u7c7b\u4f3c\u201c\u67d3\u53d1\u201d\u201c\u526a\u53d1\u201d\u201c\u70eb\u53d1\u201d\u7684\u9879\u76ee\u3002');
  }

  const appointmentAt = dateTimeResult.date;
  if (!(appointmentAt instanceof Date) || Number.isNaN(appointmentAt.getTime())) {
    return buildParseError('\u8fd9\u6761\u9884\u7ea6\u7684\u65f6\u95f4\u6ca1\u6709\u89e3\u6790\u6210\u529f\uff0c\u8bf7\u6362\u6210\u201c\u660e\u5929\u4e0b\u5348\u4e09\u70b9\u201d\u6216\u201c5\u670821\u53f7 15:00\u201d\u518d\u53d1\u4e00\u6b21\u3002');
  }

  if (appointmentAt.getTime() <= now.getTime()) {
    return buildParseError('\u8fd9\u6761\u9884\u7ea6\u65f6\u95f4\u5df2\u7ecf\u8fc7\u53bb\u4e86\uff0c\u6211\u6ca1\u6709\u4fdd\u5b58\u3002\u8bf7\u53d1\u4e00\u4e2a\u672a\u6765\u65f6\u95f4\u3002');
  }

  const reminderAt = computeReminderTime(appointmentAt, now, timezone);
  return {
    intentDetected: true,
    datetimeDetected: true,
    ok: true,
    customerName: customerCandidate,
    normalizedCustomerName: normalizeCustomerName(customerCandidate),
    serviceName: finalServiceName,
    appointmentAt,
    reminderAt,
    note: noteResult.note,
    sourceText,
  };
}

function splitImplicitAppointmentText(sourceText, dateTimeResult) {
  const source = String(sourceText || '');
  const dateText = String(dateTimeResult?.matchedDateText || '').trim();
  const timeText = String(dateTimeResult?.matchedTimeText || '').trim();
  const dateIndex = dateText ? source.indexOf(dateText) : -1;
  const timeIndex = timeText ? source.indexOf(timeText, dateIndex >= 0 ? dateIndex + dateText.length : 0) : -1;

  if (dateIndex < 0 || timeIndex < 0) {
    return {
      customerText: '',
      serviceText: stripDetectedDateTimeText(source, dateTimeResult).trim(),
    };
  }

  const customerText = source.slice(0, dateIndex).trim();
  const serviceText = [
    source.slice(dateIndex + dateText.length, timeIndex).trim(),
    source.slice(timeIndex + timeText.length).trim(),
  ].filter(Boolean).join(' ').trim();

  return { customerText, serviceText };
}

function isLikelyImplicitAppointmentText(sourceText, parts) {
  const text = String(sourceText || '').trim();
  const customerText = String(parts?.customerText || '').trim();
  const serviceText = String(parts?.serviceText || '').trim();
  if (!customerText && !serviceText) {
    return false;
  }
  if (/(?:\u5e2e\u6211\u67e5|\u5e2e\u6211\u770b|\u4e3a\u4ec0\u4e48|\u600e\u4e48|\u80fd\u4e0d\u80fd|\u53ef\u4e0d\u53ef\u4ee5|\u67e5\u8be2|\u67e5\u770b|\u67e5\u4e00\u4e0b|\u67e5\u4e0b|\u529f\u80fd|\u95ee\u9898|\u539f\u56e0)/.test(text)) {
    return false;
  }
  return Boolean(customerText || serviceText);
}

function parseAppointmentCommand(body) {
  const raw = String(body || "").trim();
  if (!raw) {
    return null;
  }

  const listMatch = raw.match(/^(列表|list)(?:\s+(\S+))?$/i);
  if (listMatch) {
    return {
      type: "list",
      filter: normalizeListFilter(listMatch[2] || "今天"),
    };
  }

  const cancelMatch = raw.match(/^(取消|cancel)\s+(\S+)$/i);
  if (cancelMatch) {
    return {
      type: "cancel",
      appointmentId: String(cancelMatch[2] || "").trim(),
    };
  }

  const editMatch = raw.match(/^(修改|edit)\s+(\S+)(?:\s+(.+))?$/i);
  if (editMatch) {
    return {
      type: "edit",
      appointmentId: String(editMatch[2] || "").trim(),
      fields: parseEditFields(editMatch[3] || ""),
    };
  }

  const customerNoteMatch = raw.match(/^(客户|customer)\s+(\S+)\s+(备注|note)\s+(.+)$/i);
  if (customerNoteMatch) {
    return {
      type: "customer_note",
      customerName: customerNoteMatch[2].trim(),
      note: customerNoteMatch[4].trim(),
    };
  }

  const customerMatch = raw.match(/^(客户|customer)\s+(\S+)$/i);
  if (customerMatch) {
    return {
      type: "customer",
      customerName: customerMatch[2].trim(),
    };
  }

  return null;
}

function parseEditFields(raw) {
  const input = String(raw || "").trim();
  if (!input) {
    return {};
  }
  const matches = [...input.matchAll(/(时间|time|项目|service|备注|note)\s*=\s*/gi)];
  if (!matches.length) {
    return {};
  }

  const fields = {};
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const key = normalizeEditFieldKey(match[1]);
    const valueStart = match.index + match[0].length;
    const valueEnd = index + 1 < matches.length ? matches[index + 1].index : input.length;
    const value = input.slice(valueStart, valueEnd).trim();
    if (key && value) {
      fields[key] = value;
    }
  }
  return fields;
}

function normalizeEditFieldKey(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (key === "时间" || key === "time") {
    return "time";
  }
  if (key === "项目" || key === "service") {
    return "service";
  }
  if (key === "备注" || key === "note") {
    return "note";
  }
  return "";
}

async function confirmAppointmentDraft(runtime, action, normalized) {
  const chatScopeKey = resolveActionChatScopeKey(runtime, action, normalized);
  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const draft = scope.pendingDraftsById?.[action.draftId] || null;
  if (!draft) {
    return {
      ok: false,
      text: "这张预约确认卡已经失效了，请重新发送预约信息。",
      cardText: "预约草稿已失效",
      cardData: null,
    };
  }

  const now = new Date();
  const timezone = resolveAppointmentTimezone(runtime);
  const appointmentId = generateAppointmentId(scope, draft.appointmentAt, timezone);
  const appointment = {
    id: appointmentId,
    chatId: draft.chatId,
    workspaceId: draft.workspaceId,
    customerName: draft.customerName,
    normalizedCustomerName: draft.normalizedCustomerName,
    serviceName: draft.serviceName,
    appointmentAt: draft.appointmentAt,
    reminderAt: draft.reminderAt,
    note: draft.note,
    status: "pending",
    createdAt: draft.createdAt,
    updatedAt: now.toISOString(),
    confirmedAt: now.toISOString(),
    reminderSentAt: "",
    sourceMessageId: draft.sourceMessageId,
    sourceSenderId: draft.sourceSenderId,
  };

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, (current) => {
    const next = ensureScopeDefaults(current, draft);
    const dateKey = buildSequenceDateKey(draft.appointmentAt, timezone);
    next.sequenceByDate[dateKey] = (next.sequenceByDate[dateKey] || 0) + 1;
    next.appointmentsById[appointmentId] = appointment;
    delete next.pendingDraftsById[draft.draftId];
    const profileKey = draft.normalizedCustomerName;
    const currentProfile = next.customerProfilesByName[profileKey] || {
      displayName: draft.customerName,
      normalizedName: profileKey,
      profileNote: "",
      historyAppointmentIds: [],
      updatedAt: "",
    };
    currentProfile.displayName = currentProfile.displayName || draft.customerName;
    currentProfile.normalizedName = profileKey;
    currentProfile.historyAppointmentIds = dedupeArray([
      appointmentId,
      ...(currentProfile.historyAppointmentIds || []),
    ]);
    currentProfile.updatedAt = now.toISOString();
    next.customerProfilesByName[profileKey] = currentProfile;
    return next;
  });

  const appointmentAtDate = new Date(appointment.appointmentAt);
  const reminderAtDate = new Date(appointment.reminderAt);
  if (
    Number.isFinite(appointmentAtDate.getTime())
    && Number.isFinite(reminderAtDate.getTime())
    && appointmentAtDate.getTime() > now.getTime()
    && reminderAtDate.getTime() <= now.getTime()
  ) {
    await sendSingleAppointmentReminder(runtime, chatScopeKey, appointmentId, { now });
  }

  return {
    ok: true,
    text: [
      `已创建预约：${appointmentId}`,
      `客户：${appointment.customerName}`,
      `时间：${formatAppointmentDateTime(appointment.appointmentAt, timezone)}`,
      `项目：${appointment.serviceName}`,
      `提醒：${formatReminderDateTime(appointment.reminderAt, timezone, now)}`,
      appointment.note ? `备注：${appointment.note}` : "",
    ].filter(Boolean).join("\n"),
    cardText: `已确认并创建预约 ${appointmentId}`,
    cardData: appointment,
  };
}

function cancelAppointmentDraft(runtime, action, normalized) {
  const chatScopeKey = resolveActionChatScopeKey(runtime, action, normalized);
  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const draft = scope.pendingDraftsById?.[action.draftId] || null;
  if (!draft) {
    return {
      ok: false,
      text: "这张预约确认卡已经失效了，没有需要取消的草稿。",
      cardText: "预约草稿已失效",
      cardData: null,
    };
  }

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, (current) => {
    const next = cloneScope(current);
    delete next.pendingDraftsById[action.draftId];
    return next;
  });

  return {
    ok: true,
    text: "已取消这条预约草稿，没有保存到提醒列表。",
    cardText: "已取消预约创建",
    cardData: draft,
  };
}

function cancelAppointment(runtime, chatScopeKey, appointmentId, now) {
  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const current = scope.appointmentsById?.[appointmentId] || null;
  if (!current) {
    return {
      ok: false,
      text: `没有找到预约 ${appointmentId}。`,
    };
  }
  if (current.status === "cancelled") {
    return {
      ok: false,
      text: `预约 ${appointmentId} 已经取消过了。`,
    };
  }

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, (existing) => {
    const next = cloneScope(existing);
    const appointment = next.appointmentsById[appointmentId];
    if (appointment) {
      appointment.status = "cancelled";
      appointment.updatedAt = now.toISOString();
    }
    return next;
  });
  return {
    ok: true,
    text: `已取消预约 ${appointmentId}，后续不会再提醒。`,
  };
}

async function editAppointment(runtime, normalized, {
  chatScopeKey,
  appointmentId,
  fields,
  now,
  timezone,
}) {
  if (!fields || !Object.keys(fields).length) {
    return {
      ok: false,
      text: "用法：`/预约 修改 <预约ID> 时间=明天下午三点 项目=服务沟通 备注=带上方案`",
    };
  }

  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const current = scope.appointmentsById?.[appointmentId] || null;
  if (!current) {
    return {
      ok: false,
      text: `没有找到预约 ${appointmentId}。`,
    };
  }
  if (current.status !== "pending") {
    return {
      ok: false,
      text: `预约 ${appointmentId} 当前状态是 ${current.status}，不能再修改。`,
    };
  }

  const nextAppointment = { ...current };
  if (fields.time) {
    const dateTimeResult = parseAppointmentDateTime(fields.time, { now, timezone });
    if (!dateTimeResult || !dateTimeResult.ok) {
      return {
        ok: false,
        text: dateTimeResult?.message || "新的预约时间没有解析成功，请换成“明天下午三点”或“5月21号 15:00”。",
      };
    }
    if (dateTimeResult.date.getTime() <= now.getTime()) {
      return {
        ok: false,
        text: "新的预约时间已经过去了，请设置一个未来时间。",
      };
    }
    nextAppointment.appointmentAt = dateTimeResult.date.toISOString();
    nextAppointment.reminderAt = computeReminderTime(dateTimeResult.date, now, timezone).toISOString();
    nextAppointment.reminderSentAt = "";
  }
  if (fields.service) {
    nextAppointment.serviceName = cleanServiceName(fields.service);
  }
  if (fields.note) {
    nextAppointment.note = cleanNote(fields.note);
  }
  if (!nextAppointment.serviceName) {
    return {
      ok: false,
      text: "服务项目不能为空。",
    };
  }
  nextAppointment.updatedAt = now.toISOString();

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, (existing) => {
    const next = cloneScope(existing);
    next.appointmentsById[appointmentId] = nextAppointment;
    return next;
  });

  const appointmentAtDate = new Date(nextAppointment.appointmentAt);
  const reminderAtDate = new Date(nextAppointment.reminderAt);
  if (
    Number.isFinite(appointmentAtDate.getTime())
    && Number.isFinite(reminderAtDate.getTime())
    && appointmentAtDate.getTime() > now.getTime()
    && reminderAtDate.getTime() <= now.getTime()
  ) {
    await sendSingleAppointmentReminder(runtime, chatScopeKey, appointmentId, { now });
  }

  return {
    ok: true,
    text: [
      `已更新预约 ${appointmentId}`,
      `客户：${nextAppointment.customerName}`,
      `时间：${formatAppointmentDateTime(nextAppointment.appointmentAt, timezone)}`,
      `项目：${nextAppointment.serviceName}`,
      `提醒：${formatReminderDateTime(nextAppointment.reminderAt, timezone, now)}`,
      nextAppointment.note ? `备注：${nextAppointment.note}` : "",
    ].filter(Boolean).join("\n"),
  };
}

function updateCustomerProfileNote(runtime, chatScopeKey, {
  customerName,
  note,
  normalized,
  now,
}) {
  const displayName = cleanCustomerName(customerName);
  const normalizedName = normalizeCustomerName(displayName);
  if (!displayName || !normalizedName || !note) {
    return {
      ok: false,
      text: "用法：`/预约 客户 张三 备注 偏好线上沟通`",
    };
  }

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, (existing) => {
    const next = ensureScopeDefaults(existing, normalized);
    const current = next.customerProfilesByName[normalizedName] || {
      displayName,
      normalizedName,
      profileNote: "",
      historyAppointmentIds: [],
      updatedAt: "",
    };
    current.displayName = current.displayName || displayName;
    current.normalizedName = normalizedName;
    current.profileNote = cleanNote(note);
    current.updatedAt = now.toISOString();
    next.customerProfilesByName[normalizedName] = current;
    return next;
  });

  return {
    ok: true,
    text: `已更新客户 ${displayName} 的长期备注。`,
  };
}

async function sendSingleAppointmentReminder(runtime, chatScopeKey, appointmentId, { now = new Date() } = {}) {
  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const appointment = scope.appointmentsById?.[appointmentId] || null;
  if (!appointment || !shouldSendReminder(appointment, now)) {
    return false;
  }

  await runtime.sendInfoCardMessage({
    chatId: appointment.chatId || scope.chatId,
    text: buildAppointmentReminderText(scope, appointment, {
      timezone: resolveAppointmentTimezone(runtime),
      now,
    }),
    kind: "info",
  });

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, (existing) => {
    const next = cloneScope(existing);
    const current = next.appointmentsById[appointmentId];
    if (current) {
      current.reminderSentAt = now.toISOString();
      current.updatedAt = now.toISOString();
    }
    return next;
  });
  return true;
}

function buildAppointmentHelpText(scope, { timezone, now }) {
  return [
    "**预约助手**",
    "这是随 bridge 打包的可选示例能力，不属于 Feishu/Codex 桥接核心。",
    "直接发自然语言也可以，例如：`张三预约明天下午三点服务沟通，备注带上方案`",
    "",
    "**常用命令**",
    "`/预约`",
    "`/预约 列表 今天`",
    "`/预约 列表 明天`",
    "`/预约 列表 全部`",
    "`/预约 取消 <预约ID>`",
    "`/预约 修改 <预约ID> 时间=明天下午三点 项目=服务沟通 备注=带上方案`",
    "`/预约 客户 张三`",
    "`/预约 客户 张三 备注 偏好线上沟通`",
    "`/appoint ...` 也可以作为 ASCII 别名",
    "",
    buildAppointmentTodaySummary(scope, { timezone, now }),
  ].join("\n");
}

function buildAppointmentTodaySummary(scope, { timezone, now }) {
  const todayAppointments = collectAppointments(scope, {
    filter: "today",
    timezone,
    now,
    includeStatuses: ["pending"],
  });
  if (!todayAppointments.length) {
    return "今天还没有待提醒的预约。";
  }
  return [
    `今天待提醒预约：${todayAppointments.length} 条`,
    ...todayAppointments.slice(0, 5).map((item) => (
      `- ${item.id} ${item.customerName} · ${formatAppointmentDateTime(item.appointmentAt, timezone)} · ${item.serviceName}`
    )),
  ].join("\n");
}

function buildAppointmentListText(scope, {
  filter = "today",
  timezone,
  now,
}) {
  const appointments = collectAppointments(scope, {
    filter,
    timezone,
    now,
    includeStatuses: ["pending", "cancelled", "completed"],
  });
  if (!appointments.length) {
    return `当前筛选下没有预约记录：${translateListFilter(filter)}。`;
  }
  return [
    `**预约列表 - ${translateListFilter(filter)}**`,
    ...appointments.map((item) => {
      const lines = [
        `${item.id} [${translateStatus(item.status)}]`,
        `客户：${item.customerName}`,
        `时间：${formatAppointmentDateTime(item.appointmentAt, timezone)}`,
        `项目：${item.serviceName}`,
        `提醒：${formatReminderDateTime(item.reminderAt, timezone, now)}`,
      ];
      if (item.note) {
        lines.push(`备注：${item.note}`);
      }
      return lines.join("\n");
    }),
  ].join("\n\n");
}

function buildCustomerProfileText(scope, customerName, { timezone, now }) {
  const displayName = cleanCustomerName(customerName);
  const normalizedName = normalizeCustomerName(displayName);
  if (!displayName || !normalizedName) {
    return "用法：`/预约 客户 张三`";
  }

  const history = summarizeCustomerHistory(scope, normalizedName, {
    timezone,
    now,
    includeCurrentPending: true,
  });
  if (!history.profile && !history.items.length) {
    return `还没有客户 ${displayName} 的档案或预约历史。`;
  }

  const lines = [
    `**客户档案：${displayName}**`,
    history.profile?.profileNote ? `长期备注：${history.profile.profileNote}` : "长期备注：未设置",
  ];
  if (!history.items.length) {
    lines.push("预约历史：暂无");
    return lines.join("\n");
  }

  lines.push("", "**最近预约**");
  for (const item of history.items) {
    lines.push(
      `${item.id} [${translateStatus(item.status)}] ${formatAppointmentDateTime(item.appointmentAt, timezone)} · ${item.serviceName}`
    );
  }
  return lines.join("\n");
}

function buildAppointmentQueryReplyText(scope, query, {
  timezone,
  now,
}) {
  const filter = normalizeListFilter(query?.filter || "today");
  const customerName = cleanCustomerName(query?.customerName || "");
  const appointments = collectAppointments(scope, {
    filter,
    timezone,
    now,
    includeStatuses: ["pending", "cancelled", "completed"],
    customerName,
  });
  const baseLabel = cleanAppointmentQueryFilterLabel(query?.label || translateListFilter(filter));
  const label = customerName
    ? `${baseLabel}客户 ${customerName}`
    : baseLabel;

  if (query?.mode === "count") {
    if (!appointments.length) {
      return `${label}没有预约。`;
    }
    const lines = [`${label}共有 ${appointments.length} 个预约。`];
    for (const item of appointments.slice(0, 3)) {
      lines.push(`- ${formatAppointmentDateTime(item.appointmentAt, timezone)} ${item.customerName} / ${item.serviceName}`);
    }
    if (appointments.length > 3) {
      lines.push(buildAppointmentQueryFollowUpHint({
        remainingCount: appointments.length - 3,
        label: baseLabel,
        customerName,
      }));
    }
    return lines.join("\n");
  }

  if (!appointments.length) {
    return `${label}还没有预约。`;
  }

  const lines = [`${label}预约列表，共 ${appointments.length} 个：`];
  for (const item of appointments.slice(0, 5)) {
    const detail = [`- ${formatAppointmentDateTime(item.appointmentAt, timezone)} ${item.customerName} / ${item.serviceName}`];
    if (item.note) {
      detail.push(`（备注：${item.note}）`);
    }
    lines.push(detail.join(""));
  }
  if (appointments.length > 5) {
    lines.push(buildAppointmentQueryFollowUpHint({
      remainingCount: appointments.length - 5,
      label: baseLabel,
      customerName,
    }));
  }
  return lines.join("\n");
}

function buildAppointmentReminderText(scope, appointment, { timezone, now }) {
  const isPersonalEvent = appointment?.kind === "personal_event";
  const history = summarizeCustomerHistory(scope, appointment.normalizedCustomerName, {
    timezone,
    now,
    excludeAppointmentId: appointment.id,
    includeCurrentPending: false,
  });
  const lines = [
    isPersonalEvent ? "**个人事项提醒**" : "**客户预约提醒**",
    `预约ID：${appointment.id}`,
    isPersonalEvent ? `事项：${appointment.title || appointment.serviceName}` : `客户：${appointment.customerName}`,
    `时间：${formatAppointmentDateTime(appointment.appointmentAt, timezone)}`,
    isPersonalEvent ? "" : `项目：${appointment.serviceName}`,
    appointment.note ? `备注：${appointment.note}` : "备注：无",
  ].filter(Boolean);
  if (isPersonalEvent) {
    return lines.join("\n");
  }
  if (history.profile?.profileNote) {
    lines.push(`长期备注：${history.profile.profileNote}`);
  }
  if (history.items.length) {
    lines.push("", "**最近历史**");
    for (const item of history.items) {
      lines.push(
        `- ${formatAppointmentDateTime(item.appointmentAt, timezone)} · ${item.serviceName} [${translateStatus(item.status)}]`
      );
    }
  }
  return lines.join("\n");
}

function buildAppointmentDraftCard({ draft, history, timezone }) {
  const lines = [
    `客户：${draft.customerName}`,
    `时间：${formatAppointmentDateTime(draft.appointmentAt, timezone)}`,
    `项目：${draft.serviceName}`,
    `提醒：${formatAppointmentDateTime(draft.reminderAt, timezone)}`,
    draft.note ? `备注：${escapeCardMarkdown(draft.note)}` : "备注：无",
  ];
  if (history.profile?.profileNote) {
    lines.push(`长期备注：${escapeCardMarkdown(history.profile.profileNote)}`);
  }
  if (history.items.length) {
    lines.push("", "**最近历史**");
    for (const item of history.items) {
      lines.push(
        `- ${escapeCardMarkdown(formatAppointmentDateTime(item.appointmentAt, timezone))} · ${escapeCardMarkdown(item.serviceName)} [${translateStatus(item.status)}]`
      );
    }
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "确认预约创建",
      },
      template: "green",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            "**我识别到了一条预约**",
            "",
            lines.join("\n"),
            "",
            "确认无误后再点“确认创建”。",
          ].join("\n"),
          text_size: "normal",
        },
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
                  text: { tag: "plain_text", content: "确认创建" },
                  type: "primary",
                  value: {
                    kind: APPOINTMENT_KIND,
                    action: "confirm_create",
                    draftId: draft.draftId,
                    chatScopeKey: `${draft.workspaceId}:${draft.chatId}`,
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
                  text: { tag: "plain_text", content: "取消" },
                  type: "danger",
                  value: {
                    kind: APPOINTMENT_KIND,
                    action: "cancel_create",
                    draftId: draft.draftId,
                    chatScopeKey: `${draft.workspaceId}:${draft.chatId}`,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function buildAppointmentResolvedCard(data, { statusText, template = "blue", timezone = DEFAULT_TIMEZONE } = {}) {
  const lines = [];
  if (data?.customerName) {
    lines.push(`客户：${data.customerName}`);
  }
  if (data?.appointmentAt) {
    lines.push(`时间：${formatAppointmentDateTime(data.appointmentAt, timezone)}`);
  }
  if (data?.serviceName) {
    lines.push(`项目：${data.serviceName}`);
  }
  if (data?.note) {
    lines.push(`备注：${data.note}`);
  }
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: "预约处理结果",
      },
      template,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**${escapeCardMarkdown(statusText || "已处理")}**`,
            "",
            ...lines.map((item) => escapeCardMarkdown(item)),
          ].join("\n"),
          text_size: "normal",
        },
      ],
    },
  };
}

function summarizeCustomerHistory(scope, normalizedCustomerName, {
  timezone,
  now,
  excludeAppointmentId = "",
  includeCurrentPending = false,
} = {}) {
  const profile = scope.customerProfilesByName?.[normalizedCustomerName] || null;
  const items = Object.values(scope.appointmentsById || {})
    .filter((item) => item.normalizedCustomerName === normalizedCustomerName)
    .filter((item) => includeCurrentPending || item.id !== excludeAppointmentId)
    .sort((left, right) => right.appointmentAt.localeCompare(left.appointmentAt))
    .slice(0, MAX_HISTORY_ITEMS);
  return {
    profile,
    items,
    timezone,
    now,
  };
}

function collectAppointments(scope, {
  filter = "today",
  timezone = DEFAULT_TIMEZONE,
  now = new Date(),
  includeStatuses = ["pending"],
  customerName = "",
} = {}) {
  const items = Object.values(scope.appointmentsById || {})
    .filter((item) => includeStatuses.includes(item.status))
    .filter((item) => {
      if (!customerName) {
        return true;
      }
      return item.normalizedCustomerName === normalizeCustomerName(customerName);
    })
    .sort((left, right) => left.appointmentAt.localeCompare(right.appointmentAt));
  if (filter === "all") {
    return items;
  }

  return items.filter((item) => matchesAppointmentFilter(item.appointmentAt, timezone, now, filter));
}

function parseNaturalLanguageAppointmentQuery(text, {
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const compact = raw.replace(/\s+/g, "");
  const temporalContext = extractAppointmentQueryTemporalContext(raw, {
    now,
    timezone,
  });
  const hasAppointmentKeyword = /(预约|appoint|appointment)/i.test(raw);
  const hasAvailabilityKeyword = /(还有吗|还忙吗|忙不忙|空不空|有空吗|有时间吗|有档期吗|有安排吗|约满了吗|满不满|忙吗)/i.test(compact);
  const hasCountKeyword = /((有|共|总共|一共)?几(个|条)?预约)|((how\s+many).*(appointment|appointments))|((appointment|appointments).*(how\s+many))/i.test(raw);
  const hasListKeyword = /(有哪些预约|预约有哪些|预约列表|列出.*预约|看看.*预约|查看.*预约|list.*appointment|show.*appointment|安排有哪些|有哪些安排|日程|排期|档期)/i.test(compact);
  const hasScheduleKeyword = /(安排|日程|排期|档期)/i.test(raw);
  const looksLikeScheduleOverview = looksLikeAppointmentScheduleOverview(compact);
  const customerName = extractCustomerNameFromAppointmentQuery(raw);

  if (!temporalContext) {
    return null;
  }
  if (!hasAppointmentKeyword && !hasAvailabilityKeyword && !hasListKeyword && !looksLikeScheduleOverview && !(customerName && hasScheduleKeyword)) {
    return null;
  }

  if (hasCountKeyword || hasAvailabilityKeyword) {
    return {
      mode: "count",
      filter: temporalContext.filter,
      label: temporalContext.label,
      customerName,
    };
  }

  if (hasListKeyword || hasScheduleKeyword || looksLikeScheduleOverview) {
    return {
      mode: "list",
      filter: temporalContext.filter,
      label: temporalContext.label,
      customerName,
    };
  }

  return null;
}

function extractCustomerNameFromAppointmentQuery(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }

  const customerPossessive = raw.match(/(.+?)的(?:下周[一二三四五六日天]|下星期[一二三四五六日天]|下礼拜[一二三四五六日天]|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|今天|明天|后天|本周|这周|本星期|这星期|下周|下星期|下礼拜|本月|这月|这个月|下月|下个月).*(?:预约|appoint|appointment|安排|日程|排期|档期|还有吗|还忙吗|忙不忙|空不空|有空吗|有时间吗|有档期吗|有安排吗|约满了吗|满不满|忙吗)/i);
  if (customerPossessive) {
    const candidate = cleanCustomerName(
      customerPossessive[1]
        .replace(/^(请问|帮我看下|帮我看看|帮我查下|帮我查查看|查下|查查看|看看|查看|列出|统计|数一下)/, "")
        .replace(/[的\s]+$/g, "")
    );
    if (isLikelyQueryCustomerCandidate(candidate)) {
      return candidate;
    }
  }

  const customerBefore = raw.match(/(.+?)(?:下周[一二三四五六日天]|下星期[一二三四五六日天]|下礼拜[一二三四五六日天]|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|今天|明天|后天|本周|这周|本星期|这星期|下周|下星期|下礼拜|本月|这月|这个月|下月|下个月).*(?:预约|appoint|appointment|安排|日程|排期|档期|还有吗|还忙吗|忙不忙|空不空|有空吗|有时间吗|有档期吗|有安排吗|约满了吗|满不满|忙吗)/i);
  if (customerBefore) {
    const candidate = cleanCustomerName(
      customerBefore[1]
        .replace(/^(请问|帮我看下|帮我看看|帮我查下|帮我查查看|查下|查查看|看看|查看|列出|统计|数一下)/, "")
        .replace(/[的\s]+$/g, "")
    );
    if (isLikelyQueryCustomerCandidate(candidate)) {
      return candidate;
    }
  }

  const customerMiddle = raw.match(/(?:客户|顾客)\s*([^\s，。,.]+).*(?:预约|appoint|appointment|安排|日程|排期|档期|还有吗|还忙吗|忙不忙|空不空|有空吗|有时间吗|有档期吗|有安排吗|约满了吗|满不满|忙吗)/i);
  if (customerMiddle) {
    const candidate = cleanCustomerName(customerMiddle[1]);
    if (isLikelyQueryCustomerCandidate(candidate)) {
      return candidate;
    }
  }

  const customerAfter = raw.match(/(?:下周[一二三四五六日天]|下星期[一二三四五六日天]|下礼拜[一二三四五六日天]|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|今天|明天|后天|本周|这周|本星期|这星期|下周|下星期|下礼拜|本月|这月|这个月|下月|下个月).*(.+?)(?:的)?(?:预约|appoint|appointment|安排|日程|排期|档期|还有吗|还忙吗|忙不忙|空不空|有空吗|有时间吗|有档期吗|有安排吗|约满了吗|满不满|忙吗)/i);
  if (customerAfter) {
    const candidate = cleanCustomerName(
      customerAfter[1]
        .replace(/^(客户|顾客)/, "")
        .replace(/^(有几个|几个|多少个|多少条|多少|有哪些|有什么|有哪几个|预约列表|列表|安排|情况)/, "")
        .replace(/[的\s]+$/g, "")
    );
    if (isLikelyQueryCustomerCandidate(candidate)) {
      return candidate;
    }
  }

  return "";
}

function isLikelyQueryCustomerCandidate(value) {
  const candidate = cleanCustomerName(value);
  if (!candidate) {
    return false;
  }
  if (/^[一二三四五六七八九十日天周月上下本这今明后]$/.test(candidate)) {
    return false;
  }
  if (/^(我|我们|你|你们|有|几个|多少|哪些|什么|预约|个|条|些|安排|情况|列表|下|本|这|上|周|月)$/.test(candidate)) {
    return false;
  }
  return true;
}

function matchesAppointmentFilter(appointmentAtIso, timezone, now, filter) {
  const today = getZonedDateParts(now, timezone);
  if (!today) {
    return false;
  }

  if (filter === "today") {
    return matchesZonedCalendarDate(appointmentAtIso, timezone, today);
  }
  if (filter === "tomorrow") {
    return matchesZonedCalendarDate(appointmentAtIso, timezone, addCalendarDays(today, 1));
  }
  if (filter === "day_after_tomorrow") {
    return matchesZonedCalendarDate(appointmentAtIso, timezone, addCalendarDays(today, 2));
  }
  if (filter === "this_week") {
    return matchesZonedWeekRange(appointmentAtIso, timezone, today);
  }
  if (filter === "next_week") {
    return matchesZonedWeekRange(appointmentAtIso, timezone, addCalendarDays(today, 7));
  }
  if (filter === "this_month") {
    return matchesZonedMonthRange(appointmentAtIso, timezone, today);
  }
  if (filter === "next_month") {
    return matchesZonedMonthRange(appointmentAtIso, timezone, addCalendarMonths(today, 1));
  }
  if (filter === "this_weekend") {
    return matchesZonedWeekendRange(appointmentAtIso, timezone, today);
  }
  if (filter === "next_weekend") {
    return matchesZonedWeekendRange(appointmentAtIso, timezone, addCalendarDays(today, 7));
  }
  const targetDate = parseDateFilter(filter);
  if (targetDate) {
    return matchesZonedCalendarDate(appointmentAtIso, timezone, targetDate);
  }
  return matchesZonedCalendarDate(appointmentAtIso, timezone, today);
}

function matchesZonedWeekRange(appointmentAtIso, timezone, todayParts) {
  const appointmentDate = new Date(appointmentAtIso);
  const parts = getZonedDateParts(appointmentDate, timezone);
  if (!parts) {
    return false;
  }
  const start = startOfWeek(todayParts);
  const end = addCalendarDays(start, 6);
  const currentValue = toDateValue(parts);
  return currentValue >= toDateValue(start) && currentValue <= toDateValue(end);
}

function matchesZonedMonthRange(appointmentAtIso, timezone, monthParts) {
  const appointmentDate = new Date(appointmentAtIso);
  const parts = getZonedDateParts(appointmentDate, timezone);
  if (!parts) {
    return false;
  }
  return parts.year === monthParts.year && parts.month === monthParts.month;
}

function matchesZonedWeekendRange(appointmentAtIso, timezone, referenceParts) {
  const appointmentDate = new Date(appointmentAtIso);
  const parts = getZonedDateParts(appointmentDate, timezone);
  if (!parts) {
    return false;
  }
  const weekend = resolveWeekendRange(referenceParts);
  const currentValue = toDateValue(parts);
  return currentValue >= toDateValue(weekend.start) && currentValue <= toDateValue(weekend.end);
}

function startOfWeek(parts) {
  const mondayIndex = weekdayToMondayIndex(getZonedWeekdayIndex(parts));
  return addCalendarDays(parts, 1 - mondayIndex);
}

function resolveWeekendRange(parts) {
  const weekStart = startOfWeek(parts);
  return {
    start: addCalendarDays(weekStart, 5),
    end: addCalendarDays(weekStart, 6),
  };
}

function addCalendarMonths(parts, offsetMonths) {
  const base = new Date(Date.UTC(parts.year, parts.month - 1 + offsetMonths, 1));
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: 1,
  };
}

function toDateValue(parts) {
  return (parts.year * 10000) + (parts.month * 100) + parts.day;
}

function extractAppointmentQueryTemporalContext(text, {
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const zonedNow = getZonedDateParts(now, timezone);
  if (!zonedNow) {
    return null;
  }

  const weekdayMatch = extractWeekdayMatch(raw, zonedNow);
  if (weekdayMatch) {
    return {
      filter: buildDateFilter(weekdayMatch),
      label: canonicalizeWeekdayLabel(weekdayMatch.matchedText),
    };
  }

  if (/(后天)/i.test(raw)) {
    return { filter: "day_after_tomorrow", label: "后天" };
  }
  if (/(明天|tomorrow)/i.test(raw)) {
    return { filter: "tomorrow", label: "明天" };
  }
  if (/(今天|today)/i.test(raw)) {
    return { filter: "today", label: "今天" };
  }
  if (/(下周|下星期|下礼拜|next\s+week)/i.test(raw)) {
    return { filter: "next_week", label: "下周" };
  }
  if (/(本周|这周|本星期|这星期|this\s+week)/i.test(raw)) {
    return { filter: "this_week", label: "本周" };
  }
  if (/(下月|下个月|next\s+month)/i.test(raw)) {
    return { filter: "next_month", label: "下月" };
  }
  if (/(本月|这月|这个月|this\s+month)/i.test(raw)) {
    return { filter: "this_month", label: "本月" };
  }
  if (/(下周末|下星期天?|下礼拜天?)/i.test(raw)) {
    return { filter: "next_weekend", label: "下周末" };
  }
  if (/(周末|这个周末|这周末|本周末)/i.test(raw)) {
    return { filter: "this_weekend", label: "周末" };
  }
  return null;
}

function buildDateFilter(parts) {
  const year = String(parts?.year || "").trim();
  const month = String(parts?.month || "").padStart(2, "0");
  const day = String(parts?.day || "").padStart(2, "0");
  return `date:${year}-${month}-${day}`;
}

function parseDateFilter(value) {
  const match = String(value || "").match(/^date:(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  return {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10),
  };
}

function canonicalizeWeekdayLabel(text) {
  return String(text || "")
    .replace(/^下星期/, "下周")
    .replace(/^下礼拜/, "下周")
    .replace(/^星期/, "周")
    .replace(/^礼拜/, "周");
}

function looksLikeAppointmentScheduleOverview(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) {
    return false;
  }
  return /^(?:请问|帮我看下|帮我看看|帮我查下|帮我查查看|查下|查查看|看看|查看|列出|统计|数一下)?(?:.+)?(?:下周[一二三四五六日天]|下星期[一二三四五六日天]|下礼拜[一二三四五六日天]|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|今天|明天|后天|本周|这周|本星期|这星期|下周|下星期|下礼拜|本月|这月|这个月|下月|下个月)(?:.+)?(?:安排|日程|排期|档期)(?:怎么样|如何|咋样)?$/i.test(normalized);
}

function shouldSendReminder(appointment, now) {
  if (!appointment || appointment.status !== "pending" || appointment.reminderSentAt) {
    return false;
  }
  const appointmentAt = new Date(appointment.appointmentAt);
  const reminderAt = new Date(appointment.reminderAt);
  if (!Number.isFinite(appointmentAt.getTime()) || !Number.isFinite(reminderAt.getTime())) {
    return false;
  }
  if (appointment.kind === "personal_event") {
    return reminderAt.getTime() <= now.getTime()
      && reminderAt.getTime() > (now.getTime() - PERSONAL_REMINDER_LATE_WINDOW_MS);
  }
  return reminderAt.getTime() <= now.getTime()
    && appointmentAt.getTime() > (now.getTime() - REMINDER_GRACE_WINDOW_MS);
}

function resolveAppointmentTimezone(runtime) {
  return String(runtime?.config?.appointmentReminderTimezone || "").trim() || DEFAULT_TIMEZONE;
}

function buildChatScopeKey(runtime, normalized) {
  return runtime.sessionStore.buildChatScopeKey({
    workspaceId: normalized?.workspaceId || runtime?.config?.defaultWorkspaceId || "default",
    chatId: normalized?.chatId || "",
  });
}

function resolveActionChatScopeKey(runtime, action, normalized) {
  return String(action?.chatScopeKey || "").trim() || buildChatScopeKey(runtime, normalized);
}

function ensureScopeDefaults(scope, normalized) {
  const next = cloneScope(scope);
  next.chatId = next.chatId || normalizeValue(normalized?.chatId);
  next.workspaceId = next.workspaceId || normalizeValue(normalized?.workspaceId);
  next.appointmentsById = next.appointmentsById || {};
  next.customerProfilesByName = next.customerProfilesByName || {};
  next.pendingDraftsById = next.pendingDraftsById || {};
  next.sequenceByDate = next.sequenceByDate || {};
  return next;
}

function cloneScope(scope) {
  return {
    chatId: normalizeValue(scope?.chatId),
    workspaceId: normalizeValue(scope?.workspaceId),
    appointmentsById: cloneObjectMap(scope?.appointmentsById),
    customerProfilesByName: cloneObjectMap(scope?.customerProfilesByName),
    pendingDraftsById: cloneObjectMap(scope?.pendingDraftsById),
    sequenceByDate: { ...(scope?.sequenceByDate || {}) },
  };
}

function createAppointmentDraft(parsed, normalized) {
  return {
    draftId: buildDraftId(),
    chatId: normalizeValue(normalized.chatId),
    workspaceId: normalizeValue(normalized.workspaceId),
    customerName: parsed.customerName,
    normalizedCustomerName: parsed.normalizedCustomerName,
    serviceName: parsed.serviceName,
    appointmentAt: parsed.appointmentAt.toISOString(),
    reminderAt: parsed.reminderAt.toISOString(),
    note: parsed.note,
    sourceText: parsed.sourceText,
    sourceMessageId: normalizeValue(normalized.messageId),
    sourceSenderId: normalizeValue(normalized.senderId),
    createdAt: new Date().toISOString(),
  };
}

function createPersonalAppointment(runtime, chatScopeKey, parsed, normalized, { now = new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const appointmentId = generateAppointmentId(scope, parsed.appointmentAt.toISOString(), timezone);
  const appointment = {
    id: appointmentId,
    chatId: normalizeValue(normalized.chatId),
    workspaceId: normalizeValue(normalized.workspaceId),
    customerName: parsed.customerName,
    normalizedCustomerName: parsed.normalizedCustomerName,
    serviceName: parsed.serviceName,
    appointmentAt: parsed.appointmentAt.toISOString(),
    reminderAt: parsed.reminderAt.toISOString(),
    note: parsed.note,
    status: "pending",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    confirmedAt: now.toISOString(),
    reminderSentAt: "",
    sourceMessageId: normalizeValue(normalized.messageId),
    sourceSenderId: normalizeValue(normalized.senderId),
    kind: parsed.kind || "personal_event",
    title: parsed.title || parsed.serviceName,
  };

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, (current) => {
    const next = ensureScopeDefaults(current, normalized);
    const dateKey = buildSequenceDateKey(appointment.appointmentAt, timezone);
    next.sequenceByDate[dateKey] = (next.sequenceByDate[dateKey] || 0) + 1;
    next.appointmentsById[appointmentId] = appointment;
    const profileKey = appointment.normalizedCustomerName;
    const currentProfile = next.customerProfilesByName[profileKey] || {
      displayName: appointment.customerName,
      normalizedName: profileKey,
      profileNote: "个人事项",
      historyAppointmentIds: [],
      updatedAt: "",
    };
    currentProfile.displayName = currentProfile.displayName || appointment.customerName;
    currentProfile.normalizedName = profileKey;
    currentProfile.profileNote = currentProfile.profileNote || "个人事项";
    currentProfile.historyAppointmentIds = dedupeArray([
      appointmentId,
      ...(currentProfile.historyAppointmentIds || []),
    ]);
    currentProfile.updatedAt = now.toISOString();
    next.customerProfilesByName[profileKey] = currentProfile;
    return next;
  });

  return {
    ok: true,
    appointment,
    text: [
      `已创建个人事项：${appointmentId}`,
      `事项：${appointment.title || appointment.serviceName}`,
      `时间：${formatAppointmentDateTime(appointment.appointmentAt, timezone)}`,
      `提醒：${formatReminderDateTime(appointment.reminderAt, timezone, now)}`,
    ].join("\n"),
  };
}

function buildDraftId() {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateAppointmentId(scope, appointmentAtIso, timezone = DEFAULT_TIMEZONE) {
  const dateKey = buildSequenceDateKey(appointmentAtIso, timezone);
  const sequence = Number(scope?.sequenceByDate?.[dateKey] || 0) + 1;
  return `${dateKey}-${String(sequence).padStart(3, "0")}`;
}

function buildSequenceDateKey(value, timezone = DEFAULT_TIMEZONE) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "000000";
  }
  const parts = getZonedDateParts(date, timezone);
  if (!parts) {
    const year = String(date.getUTCFullYear()).slice(-2);
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }
  const year = String(parts.year).slice(-2);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}${month}${day}`;
}

function computeReminderTime(appointmentAt, now, timezone) {
  const appointmentParts = getZonedDateParts(appointmentAt, timezone);
  if (!appointmentParts) {
    return new Date(appointmentAt.getTime() - ONE_HOUR_MS);
  }
  const reminderAtNine = buildDateInTimezone({
    year: appointmentParts.year,
    month: appointmentParts.month,
    day: appointmentParts.day,
    hour: 9,
    minute: 0,
  }, timezone);
  if (!reminderAtNine) {
    return new Date(appointmentAt.getTime() - ONE_HOUR_MS);
  }
  return reminderAtNine.getTime() <= now.getTime()
    ? new Date(appointmentAt.getTime() - ONE_HOUR_MS)
    : reminderAtNine;
}

function parsePersonalAppointmentDateTime(text, { now = new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  const source = String(text || "").trim();
  const relativeResult = parseRelativePersonalAppointmentDateTime(source, { now });
  if (relativeResult) {
    return relativeResult;
  }
  const fuzzyResult = parseFuzzyPersonalAppointmentDateTime(source, { now, timezone });
  if (fuzzyResult) {
    return fuzzyResult;
  }
  const appointmentIndex = source.indexOf("预约");
  const reminderIndex = findReminderKeywordIndex(source);
  const segmentStart = appointmentIndex >= 0 ? appointmentIndex + "预约".length : 0;
  const segmentEnd = reminderIndex >= 0 && reminderIndex > segmentStart ? reminderIndex : source.length;
  const appointmentSegment = source.slice(segmentStart, segmentEnd).trim() || source;
  const timeMatch = extractTimeMatch(appointmentSegment)
    || (appointmentIndex >= 0 ? null : extractTimeMatch(source));
  if (!timeMatch) {
    return null;
  }

  const dateMatch = extractDateMatch(appointmentSegment, now, timezone)
    || extractDateMatch(source, now, timezone);
  const targetDate = dateMatch || getZonedDateParts(now, timezone);
  if (!targetDate) {
    return {
      ok: false,
      message: "这条个人事项的日期没有解析成功。",
    };
  }

  const hasExplicitMeridiem = /(凌晨|早上|上午|中午|下午|傍晚|晚上)/.test(timeMatch.matchedText || "");
  const shouldPreferEvening = !hasExplicitMeridiem && /(今晚|晚上|傍晚)/.test(source);
  const hour = shouldPreferEvening && timeMatch.hour < 12
    ? timeMatch.hour + 12
    : timeMatch.hour;
  let date = buildDateInTimezone({
    year: targetDate.year,
    month: targetDate.month,
    day: targetDate.day,
    hour,
    minute: timeMatch.minute,
  }, timezone);
  if (!date) {
    return {
      ok: false,
      message: "这条个人事项的时间没有解析成功，请换成“今晚7点”或“2026-05-25 19:00”。",
    };
  }

  if (!dateMatch && date.getTime() <= now.getTime()) {
    const tomorrow = addCalendarDays(targetDate, 1);
    date = buildDateInTimezone({
      year: tomorrow.year,
      month: tomorrow.month,
      day: tomorrow.day,
      hour,
      minute: timeMatch.minute,
    }, timezone);
  }

  return {
    ok: true,
    date,
    matchedDateText: dateMatch?.matchedText || "",
    matchedTimeText: timeMatch.matchedText,
    matchedText: [dateMatch?.matchedText || "", timeMatch.matchedText].filter(Boolean).join(" "),
  };
}

function parsePersonalReminderDateTime(text, appointmentAt, { now = new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  const source = String(text || "").trim();
  const reminderIndex = findReminderKeywordIndex(source);
  if (reminderIndex < 0) {
    return null;
  }
  const relativeReminderAt = parseRelativeReminderOffset(source, appointmentAt);
  if (relativeReminderAt) {
    return relativeReminderAt;
  }
  const beforeReminder = source.slice(0, reminderIndex);
  const timeMatch = extractLastTimeMatch(beforeReminder);
  if (!timeMatch) {
    return null;
  }
  const appointmentParts = getZonedDateParts(appointmentAt, timezone);
  if (!appointmentParts) {
    return null;
  }
  const dateMatch = extractDateMatch(beforeReminder, now, timezone);
  const targetDate = dateMatch || appointmentParts;
  const hasExplicitMeridiem = /(凌晨|早上|上午|中午|下午|傍晚|晚上)/.test(timeMatch.matchedText || "");
  const shouldPreferEvening = !hasExplicitMeridiem && /(今晚|晚上|傍晚)/.test(source);
  const hour = shouldPreferEvening && timeMatch.hour < 12
    ? timeMatch.hour + 12
    : timeMatch.hour;
  const reminderAt = buildDateInTimezone({
    year: targetDate.year,
    month: targetDate.month,
    day: targetDate.day,
    hour,
    minute: timeMatch.minute,
  }, timezone);
  if (!reminderAt || reminderAt.getTime() > appointmentAt.getTime()) {
    return null;
  }
  return reminderAt;
}

function parseRelativeReminderOffset(text, appointmentAt) {
  const source = String(text || "").trim();
  const match = source.match(/提前\s*(半小时|\d+|[零〇一二三四五六七八九十两]+)\s*(分钟|分|小时)?\s*提醒(?:一下我|我)?/);
  if (!match) {
    return null;
  }
  const amountText = String(match[1] || "").trim();
  const amount = amountText === "半小时" ? 30 : parseFlexibleNumber(amountText);
  if (!Number.isInteger(amount) || amount <= 0) {
    return null;
  }
  const unitText = amountText === "半小时"
    ? "分钟"
    : String(match[2] || "");
  const deltaMs = unitText.includes("小时")
    ? amount * ONE_HOUR_MS
    : amount * ONE_MINUTE_MS;
  const reminderAt = new Date(appointmentAt.getTime() - deltaMs);
  if (!Number.isFinite(reminderAt.getTime()) || reminderAt.getTime() > appointmentAt.getTime()) {
    return null;
  }
  return reminderAt;
}

function parseRelativePersonalAppointmentDateTime(text, { now = new Date() } = {}) {
  const source = String(text || "").trim();
  return parseRelativeDateTime(source, {
    now,
    errorMessage: "这条个人事项的相对时间没有解析成功，请换成“过5分钟提醒我喝水”或“1小时后提醒我”。",
  });
}

function parseRelativeDateTime(text, { now = new Date(), errorMessage = "" } = {}) {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }
  const prefixedMatch = source.match(/(?:^|[，,。；;、\s])(?:再过|过)\s*(半小时|(\d+|[零〇一二三四五六七八九十两]+)\s*个?\s*(分钟|分|小时)?)(?:\s*(?:后|以后))?/);
  const suffixedMatch = source.match(/(?:^|[，,。；;、\s])(半小时|(\d+|[零〇一二三四五六七八九十两]+)\s*个?\s*(分钟|分|小时))\s*(?:后|以后)/);
  const match = prefixedMatch || suffixedMatch;
  if (!match) {
    return null;
  }
  const amountText = String(match[1] || "").trim();
  const amount = amountText === "半小时" ? 30 : parseFlexibleNumber(match[2] || amountText);
  if (!Number.isInteger(amount) || amount <= 0) {
    return {
      ok: false,
      message: errorMessage || "相对时间没有解析成功。",
    };
  }
  const unitText = amountText === "半小时"
    ? "分钟"
    : String(match[3] || "");
  const deltaMs = unitText.includes("小时")
    ? amount * ONE_HOUR_MS
    : amount * ONE_MINUTE_MS;
  return {
    ok: true,
    date: new Date(now.getTime() + deltaMs),
    matchedDateText: "",
    matchedTimeText: "",
    matchedText: match[0].trim(),
    isRelative: true,
  };
}

function parseFuzzyPersonalAppointmentDateTime(text, { now = new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }
  const zonedNow = getZonedDateParts(now, timezone);
  if (!zonedNow) {
    return null;
  }

  if (/(一会儿|一会|待会儿|待会)/.test(source)) {
    return {
      ok: true,
      date: new Date(now.getTime() + 15 * ONE_MINUTE_MS),
      matchedDateText: "",
      matchedTimeText: "",
      matchedText: source.match(/一会儿|一会|待会儿|待会/)?.[0] || "",
      isRelative: true,
    };
  }

  if (/明早/.test(source)) {
    const date = buildDateInTimezone({
      year: addCalendarDays(zonedNow, 1).year,
      month: addCalendarDays(zonedNow, 1).month,
      day: addCalendarDays(zonedNow, 1).day,
      hour: 8,
      minute: 0,
    }, timezone);
    if (!date) {
      return null;
    }
    return {
      ok: true,
      date,
      matchedDateText: "明早",
      matchedTimeText: "",
      matchedText: "明早",
    };
  }

  if (/周末/.test(source)) {
    const weekend = resolveUpcomingWeekendDate(zonedNow);
    const date = buildDateInTimezone({
      year: weekend.year,
      month: weekend.month,
      day: weekend.day,
      hour: 9,
      minute: 0,
    }, timezone);
    if (!date) {
      return null;
    }
    return {
      ok: true,
      date,
      matchedDateText: "周末",
      matchedTimeText: "",
      matchedText: "周末",
    };
  }

  if (/下周[一二三四五六日天]/.test(source)) {
    const weekdayMatch = extractNextWeekdayMatch(source, zonedNow);
    if (!weekdayMatch) {
      return null;
    }
    const date = buildDateInTimezone({
      year: weekdayMatch.year,
      month: weekdayMatch.month,
      day: weekdayMatch.day,
      hour: 9,
      minute: 0,
    }, timezone);
    if (!date) {
      return null;
    }
    return {
      ok: true,
      date,
      matchedDateText: weekdayMatch.matchedText,
      matchedTimeText: "",
      matchedText: weekdayMatch.matchedText,
    };
  }

  return null;
}

function resolveUpcomingWeekendDate(zonedNow) {
  const currentDay = weekdayToMondayIndex(getZonedWeekdayIndex(zonedNow));
  const offset = currentDay <= 6 ? (6 - currentDay) : 6;
  return addCalendarDays(zonedNow, offset);
}

function extractNextWeekdayMatch(text, zonedNow) {
  const match = String(text || "").match(/下周([一二三四五六日天])/);
  if (!match) {
    return null;
  }
  const targetDay = weekdayCharToMondayIndex(match[1]);
  if (!Number.isInteger(targetDay)) {
    return null;
  }
  const currentDay = weekdayToMondayIndex(getZonedWeekdayIndex(zonedNow));
  const offset = (7 - currentDay) + targetDay;
  const target = addCalendarDays(zonedNow, offset);
  return {
    matchedText: match[0],
    year: target.year,
    month: target.month,
    day: target.day,
  };
}

function buildPersonalAppointmentTitle(sourceText, appointmentResult) {
  const source = String(sourceText || "").trim();
  const appointmentIndex = source.indexOf("预约");
  const reminderIndex = findReminderKeywordIndex(source);
  if (appointmentIndex < 0 && reminderIndex >= 0) {
    const reminderMatch = source.match(/提醒一下我|提醒我|提醒/);
    const afterReminder = reminderMatch
      ? source.slice(reminderMatch.index + reminderMatch[0].length).trim()
      : "";
    if (afterReminder) {
      return cleanPersonalAppointmentTitle(afterReminder);
    }
  }
  const beforeAppointment = appointmentIndex >= 0
    ? source.slice(0, appointmentIndex).trim()
    : "";
  if (beforeAppointment) {
    return cleanPersonalAppointmentTitle(beforeAppointment);
  }

  const segmentStart = appointmentIndex >= 0 ? appointmentIndex + "预约".length : 0;
  const segmentEnd = reminderIndex >= 0 && reminderIndex > segmentStart ? reminderIndex : source.length;
  const afterAppointment = source.slice(segmentStart, segmentEnd).trim();
  const stripped = stripDetectedDateTimeText(afterAppointment, appointmentResult);
  return cleanPersonalAppointmentTitle(stripped) || "个人事项";
}

function cleanPersonalAppointmentTitle(text) {
  return String(text || "")
    .replace(/^(?:今天|明天|后天|今晚)?\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(?:\d{1,2}[:：]\d{1,2}|[0-9零〇一二三四五六七八九十两]{1,3}\s*点\s*(?:(?:半|一刻|三刻|[0-9零〇一二三四五六七八九十两]{1,3})\s*分?)?)\s*/g, "")
    .replace(/^(?:今天|明天|后天|今晚)\s*/g, "")
    .replace(/(?:，|,)?\s*提前\s*(?:半小时|[0-9零〇一二三四五六七八九十两]+)\s*(?:分钟|分|小时)?\s*$/g, "")
    .replace(/(?:，|,)?\s*(?:在|于)?\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(?:\d{1,2}[:：]\d{1,2}|[0-9零〇一二三四五六七八九十两]{1,3}\s*点\s*(?:(?:半|一刻|三刻|[0-9零〇一二三四五六七八九十两]{1,3})\s*分?)?)\s*(?:发)?\s*$/g, "")
    .replace(/(?:在|于)?\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(?:\d{1,2}[:：]\d{1,2}|[0-9零〇一二三四五六七八九十两]{1,3}\s*点\s*(?:(?:半|一刻|三刻|[0-9零〇一二三四五六七八九十两]{1,3})\s*分?)?)\s*(?:发)?提醒(?:一下我|我)?\s*$/g, "")
    .replace(/(?:，|,|。|；|;|：|:)?\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(?:\d{1,2}[:：]\d{1,2}|[0-9零〇一二三四五六七八九十两]{1,3}\s*点\s*(?:(?:半|一刻|三刻|[0-9零〇一二三四五六七八九十两]{1,3})\s*分?)?)\s*$/g, "")
    .replace(/(?:，|,|。|；|;|：|:)\s*$/g, "")
    .replace(/^(请|帮我|麻烦|记得|到时候)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findReminderKeywordIndex(text) {
  const source = String(text || "");
  const matches = Array.from(source.matchAll(/提醒一下我|提醒我|提醒/g));
  if (!matches.length) {
    return -1;
  }
  return matches[matches.length - 1].index;
}

function hasPersonalReminderIntent(text) {
  const source = String(text || "").trim();
  if (!source) {
    return false;
  }
  return /(提醒我|提醒一下我|提醒|发提醒给我|发个提醒给我|给我发提醒|半小时后提醒我|提前半小时提醒我)/.test(source);
}

function looksLikeCustomerAppointmentWithReminder(text) {
  const source = String(text || "").trim();
  const appointmentIndex = source.indexOf("预约");
  if (appointmentIndex <= 0) {
    return false;
  }
  const prefix = cleanCustomerName(source.slice(0, appointmentIndex));
  if (!prefix || prefix.length > 20) {
    return false;
  }
  if (/(我|我们|给我|帮我|把|带|拿|买|去|回家|工作室|桌面|记得|顺便)/.test(prefix)) {
    return false;
  }
  return /^[A-Za-z0-9_\-\u4e00-\u9fa5·]+$/.test(prefix);
}

function parseAppointmentDateTime(text, { now = new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  const sourceText = String(text || "").trim();
  const relativeResult = parseRelativeDateTime(sourceText, {
    now,
    errorMessage: "这条预约的相对时间没有解析成功，请换成“1小时后”或“过30分钟”。",
  });
  if (relativeResult) {
    return relativeResult;
  }

  const dateMatch = extractDateMatch(sourceText, now, timezone);
  const timeMatch = extractTimeMatch(sourceText);
  if (!dateMatch || !timeMatch) {
    return null;
  }

  const date = buildDateInTimezone({
    year: dateMatch.year,
    month: dateMatch.month,
    day: dateMatch.day,
    hour: timeMatch.hour,
    minute: timeMatch.minute,
  }, timezone);
  if (!date) {
    return {
      ok: false,
      message: "这条预约的时间没有解析成功，请换成“明天下午三点”或“5月21号 15:00”。",
    };
  }

  return {
    ok: true,
    date,
    matchedDateText: dateMatch.matchedText,
    matchedTimeText: timeMatch.matchedText,
    matchedText: `${dateMatch.matchedText} ${timeMatch.matchedText}`.trim(),
  };
}

function stripDetectedDateTimeText(text, dateTimeResult) {
  let next = String(text || "");
  const dateText = String(dateTimeResult?.matchedDateText || "").trim();
  const timeText = String(dateTimeResult?.matchedTimeText || "").trim();
  const combinedText = String(dateTimeResult?.matchedText || "").trim();

  if (combinedText) {
    next = next.replace(combinedText, " ");
  }
  if (dateText) {
    next = next.replace(dateText, " ");
  }
  if (timeText) {
    next = next.replace(timeText, " ");
  }
  return next;
}

function removeDateLikeFragments(text) {
  return String(text || "")
    .replace(/(?:再过|过)?\s*(?:半小时|(?:\d+|[零〇一二三四五六七八九十两]+)\s*个?\s*(?:分钟|分|小时))\s*(?:后|以后)?/g, " ")
    .replace(/(?:\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*[日号]?)/g, " ")
    .replace(/(?:\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)/g, " ")
    .replace(/(?:\d{1,2}\s*[日号])/g, " ")
    .replace(/(?:今天|明天|后天|下周[一二三四五六日天]|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天])/g, " ")
    .replace(/(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(?:\d{1,2}[:：]\d{1,2}|[0-9零〇一二三四五六七八九十两]{1,3}\s*点\s*(?:(?:半|一刻|三刻|[0-9零〇一二三四五六七八九十两]{1,3})\s*分?)?)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDateMatch(text, now, timezone) {
  const zonedNow = getZonedDateParts(now, timezone);
  if (!zonedNow) {
    return null;
  }

  const weekdayMatch = extractWeekdayMatch(text, zonedNow);
  if (weekdayMatch) {
    return weekdayMatch;
  }

  const relativeMatch = text.match(/(?:\u4eca\u5929|\u660e\u5929|\u540e\u5929)/);
  if (relativeMatch) {
    const offset = relativeMatch[0] === '\u660e\u5929'
      ? 1
      : relativeMatch[0] === '\u540e\u5929'
        ? 2
        : 0;
    const target = addCalendarDays(zonedNow, offset);
    return {
      matchedText: relativeMatch[0],
      year: target.year,
      month: target.month,
      day: target.day,
    };
  }

  const fullMatch = text.match(/(\d{4})\s*[-/\u5e74]\s*(\d{1,2})\s*[-/\u6708]\s*(\d{1,2})\s*[\u65e5\u53f7]?/);
  if (fullMatch) {
    return {
      matchedText: fullMatch[0],
      year: Number.parseInt(fullMatch[1], 10),
      month: Number.parseInt(fullMatch[2], 10),
      day: Number.parseInt(fullMatch[3], 10),
    };
  }

  const monthDayMatch = text.match(/(\d{1,2})\s*\u6708\s*(\d{1,2})\s*[\u65e5\u53f7]?/);
  if (monthDayMatch) {
    return {
      matchedText: monthDayMatch[0],
      year: zonedNow.year,
      month: Number.parseInt(monthDayMatch[1], 10),
      day: Number.parseInt(monthDayMatch[2], 10),
    };
  }

  const dayOnlyMatch = text.match(/(\d{1,2})\s*[\u65e5\u53f7]/);
  if (dayOnlyMatch) {
    return {
      matchedText: dayOnlyMatch[0],
      year: zonedNow.year,
      month: zonedNow.month,
      day: Number.parseInt(dayOnlyMatch[1], 10),
    };
  }
  return null;
}

function extractWeekdayMatch(text, zonedNow) {
  const match = String(text || '').match(/(\u4e0b)?(?:\u5468|\u661f\u671f|\u793c\u62dc)([\u65e5\u5929\u4e00\u4e8c\u4e09\u56db\u4e94\u516d])/);
  if (!match) {
    return null;
  }

  const targetDay = weekdayCharToMondayIndex(match[2]);
  if (!Number.isInteger(targetDay)) {
    return null;
  }

  const currentDay = weekdayToMondayIndex(getZonedWeekdayIndex(zonedNow));
  const offset = match[1]
    ? (7 - currentDay) + targetDay
    : ((targetDay - currentDay + 7) % 7) || 7;
  const target = addCalendarDays(zonedNow, offset);
  return {
    matchedText: match[0],
    year: target.year,
    month: target.month,
    day: target.day,
  };
}

function getZonedWeekdayIndex(zonedParts) {
  const date = new Date(Date.UTC(zonedParts.year, zonedParts.month - 1, zonedParts.day, 12, 0, 0));
  return date.getUTCDay();
}

function weekdayToMondayIndex(weekdayIndex) {
  if (!Number.isInteger(weekdayIndex) || weekdayIndex < 0 || weekdayIndex > 6) {
    return Number.NaN;
  }
  return ((weekdayIndex + 6) % 7) + 1;
}

function weekdayCharToMondayIndex(raw) {
  const key = String(raw || '').trim();
  if (key === '\u4e00') {
    return 1;
  }
  if (key === '\u4e8c') {
    return 2;
  }
  if (key === '\u4e09') {
    return 3;
  }
  if (key === '\u56db') {
    return 4;
  }
  if (key === '\u4e94') {
    return 5;
  }
  if (key === '\u516d') {
    return 6;
  }
  if (key === '\u65e5' || key === '\u5929') {
    return 7;
  }
  return Number.NaN;
}

function extractTimeMatch(text) {
  const colonMatch = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})[:：](\d{1,2})/);
  if (colonMatch) {
    const hour = applyMeridiem(Number.parseInt(colonMatch[2], 10), colonMatch[1] || "");
    const minute = Number.parseInt(colonMatch[3], 10);
    if (isValidHourMinute(hour, minute)) {
      return {
        matchedText: colonMatch[0],
        hour,
        minute,
      };
    }
  }

  const pointMatch = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*([0-9零〇一二三四五六七八九十两]{1,3})\s*点\s*(?:(半|一刻|三刻|[0-9零〇一二三四五六七八九十两]{1,3})\s*分?)?/);
  if (pointMatch) {
    const hourValue = parseFlexibleNumber(pointMatch[2]);
    const minuteValue = parseMinuteValue(pointMatch[3] || "");
    const hour = applyMeridiem(hourValue, pointMatch[1] || "");
    if (isValidHourMinute(hour, minuteValue)) {
      return {
        matchedText: pointMatch[0],
        hour,
        minute: minuteValue,
      };
    }
  }
  return null;
}

function extractLastTimeMatch(text) {
  const source = String(text || "");
  const matches = [];
  const colonPattern = /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})[:：](\d{1,2})/g;
  const pointPattern = /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*([0-9零〇一二三四五六七八九十两]{1,3})\s*点\s*(?:(半|一刻|三刻|[0-9零〇一二三四五六七八九十两]{1,3})\s*分?)?/g;
  for (const match of source.matchAll(colonPattern)) {
    const hour = applyMeridiem(Number.parseInt(match[2], 10), match[1] || "");
    const minute = Number.parseInt(match[3], 10);
    if (isValidHourMinute(hour, minute)) {
      matches.push({ index: match.index, matchedText: match[0], hour, minute });
    }
  }
  for (const match of source.matchAll(pointPattern)) {
    const hourValue = parseFlexibleNumber(match[2]);
    const minuteValue = parseMinuteValue(match[3] || "");
    const hour = applyMeridiem(hourValue, match[1] || "");
    if (isValidHourMinute(hour, minuteValue)) {
      matches.push({ index: match.index, matchedText: match[0], hour, minute: minuteValue });
    }
  }
  matches.sort((left, right) => left.index - right.index);
  return matches[matches.length - 1] || null;
}

function applyMeridiem(rawHour, meridiem) {
  let hour = Number.parseInt(String(rawHour || ""), 10);
  if (!Number.isInteger(hour)) {
    return Number.NaN;
  }
  const normalized = String(meridiem || "").trim();
  if (["下午", "晚上", "傍晚"].includes(normalized) && hour < 12) {
    hour += 12;
  } else if (normalized === "中午" && hour < 11) {
    hour += 12;
  } else if (["凌晨", "早上", "上午"].includes(normalized) && hour === 12) {
    hour = 0;
  }
  return hour;
}

function parseMinuteValue(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return 0;
  }
  if (value === "半") {
    return 30;
  }
  if (value === "一刻") {
    return 15;
  }
  if (value === "三刻") {
    return 45;
  }
  return parseFlexibleNumber(value);
}

function parseFlexibleNumber(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return Number.NaN;
  }
  if (/^\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  const normalized = text.replace(/两/g, "二").replace(/〇/g, "零");
  if (normalized === "十") {
    return 10;
  }
  const tenIndex = normalized.indexOf("十");
  if (tenIndex >= 0) {
    const left = tenIndex === 0 ? 1 : mapChineseDigit(normalized[0]);
    const right = tenIndex === normalized.length - 1 ? 0 : mapChineseDigit(normalized[tenIndex + 1]);
    return left * 10 + right;
  }
  if (normalized.length === 1) {
    return mapChineseDigit(normalized);
  }
  return Number.NaN;
}

function mapChineseDigit(char) {
  return {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }[char] ?? Number.NaN;
}

function isValidHourMinute(hour, minute) {
  return Number.isInteger(hour)
    && Number.isInteger(minute)
    && hour >= 0
    && hour <= 23
    && minute >= 0
    && minute <= 59;
}

function buildDateInTimezone(parts, timezone) {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  const start = guess - (26 * ONE_HOUR_MS);
  const end = guess + (26 * ONE_HOUR_MS);
  for (let value = start; value <= end; value += ONE_MINUTE_MS) {
    const candidate = new Date(value);
    const zoned = getZonedDateParts(candidate, timezone);
    if (
      zoned
      && zoned.year === parts.year
      && zoned.month === parts.month
      && zoned.day === parts.day
      && zoned.hour === parts.hour
      && zoned.minute === parts.minute
    ) {
      return candidate;
    }
  }
  return null;
}

function getZonedDateParts(value, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const partMap = {};
    for (const part of formatter.formatToParts(value)) {
      if (part.type !== "literal") {
        partMap[part.type] = part.value;
      }
    }
    return {
      year: Number.parseInt(partMap.year || "", 10),
      month: Number.parseInt(partMap.month || "", 10),
      day: Number.parseInt(partMap.day || "", 10),
      hour: Number.parseInt(partMap.hour || "", 10),
      minute: Number.parseInt(partMap.minute || "", 10),
      second: Number.parseInt(partMap.second || "", 10),
    };
  } catch (error) {
    logger.warn("invalid appointment timezone; falling back to default", {
      timezone,
      error,
    });
    return null;
  }
}

function addCalendarDays(parts, offsetDays) {
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
  };
}

function matchesZonedCalendarDate(appointmentAtIso, timezone, targetParts) {
  const appointmentDate = new Date(appointmentAtIso);
  const parts = getZonedDateParts(appointmentDate, timezone);
  return !!parts
    && parts.year === targetParts.year
    && parts.month === targetParts.month
    && parts.day === targetParts.day;
}

function extractNoteSegment(text) {
  const match = String(text || "").match(/(?:备注|备注是|备注为|备注[:：])\s*(.+)$/);
  if (!match) {
    return {
      baseText: String(text || "").trim(),
      note: "",
    };
  }
  return {
    baseText: String(text || "").slice(0, match.index).trim(),
    note: cleanNote(match[1]),
  };
}

function cleanCustomerName(text) {
  return normalizeValue(
    String(text || "")
      .replace(/^(请帮我|帮我|麻烦|请|记录一下|记一下|帮忙记录|帮忙记下)/, "")
      .replace(/^[，,。；;:：\s]+/g, "")
      .replace(/[，,。；;:：\s]+$/g, "")
  );
}

function cleanServiceName(text) {
  return normalizeValue(
    String(text || "")
      .replace(/^(安排|做|去做|做个|做一下|一下|一下子)\s*/, "")
      .replace(/[，,。；;:：\s]+/g, " ")
  );
}

function cleanNote(text) {
  return normalizeValue(String(text || "").replace(/[，,。；;]+$/g, ""));
}

function cleanAppointmentQueryFilterLabel(text) {
  return normalizeValue(String(text || "").replace(/\s+/g, ""));
}

function normalizeCustomerName(text) {
  return normalizeValue(text)
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeListFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "下周" || normalized === "下星期" || normalized === "下礼拜" || normalized === "next_week") {
    return "next_week";
  }
  if (normalized === "周末" || normalized === "这周末" || normalized === "本周末" || normalized === "这个周末" || normalized === "this_weekend") {
    return "this_weekend";
  }
  if (normalized === "下周末" || normalized === "下星期天" || normalized === "下礼拜天" || normalized === "next_weekend") {
    return "next_weekend";
  }
  if (normalized === "本月" || normalized === "这月" || normalized === "这个月" || normalized === "this_month") {
    return "this_month";
  }
  if (normalized === "下月" || normalized === "下个月" || normalized === "next_month") {
    return "next_month";
  }
  if (normalized === "后天" || normalized === "day_after_tomorrow") {
    return "day_after_tomorrow";
  }
  if (normalized === "明天" || normalized === "tomorrow") {
    return "tomorrow";
  }
  if (normalized === "本周" || normalized === "这周" || normalized === "本星期" || normalized === "这星期" || normalized === "this_week") {
    return "this_week";
  }
  if (normalized === "全部" || normalized === "all") {
    return "all";
  }
  if (/^date:\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }
  return "today";
}

function translateListFilter(value) {
  const targetDate = parseDateFilter(value);
  if (targetDate) {
    return formatDateFilterLabel(targetDate);
  }
  if (value === "next_week") {
    return "下周";
  }
  if (value === "this_weekend") {
    return "周末";
  }
  if (value === "next_weekend") {
    return "下周末";
  }
  if (value === "this_month") {
    return "本月";
  }
  if (value === "next_month") {
    return "下月";
  }
  if (value === "day_after_tomorrow") {
    return "后天";
  }
  if (value === "tomorrow") {
    return "明天";
  }
  if (value === "this_week") {
    return "本周";
  }
  if (value === "all") {
    return "全部";
  }
  return "今天";
}

function formatDateFilterLabel(parts) {
  const month = String(parts?.month || "").padStart(2, "0");
  const day = String(parts?.day || "").padStart(2, "0");
  return `${month}月${day}日`;
}

function buildAppointmentQueryFollowUpHint({
  remainingCount,
  label,
  customerName,
}) {
  const safeLabel = cleanAppointmentQueryFilterLabel(label || "今天");
  const safeCustomerName = cleanCustomerName(customerName || "");
  const promptText = safeCustomerName
    ? `${safeCustomerName} ${safeLabel}有哪些预约`
    : `${safeLabel}有哪些预约`;
  return `其余 ${remainingCount} 个可继续发送“${promptText}”查看。`;
}

function translateStatus(status) {
  if (status === "cancelled") {
    return "已取消";
  }
  if (status === "completed") {
    return "已完成";
  }
  return "待提醒";
}

function formatAppointmentDateTime(value, timezone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatReminderDateTime(value, timezone, now) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return String(value || "");
  }
  if (date.getTime() <= now.getTime()) {
    return `已到提醒时间（${formatAppointmentDateTime(value, timezone)}）`;
  }
  return formatAppointmentDateTime(value, timezone);
}

function pruneExpiredDrafts(scope, nowMs) {
  for (const [draftId, draft] of Object.entries(scope.pendingDraftsById || {})) {
    const createdAtMs = Date.parse(String(draft?.createdAt || ""));
    if (Number.isFinite(createdAtMs) && createdAtMs + DRAFT_RETENTION_MS < nowMs) {
      delete scope.pendingDraftsById[draftId];
    }
  }
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function dedupeArray(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function cloneObjectMap(raw) {
  const next = {};
  for (const [key, value] of Object.entries(raw || {})) {
    next[key] = value && typeof value === "object" ? { ...value } : value;
  }
  return next;
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildParseError(message) {
  return {
    intentDetected: true,
    datetimeDetected: true,
    ok: false,
    message,
  };
}

function escapeCardMarkdown(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+.!|>~])/g, "\\$1");
}

module.exports = {
  APPOINTMENT_COMMAND,
  APPOINTMENT_KIND,
  buildAppointmentHelpText,
  buildAppointmentListText,
  buildAppointmentReminderText,
  buildCustomerProfileText,
  buildDateInTimezone,
  collectAppointments,
  computeReminderTime,
  handleAppointmentCardAction,
  handleAppointmentCommand,
  handlePotentialAppointmentMessage,
  handlePotentialPersonalReminderMessage,
  parseAppointmentCommand,
  parseNaturalLanguageAppointmentQuery,
  parseNaturalLanguageAppointmentText,
  parseNaturalLanguagePersonalAppointmentText,
  runAppointmentReminderScan,
  shouldSendReminder,
  startAppointmentReminderScheduler,
};

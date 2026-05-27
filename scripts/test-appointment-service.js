#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dispatcher = require("../src/app/dispatcher");
const appointmentService = require("../src/domain/appointment/service");
const { SessionStore } = require("../src/infra/storage/session-store");
const { normalizeFeishuTextEvent } = require("../src/presentation/message/normalizers");

const ZH = {
  appoint: "\u9884\u7ea6",
  list: "\u5217\u8868",
  today: "\u4eca\u5929",
  tomorrow: "\u660e\u5929",
  customer: "\u5ba2\u6237",
  cancel: "\u53d6\u6d88",
  edit: "\u4fee\u6539",
  time: "\u65f6\u95f4",
  service: "\u9879\u76ee",
  note: "\u5907\u6ce8",
  haircolor: "\u67d3\u53d1",
  perm: "\u70eb\u53d1",
  warmTone: "\u6696\u68d5\u8272",
  coolTone: "\u51b7\u68d5\u8272",
  alice: "Alice",
  tomorrowThreePm: "\u660e\u5929\u4e0b\u5348\u4e09\u70b9",
  todayThreePm: "\u4eca\u5929\u4e0b\u5348\u4e09\u70b9",
};

async function main() {
  testCommandParsing();
  testNaturalLanguageParsing();
  testSpacedMonthDateParsing();
  testRelativeAppointmentParsing();
  testExplicitAppointmentWithoutDatetimeKeepsEntities();
  testExplicitAppointmentWithoutDatetimeKeepsNote();
  testNaturalLanguageAppointmentQueryParsing();
  await testImplicitNaturalLanguageParsing();
  testRelativeWeekdayParsing();
  await testHelpCommand();
  await testNaturalLanguageFallsThroughWithoutDatetime();
  await testPastAppointmentShowsError();
  await testPersonalReminderFastPath();
  await testPersonalReminderDirectFastPath();
  await testPersonalReminderDirectFallsThroughWithoutDatetime();
  await testCreateEditListCancelAndCustomerProfile();
  await testNaturalLanguageCountQueryIntercept();
  await testNaturalLanguageListQueryIntercept();
  await testNaturalLanguageDayAfterTomorrowCountQueryIntercept();
  await testNaturalLanguageThisWeekListQueryIntercept();
  await testNaturalLanguageNextWeekListQueryIntercept();
  await testNaturalLanguageWeekdayCountQueryIntercept();
  await testNaturalLanguageCustomerNextWeekdayListQueryIntercept();
  await testNaturalLanguageThisMonthListQueryIntercept();
  await testNaturalLanguageNextMonthCustomerCountQueryIntercept();
  await testNaturalLanguageVagueScheduleOverviewQueryIntercept();
  await testNaturalLanguageVagueAvailabilityQueryIntercept();
  await testNaturalLanguageCustomerCountQueryIntercept();
  await testNaturalLanguageCustomerThisWeekListQueryIntercept();
  await testNaturalLanguageCustomerDayAfterTomorrowListQueryIntercept();
  await testNaturalLanguageAppointmentQueryFallsThroughWithoutAppointmentKeyword();
  testSameDayAfterNineUsesOneHourReminder();
  testPersonalReminderParsesRelativeMinutes();
  testPersonalReminderParsesRelativeHalfHour();
  await testReminderScanSendsOnlyOnce();
  await testPersonalRelativeReminderScanAllowsSmallDelay();
  await testPersonalRelativeReminderScanAllowsLateDelivery();
  testPersonalReminderParsesAppointmentAndExplicitReminder();
  testPersonalReminderParsesSameDayExplicitReminder();
  testPersonalReminderParsesAdvanceOffsetReminder();
  testPersonalReminderParsesAdvanceHalfHourReminder();
  testPersonalReminderParsesTomorrowMorningReminder();
  testPersonalReminderParsesWeekdayReminder();
  testPersonalReminderParsesFuzzySoonReminder();
  testPersonalReminderParsesFuzzyWaitReminder();
  testPersonalReminderParsesFuzzyTomorrowMorningDefault();
  testPersonalReminderParsesWeekendDefault();
  testPersonalReminderParsesNextWeekdayDefault();
  await testDispatcherLetsAppointmentTextReachCodexByDefault();
  await testDispatcherCanOptIntoAppointmentIntercept();
  await testThinBridgeHandlesAppointmentCommandLocally();
  await testThinBridgeHandlesPersonalReminderLocally();
  await testThinBridgeHandlesAppointmentListCommandLocally();
  await testThinBridgeHandlesAppointmentCancelCommandLocally();
  await testDirectBridgeSendsPersonalReminderToCodex();
  await testDirectBridgeSendsCustomerAppointmentToCodex();
  await testDirectBridgeLetsNonReminderMessageReachCodex();
  testAppointmentPersistence();
  console.log("appointment fixtures ok");
}

function testCommandParsing() {
  assert.strictEqual(normalizeEvent(`/${ZH.appoint}`).command, "appointment");
  assert.strictEqual(normalizeEvent(`/${ZH.appoint} ${ZH.list} ${ZH.today}`).command, "appointment");
  assert.strictEqual(normalizeEvent("/appoint list all").command, "appointment");
  assert.strictEqual(normalizeEvent(buildFutureCreateText()).command, "message");
}

function testNaturalLanguageParsing() {
  const now = new Date("2026-05-20T08:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguageAppointmentText(buildFutureCreateText(), {
    now,
    timezone: "Asia/Shanghai",
  });

  assert.ok(parsed.ok);
  assert.strictEqual(parsed.customerName, ZH.alice);
  assert.strictEqual(parsed.serviceName, ZH.haircolor);
  assert.strictEqual(parsed.note, ZH.coolTone);
  assert.ok(parsed.appointmentAt instanceof Date);
  assert.ok(parsed.reminderAt instanceof Date);

  const personalParsed = appointmentService.parseNaturalLanguagePersonalAppointmentText("2099-05-21 19:00提醒我把电动螺丝刀带回家", {
    now,
    timezone: "Asia/Shanghai",
  });
  assert.ok(personalParsed.ok);
  assert.strictEqual(personalParsed.serviceName, "把电动螺丝刀带回家");
  assert.strictEqual(personalParsed.appointmentAt.toISOString(), "2099-05-21T11:00:00.000Z");
}

function testSpacedMonthDateParsing() {
  const parsed = appointmentService.parseNaturalLanguageAppointmentText("\u5f20\u9896\u854a\u9884\u7ea65 \u670824\u53f7\u4e0b\u5348\u4e24\u70b9\u534a\u67d3\u5934\u53d1", {
    now: new Date("2026-05-21T08:00:00+08:00"),
    timezone: "Asia/Shanghai",
  });

  assert.ok(parsed.ok);
  assert.strictEqual(parsed.customerName, "\u5f20\u9896\u854a");
  assert.strictEqual(parsed.serviceName, "\u67d3\u5934\u53d1");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-24T06:30:00.000Z");
}

function testRelativeAppointmentParsing() {
  const parsed = appointmentService.parseNaturalLanguageAppointmentText("一个小时以后，陈显预约剪头发", {
    now: new Date("2026-05-26T11:51:21+08:00"),
    timezone: "Asia/Shanghai",
  });

  assert.ok(parsed.ok);
  assert.strictEqual(parsed.customerName, "陈显");
  assert.strictEqual(parsed.serviceName, "剪头发");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-26T04:51:21.000Z");

  const afterKeyword = appointmentService.parseNaturalLanguageAppointmentText("陈显预约一个小时以后剪头发", {
    now: new Date("2026-05-26T11:51:21+08:00"),
    timezone: "Asia/Shanghai",
  });

  assert.ok(afterKeyword.ok);
  assert.strictEqual(afterKeyword.customerName, "陈显");
  assert.strictEqual(afterKeyword.serviceName, "剪头发");
  assert.strictEqual(afterKeyword.appointmentAt.toISOString(), "2026-05-26T04:51:21.000Z");
}

function testExplicitAppointmentWithoutDatetimeKeepsEntities() {
  const parsed = appointmentService.parseNaturalLanguageAppointmentText("\u5f20\u4e09\u9884\u7ea6\u67d3\u53d1", {
    now: new Date("2026-05-21T08:00:00+08:00"),
    timezone: "Asia/Shanghai",
  });

  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.datetimeDetected, false);
  assert.strictEqual(parsed.ok, false);
  assert.strictEqual(parsed.customerName, "\u5f20\u4e09");
  assert.strictEqual(parsed.serviceName, "\u67d3\u53d1");
}

function testExplicitAppointmentWithoutDatetimeKeepsNote() {
  const parsed = appointmentService.parseNaturalLanguageAppointmentText("Alice\u9884\u7ea6\u70eb\u53d1\uff0c\u5907\u6ce8\u60f3\u8981\u81ea\u7136\u5377", {
    now: new Date("2026-05-21T08:00:00+08:00"),
    timezone: "Asia/Shanghai",
  });

  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.datetimeDetected, false);
  assert.strictEqual(parsed.ok, false);
  assert.strictEqual(parsed.customerName, "Alice");
  assert.strictEqual(parsed.serviceName, "\u70eb\u53d1");
  assert.strictEqual(parsed.note, "\u60f3\u8981\u81ea\u7136\u5377");
}

function testNaturalLanguageAppointmentQueryParsing() {
  const queryOptions = {
    now: new Date("2026-05-20T08:00:00+08:00"),
    timezone: "Asia/Shanghai",
  };
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("\u660e\u5929\u6709\u51e0\u4e2a\u9884\u7ea6", queryOptions),
    { mode: "count", filter: "tomorrow", label: "明天", customerName: "" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("\u540e\u5929\u6709\u51e0\u4e2a\u9884\u7ea6", queryOptions),
    { mode: "count", filter: "day_after_tomorrow", label: "后天", customerName: "" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("Alice\u660e\u5929\u6709\u51e0\u4e2a\u9884\u7ea6", queryOptions),
    { mode: "count", filter: "tomorrow", label: "明天", customerName: "Alice" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("\u5e2e\u6211\u770b\u770b Alice \u672c\u5468\u6709\u54ea\u4e9b\u9884\u7ea6", queryOptions),
    { mode: "list", filter: "this_week", label: "本周", customerName: "Alice" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("Alice \u7684\u540e\u5929\u9884\u7ea6\u6709\u54ea\u4e9b", queryOptions),
    { mode: "list", filter: "day_after_tomorrow", label: "后天", customerName: "Alice" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("\u4eca\u5929\u9884\u7ea6\u5217\u8868", queryOptions),
    { mode: "list", filter: "today", label: "今天", customerName: "" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("\u672c\u5468\u9884\u7ea6\u5217\u8868", queryOptions),
    { mode: "list", filter: "this_week", label: "本周", customerName: "" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("下周安排", queryOptions),
    { mode: "list", filter: "next_week", label: "下周", customerName: "" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("周二还有吗", queryOptions),
    { mode: "count", filter: "date:2026-05-26", label: "周二", customerName: "" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("Alice 下周二有哪些预约", queryOptions),
    { mode: "list", filter: "date:2026-05-26", label: "下周二", customerName: "Alice" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("本月预约列表", queryOptions),
    { mode: "list", filter: "this_month", label: "本月", customerName: "" }
  );
  assert.deepStrictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("Alice 下月忙不忙", queryOptions),
    { mode: "count", filter: "next_month", label: "下月", customerName: "Alice" }
  );
  assert.strictEqual(
    appointmentService.parseNaturalLanguageAppointmentQuery("\u660e\u5929\u8fd8\u6709\u51e0\u4e2a\u95ee\u9898", queryOptions),
    null
  );
}

async function testImplicitNaturalLanguageParsing() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-implicit-natural-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const normalized = normalizeEvent("\u5f20\u4e09\u660e\u5929\u4e0b\u5348\u4e09\u70b9\u67d3\u53d1");

  const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);

  assert.strictEqual(result, null);
  assert.strictEqual(sent.cards.length, 1);

  const chatScopeKey = runtime.sessionStore.buildChatScopeKey({
    workspaceId: "default",
    chatId: normalized.chatId,
  });
  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const draftId = Object.keys(scope.pendingDraftsById)[0];
  assert.ok(draftId);

  await appointmentService.handleAppointmentCardAction(runtime, {
    kind: "appointment",
    action: "confirm_create",
    draftId,
    chatScopeKey,
  }, normalized);

  const confirmedScope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const appointmentId = Object.keys(confirmedScope.appointmentsById)[0];
  assert.ok(appointmentId);
  assert.strictEqual(confirmedScope.appointmentsById[appointmentId].customerName, "\u5f20\u4e09");
  assert.strictEqual(confirmedScope.appointmentsById[appointmentId].serviceName, "\u67d3\u53d1");
}

function testRelativeWeekdayParsing() {
  const parsed = appointmentService.parseNaturalLanguageAppointmentText("\u674e\u56db预约下周二上午10点剪发", {
    now: new Date("2026-05-20T08:00:00+08:00"),
    timezone: "Asia/Shanghai",
  });

  assert.ok(parsed.ok);
  assert.strictEqual(parsed.customerName, "\u674e\u56db");
  assert.strictEqual(parsed.serviceName, "\u526a\u53d1");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-26T02:00:00.000Z");
}

async function testHelpCommand() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-help-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  await appointmentService.handleAppointmentCommand(runtime, normalizeEvent(`/${ZH.appoint}`));
  assert.strictEqual(sent.info.length, 1);
  assert.ok(sent.info[0].text.includes("/appoint"));
}

async function testNaturalLanguageFallsThroughWithoutDatetime() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-fallthrough-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const normalized = normalizeEvent(`${ZH.alice}${ZH.appoint}${ZH.haircolor}`);

  const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);

  assert.strictEqual(result, normalized);
  assert.strictEqual(sent.cards.length, 0);
  assert.strictEqual(sent.info.length, 0);
}

async function testPastAppointmentShowsError() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-past-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const normalized = normalizeEvent(`${ZH.alice}${ZH.appoint}2025-05-01 15:00 ${ZH.haircolor}`);

  const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);

  assert.strictEqual(result, null);
  assert.strictEqual(sent.cards.length, 0);
  assert.strictEqual(sent.info.length, 1);
  assert.strictEqual(sent.info[0].kind, "error");
}

async function testPersonalReminderFastPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-personal-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const normalized = normalizeEvent("预约2099-05-21 19:00把电动螺丝刀带回家，18:50提醒我");
  const chatScopeKey = runtime.sessionStore.buildChatScopeKey({
    workspaceId: "default",
    chatId: normalized.chatId,
  });

  const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);

  assert.strictEqual(result, null);
  assert.strictEqual(sent.cards.length, 0);
  assert.strictEqual(sent.info.length, 1);
  assert.strictEqual(sent.info[0].kind, "success");
  assert.ok(sent.info[0].text.includes("已创建个人事项"));

  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const appointmentIds = Object.keys(scope.appointmentsById);
  assert.strictEqual(appointmentIds.length, 1);
  const appointment = scope.appointmentsById[appointmentIds[0]];
  assert.strictEqual(appointment.kind, "personal_event");
  assert.strictEqual(appointment.customerName, "我");
  assert.strictEqual(appointment.serviceName, "把电动螺丝刀带回家");
  assert.strictEqual(appointment.appointmentAt, "2099-05-21T11:00:00.000Z");
  assert.strictEqual(appointment.reminderAt, "2099-05-21T10:50:00.000Z");

  const customerTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-customer-reminder-"));
  const { runtime: customerRuntime, sent: customerSent } = createRuntime(path.join(customerTempDir, "sessions.json"));
  const customerNormalized = normalizeEvent("Alice预约2099-05-21 19:00染发，18:50提醒我");

  const customerResult = await appointmentService.handlePotentialAppointmentMessage(customerRuntime, customerNormalized);

  assert.strictEqual(customerResult, null);
  assert.strictEqual(customerSent.info.length, 0);
  assert.strictEqual(customerSent.cards.length, 1);
}

async function testPersonalReminderDirectFastPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-direct-personal-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const normalized = normalizeEvent("过5分钟提醒我喝水");
  const chatScopeKey = runtime.sessionStore.buildChatScopeKey({
    workspaceId: "default",
    chatId: normalized.chatId,
  });

  await withFixedNow("2026-05-25T21:08:10+08:00", async () => {
    const result = await appointmentService.handlePotentialPersonalReminderMessage(runtime, normalized);
    assert.strictEqual(result, null);
  });

  assert.strictEqual(sent.cards.length, 0);
  assert.strictEqual(sent.info.length, 1);
  assert.strictEqual(sent.info[0].kind, "success");
  assert.ok(sent.info[0].text.includes("已创建个人事项"));

  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const appointmentIds = Object.keys(scope.appointmentsById);
  assert.strictEqual(appointmentIds.length, 1);
  const appointment = scope.appointmentsById[appointmentIds[0]];
  assert.strictEqual(appointment.kind, "personal_event");
  assert.strictEqual(appointment.title, "喝水");
  assert.strictEqual(appointment.appointmentAt, "2026-05-25T13:13:10.000Z");
  assert.strictEqual(appointment.reminderAt, "2026-05-25T13:13:10.000Z");
}

async function testPersonalReminderDirectFallsThroughWithoutDatetime() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-direct-fallthrough-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const normalized = normalizeEvent("提醒我分析一下这个问题");

  const result = await appointmentService.handlePotentialPersonalReminderMessage(runtime, normalized);

  assert.strictEqual(result, normalized);
  assert.strictEqual(sent.cards.length, 0);
  assert.strictEqual(sent.info.length, 0);
}

async function testCreateEditListCancelAndCustomerProfile() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-manage-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const normalized = normalizeEvent(buildAbsoluteCreateText());
  const chatScopeKey = runtime.sessionStore.buildChatScopeKey({
    workspaceId: "default",
    chatId: normalized.chatId,
  });

  const intercepted = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
  assert.strictEqual(intercepted, null);
  assert.strictEqual(sent.cards.length, 1);

  let scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const draftIds = Object.keys(scope.pendingDraftsById);
  assert.strictEqual(draftIds.length, 1);

  await appointmentService.handleAppointmentCardAction(runtime, {
    kind: "appointment",
    action: "confirm_create",
    draftId: draftIds[0],
    chatScopeKey,
  }, normalized);

  scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  const appointmentIds = Object.keys(scope.appointmentsById);
  assert.strictEqual(appointmentIds.length, 1);
  assert.strictEqual(Object.keys(scope.pendingDraftsById).length, 0);
  const appointmentId = appointmentIds[0];

  sent.info.length = 0;
  await appointmentService.handleAppointmentCommand(runtime, normalizeEvent(
    `/${ZH.appoint} ${ZH.edit} ${appointmentId} ${ZH.time}=2030-05-21 16:00 ${ZH.service}=${ZH.perm} ${ZH.note}=${ZH.warmTone}`
  ));
  assert.strictEqual(sent.info.length, 1);
  assert.strictEqual(sent.info[0].kind, "success");

  scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  assert.strictEqual(scope.appointmentsById[appointmentId].serviceName, ZH.perm);
  assert.strictEqual(scope.appointmentsById[appointmentId].note, ZH.warmTone);

  sent.info.length = 0;
  await appointmentService.handleAppointmentCommand(runtime, normalizeEvent(`/${ZH.appoint} ${ZH.list} all`));
  assert.strictEqual(sent.info.length, 1);
  assert.ok(sent.info[0].text.includes(appointmentId));

  sent.info.length = 0;
  await appointmentService.handleAppointmentCommand(runtime, normalizeEvent(
    `/${ZH.appoint} ${ZH.customer} ${ZH.alice} ${ZH.note} vip-client`
  ));
  assert.strictEqual(sent.info.length, 1);
  assert.strictEqual(sent.info[0].kind, "success");

  sent.info.length = 0;
  await appointmentService.handleAppointmentCommand(runtime, normalizeEvent(
    `/${ZH.appoint} ${ZH.customer} ${ZH.alice}`
  ));
  assert.strictEqual(sent.info.length, 1);
  assert.ok(sent.info[0].text.includes("vip-client"));

  sent.info.length = 0;
  await appointmentService.handleAppointmentCommand(runtime, normalizeEvent(
    `/${ZH.appoint} ${ZH.cancel} ${appointmentId}`
  ));
  assert.strictEqual(sent.info.length, 1);
  assert.strictEqual(sent.info[0].kind, "success");

  scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  assert.strictEqual(scope.appointmentsById[appointmentId].status, "cancelled");
}

async function testNaturalLanguageCountQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-count-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300521-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-21T07:00:00.000Z",
        reminderAt: "2030-05-21T01:00:00.000Z",
        note: "vip-client",
      },
      {
        id: "300521-002",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-05-21T09:00:00.000Z",
        reminderAt: "2030-05-21T03:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("\u660e\u5929\u6709\u51e0\u4e2a\u9884\u7ea6");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("\u660e\u5929\u5171\u6709 2 \u4e2a\u9884\u7ea6"));
    assert.ok(sent.info[0].text.includes("Alice"));
  });
}

async function testNaturalLanguageListQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-list-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300521-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-20T07:00:00.000Z",
        reminderAt: "2030-05-20T01:00:00.000Z",
        note: "vip-client",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("\u4eca\u5929\u6709\u54ea\u4e9b\u9884\u7ea6");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("\u4eca\u5929\u9884\u7ea6\u5217\u8868"));
    assert.ok(sent.info[0].text.includes("Alice"));
    assert.ok(sent.info[0].text.includes("vip-client"));
  });
}

async function testNaturalLanguageDayAfterTomorrowCountQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-day-after-tomorrow-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300522-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-22T07:00:00.000Z",
        reminderAt: "2030-05-22T01:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("\u540e\u5929\u6709\u51e0\u4e2a\u9884\u7ea6");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("\u540e\u5929\u5171\u6709 1 \u4e2a\u9884\u7ea6"));
  });
}

async function testNaturalLanguageThisWeekListQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-this-week-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300520-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-20T07:00:00.000Z",
        reminderAt: "2030-05-20T01:00:00.000Z",
        note: "",
      },
      {
        id: "300523-001",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-05-23T09:00:00.000Z",
        reminderAt: "2030-05-23T03:00:00.000Z",
        note: "",
      },
      {
        id: "300528-001",
        customerName: "Carol",
        serviceName: "护理",
        appointmentAt: "2030-05-28T09:00:00.000Z",
        reminderAt: "2030-05-28T03:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("\u672c\u5468\u6709\u54ea\u4e9b\u9884\u7ea6");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("\u672c\u5468\u9884\u7ea6\u5217\u8868"));
    assert.ok(sent.info[0].text.includes("Alice"));
    assert.ok(sent.info[0].text.includes("Bob"));
    assert.ok(!sent.info[0].text.includes("Carol"));
  });
}

async function testNaturalLanguageNextWeekListQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-next-week-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300526-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-27T07:00:00.000Z",
        reminderAt: "2030-05-27T01:00:00.000Z",
        note: "",
      },
      {
        id: "300529-001",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-05-29T09:00:00.000Z",
        reminderAt: "2030-05-29T03:00:00.000Z",
        note: "",
      },
      {
        id: "300603-001",
        customerName: "Carol",
        serviceName: "护理",
        appointmentAt: "2030-06-03T09:00:00.000Z",
        reminderAt: "2030-06-03T03:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("下周安排");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("下周预约列表"));
    assert.ok(sent.info[0].text.includes("Alice"));
    assert.ok(sent.info[0].text.includes("Bob"));
    assert.ok(!sent.info[0].text.includes("Carol"));
  });
}

async function testNaturalLanguageWeekdayCountQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-weekday-count-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300527-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-27T07:00:00.000Z",
        reminderAt: "2030-05-27T01:00:00.000Z",
        note: "",
      },
      {
        id: "300527-002",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-05-27T09:00:00.000Z",
        reminderAt: "2030-05-27T03:00:00.000Z",
        note: "",
      },
      {
        id: "300528-001",
        customerName: "Carol",
        serviceName: "护理",
        appointmentAt: "2030-05-28T09:00:00.000Z",
        reminderAt: "2030-05-28T03:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("下周一还有吗");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("下周一共有 2 个预约"));
    assert.ok(sent.info[0].text.includes("Alice"));
    assert.ok(sent.info[0].text.includes("Bob"));
    assert.ok(!sent.info[0].text.includes("Carol"));
  });
}

async function testNaturalLanguageCustomerNextWeekdayListQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-customer-next-weekday-list-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300528-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-28T07:00:00.000Z",
        reminderAt: "2030-05-28T01:00:00.000Z",
        note: "改薄一点",
      },
      {
        id: "300528-002",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-05-28T09:00:00.000Z",
        reminderAt: "2030-05-28T03:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("Alice 下周二有哪些预约");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("下周二客户 Alice预约列表"));
    assert.ok(sent.info[0].text.includes(ZH.haircolor));
    assert.ok(sent.info[0].text.includes("改薄一点"));
    assert.ok(!sent.info[0].text.includes("Bob"));
  });
}

async function testNaturalLanguageThisMonthListQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-this-month-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300520-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-20T07:00:00.000Z",
        reminderAt: "2030-05-20T01:00:00.000Z",
        note: "",
      },
      {
        id: "300531-001",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-05-31T09:00:00.000Z",
        reminderAt: "2030-05-31T03:00:00.000Z",
        note: "",
      },
      {
        id: "300601-001",
        customerName: "Carol",
        serviceName: "护理",
        appointmentAt: "2030-06-01T09:00:00.000Z",
        reminderAt: "2030-06-01T03:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("本月预约列表");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("本月预约列表"));
    assert.ok(sent.info[0].text.includes("Alice"));
    assert.ok(sent.info[0].text.includes("Bob"));
    assert.ok(!sent.info[0].text.includes("Carol"));
  });
}

async function testNaturalLanguageNextMonthCustomerCountQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-next-month-customer-count-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300601-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-06-01T07:00:00.000Z",
        reminderAt: "2030-06-01T01:00:00.000Z",
        note: "",
      },
      {
        id: "300615-001",
        customerName: ZH.alice,
        serviceName: ZH.perm,
        appointmentAt: "2030-06-15T09:00:00.000Z",
        reminderAt: "2030-06-15T03:00:00.000Z",
        note: "",
      },
      {
        id: "300602-001",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-06-02T10:00:00.000Z",
        reminderAt: "2030-06-02T04:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("Alice 下月忙不忙");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("下月客户 Alice共有 2 个预约"));
    assert.ok(!sent.info[0].text.includes("Bob"));
  });
}

async function testNaturalLanguageVagueScheduleOverviewQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-vague-schedule-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300523-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-23T07:00:00.000Z",
        reminderAt: "2030-05-23T01:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("本周安排怎么样");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("本周预约列表"));
    assert.ok(sent.info[0].text.includes("Alice"));
  });
}

async function testNaturalLanguageVagueAvailabilityQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-vague-availability-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300521-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-21T07:00:00.000Z",
        reminderAt: "2030-05-21T01:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("明天忙不忙");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("明天共有 1 个预约"));
  });
}

async function testNaturalLanguageCustomerCountQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-customer-count-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300521-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-21T07:00:00.000Z",
        reminderAt: "2030-05-21T01:00:00.000Z",
        note: "",
      },
      {
        id: "300521-002",
        customerName: ZH.alice,
        serviceName: ZH.perm,
        appointmentAt: "2030-05-21T09:00:00.000Z",
        reminderAt: "2030-05-21T03:00:00.000Z",
        note: "",
      },
      {
        id: "300521-003",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-05-21T10:00:00.000Z",
        reminderAt: "2030-05-21T04:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("Alice\u660e\u5929\u6709\u51e0\u4e2a\u9884\u7ea6");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("\u660e\u5929\u5ba2\u6237 Alice\u5171\u6709 2 \u4e2a\u9884\u7ea6"));
    assert.ok(!sent.info[0].text.includes("Bob"));
  });
}

async function testNaturalLanguageCustomerThisWeekListQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-customer-week-list-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300520-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-20T07:00:00.000Z",
        reminderAt: "2030-05-20T01:00:00.000Z",
        note: "",
      },
      {
        id: "300523-001",
        customerName: ZH.alice,
        serviceName: ZH.perm,
        appointmentAt: "2030-05-23T09:00:00.000Z",
        reminderAt: "2030-05-23T03:00:00.000Z",
        note: "改造型",
      },
      {
        id: "300523-002",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-05-23T10:00:00.000Z",
        reminderAt: "2030-05-23T04:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("\u5e2e\u6211\u770b\u770b Alice \u672c\u5468\u6709\u54ea\u4e9b\u9884\u7ea6");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("\u672c\u5468\u5ba2\u6237 Alice\u9884\u7ea6\u5217\u8868"));
    assert.ok(sent.info[0].text.includes(ZH.haircolor));
    assert.ok(sent.info[0].text.includes(ZH.perm));
    assert.ok(!sent.info[0].text.includes("Bob"));
  });
}

async function testNaturalLanguageCustomerDayAfterTomorrowListQueryIntercept() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-customer-day-after-list-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  seedAppointmentScope(runtime, {
    appointments: [
      {
        id: "300522-001",
        customerName: ZH.alice,
        serviceName: ZH.haircolor,
        appointmentAt: "2030-05-22T07:00:00.000Z",
        reminderAt: "2030-05-22T01:00:00.000Z",
        note: "",
      },
      {
        id: "300522-002",
        customerName: "Bob",
        serviceName: ZH.perm,
        appointmentAt: "2030-05-22T09:00:00.000Z",
        reminderAt: "2030-05-22T03:00:00.000Z",
        note: "",
      },
    ],
  });

  await withFixedNow("2030-05-20T00:00:00.000Z", async () => {
    const normalized = normalizeEvent("Alice \u7684\u540e\u5929\u9884\u7ea6\u6709\u54ea\u4e9b");
    const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);
    assert.strictEqual(result, null);
    assert.strictEqual(sent.info.length, 1);
    assert.ok(sent.info[0].text.includes("\u540e\u5929\u5ba2\u6237 Alice\u9884\u7ea6\u5217\u8868"));
    assert.ok(sent.info[0].text.includes(ZH.haircolor));
    assert.ok(!sent.info[0].text.includes("Bob"));
  });
}

async function testNaturalLanguageAppointmentQueryFallsThroughWithoutAppointmentKeyword() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-query-fallthrough-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const normalized = normalizeEvent("\u660e\u5929\u8fd8\u6709\u51e0\u4e2a\u95ee\u9898");

  const result = await appointmentService.handlePotentialAppointmentMessage(runtime, normalized);

  assert.strictEqual(result, normalized);
  assert.strictEqual(sent.info.length, 0);
  assert.strictEqual(sent.cards.length, 0);
}

function testSameDayAfterNineUsesOneHourReminder() {
  const now = new Date("2026-05-20T10:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguageAppointmentText(
    `${ZH.alice}${ZH.appoint}${ZH.todayThreePm} ${ZH.haircolor}`,
    {
      now,
      timezone: "Asia/Shanghai",
    }
  );

  assert.ok(parsed.ok);
  assert.strictEqual(parsed.appointmentAt.getTime() - parsed.reminderAt.getTime(), 60 * 60 * 1000);
}

function testPersonalReminderParsesRelativeMinutes() {
  const now = new Date("2026-05-25T21:08:10+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "过5分钟，提醒我喝水",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.kind, "personal_event");
  assert.strictEqual(parsed.title, "喝水");
  assert.strictEqual(parsed.serviceName, "喝水");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-25T13:13:10.000Z");
  assert.strictEqual(parsed.reminderAt.toISOString(), "2026-05-25T13:13:10.000Z");
}

function testPersonalReminderParsesRelativeHalfHour() {
  const now = new Date("2026-05-25T21:08:10+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "半小时后提醒我关空调",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "关空调");
  assert.strictEqual(parsed.serviceName, "关空调");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-25T13:38:10.000Z");
  assert.strictEqual(parsed.reminderAt.toISOString(), "2026-05-25T13:38:10.000Z");
}

function testPersonalReminderParsesAppointmentAndExplicitReminder() {
  const now = new Date("2026-05-25T21:08:10+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "预约明天晚上7点把电动螺丝刀带回家，在6点50分发提醒给我",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.kind, "personal_event");
  assert.strictEqual(parsed.title, "把电动螺丝刀带回家");
  assert.strictEqual(parsed.serviceName, "把电动螺丝刀带回家");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-26T11:00:00.000Z");
  assert.strictEqual(parsed.reminderAt.toISOString(), "2026-05-26T10:50:00.000Z");
}

function testPersonalReminderParsesSameDayExplicitReminder() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "今晚11点提醒我下班，在10点50分提醒我",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "下班");
  assert.strictEqual(parsed.serviceName, "下班");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-25T15:00:00.000Z");
  assert.strictEqual(parsed.reminderAt.toISOString(), "2026-05-25T14:50:00.000Z");
}

function testPersonalReminderParsesAdvanceOffsetReminder() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "今晚11点下班，提前10分钟提醒我",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "下班");
  assert.strictEqual(parsed.serviceName, "下班");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-25T15:00:00.000Z");
  assert.strictEqual(parsed.reminderAt.toISOString(), "2026-05-25T14:50:00.000Z");
}

function testPersonalReminderParsesAdvanceHalfHourReminder() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "今晚11点下班，提前半小时提醒我",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "下班");
  assert.strictEqual(parsed.serviceName, "下班");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-25T15:00:00.000Z");
  assert.strictEqual(parsed.reminderAt.toISOString(), "2026-05-25T14:30:00.000Z");
}

function testPersonalReminderParsesTomorrowMorningReminder() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "明天早上8点提醒我带钥匙",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "带钥匙");
  assert.strictEqual(parsed.serviceName, "带钥匙");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-26T00:00:00.000Z");
}

function testPersonalReminderParsesWeekdayReminder() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "周二下午3点提醒我开会",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "开会");
  assert.strictEqual(parsed.serviceName, "开会");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-26T07:00:00.000Z");
}

function testPersonalReminderParsesFuzzySoonReminder() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "一会儿提醒我收衣服",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "收衣服");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-25T13:15:00.000Z");
}

function testPersonalReminderParsesFuzzyWaitReminder() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "待会提醒我关灯",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "关灯");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-25T13:15:00.000Z");
}

function testPersonalReminderParsesFuzzyTomorrowMorningDefault() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "明早提醒我带钥匙",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "带钥匙");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-26T00:00:00.000Z");
}

function testPersonalReminderParsesWeekendDefault() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "周末提醒我大扫除",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "大扫除");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-05-30T01:00:00.000Z");
}

function testPersonalReminderParsesNextWeekdayDefault() {
  const now = new Date("2026-05-25T21:00:00+08:00");
  const parsed = appointmentService.parseNaturalLanguagePersonalAppointmentText(
    "下周二提醒我交周报",
    { now, timezone: "Asia/Shanghai" }
  );
  assert.strictEqual(parsed.intentDetected, true);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.title, "交周报");
  assert.strictEqual(parsed.appointmentAt.toISOString(), "2026-06-02T01:00:00.000Z");
}

async function testReminderScanSendsOnlyOnce() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-remind-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const chatScopeKey = runtime.sessionStore.buildChatScopeKey({
    workspaceId: "default",
    chatId: "oc_reminder",
  });
  const appointmentAt = new Date("2030-05-21T11:00:00+08:00");
  const reminderAt = new Date("2030-05-21T10:00:00+08:00");

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, () => ({
    chatId: "oc_reminder",
    workspaceId: "default",
    appointmentsById: {
      "300521-001": {
        id: "300521-001",
        chatId: "oc_reminder",
        workspaceId: "default",
        customerName: ZH.alice,
        normalizedCustomerName: "alice",
        serviceName: ZH.haircolor,
        appointmentAt: appointmentAt.toISOString(),
        reminderAt: reminderAt.toISOString(),
        note: "",
        status: "pending",
        createdAt: appointmentAt.toISOString(),
        updatedAt: appointmentAt.toISOString(),
        confirmedAt: appointmentAt.toISOString(),
        reminderSentAt: "",
        sourceMessageId: "om_source",
        sourceSenderId: "ou_source",
      },
    },
    customerProfilesByName: {
      alice: {
        displayName: ZH.alice,
        normalizedName: "alice",
        profileNote: "vip-client",
        historyAppointmentIds: ["300521-001"],
        updatedAt: appointmentAt.toISOString(),
      },
    },
    pendingDraftsById: {},
    sequenceByDate: {
      "300521": 1,
    },
  }));

  const now = new Date("2030-05-21T10:30:00+08:00");
  await appointmentService.runAppointmentReminderScan(runtime, { now });
  assert.strictEqual(sent.info.length, 1);

  let scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  assert.ok(scope.appointmentsById["300521-001"].reminderSentAt);

  await appointmentService.runAppointmentReminderScan(runtime, { now });
  assert.strictEqual(sent.info.length, 1);

  scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  assert.ok(scope.appointmentsById["300521-001"].reminderSentAt);
}

async function testPersonalRelativeReminderScanAllowsSmallDelay() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-relative-remind-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const chatScopeKey = runtime.sessionStore.buildChatScopeKey({
    workspaceId: "default",
    chatId: "oc_relative_reminder",
  });
  const appointmentAt = new Date("2030-05-21T10:35:00+08:00");
  const reminderAt = new Date("2030-05-21T10:35:00+08:00");

  runtime.sessionStore.updateAppointmentScope(chatScopeKey, () => ({
    chatId: "oc_relative_reminder",
    workspaceId: "default",
    appointmentsById: {
      "300521-002": {
        id: "300521-002",
        chatId: "oc_relative_reminder",
        workspaceId: "default",
        customerName: "我",
        normalizedCustomerName: "我",
        serviceName: "喝水",
        title: "喝水",
        appointmentAt: appointmentAt.toISOString(),
        reminderAt: reminderAt.toISOString(),
        note: "个人事项",
        status: "pending",
        createdAt: appointmentAt.toISOString(),
        updatedAt: appointmentAt.toISOString(),
        confirmedAt: appointmentAt.toISOString(),
        reminderSentAt: "",
        sourceMessageId: "om_relative_source",
        sourceSenderId: "ou_relative_source",
        kind: "personal_event",
      },
    },
    customerProfilesByName: {
      "我": {
        displayName: "我",
        normalizedName: "我",
        profileNote: "个人事项",
        historyAppointmentIds: ["300521-002"],
        updatedAt: appointmentAt.toISOString(),
      },
    },
    pendingDraftsById: {},
    sequenceByDate: {
      "300521": 2,
    },
  }));

  const now = new Date("2030-05-21T10:35:30+08:00");
  await appointmentService.runAppointmentReminderScan(runtime, { now });
  assert.strictEqual(sent.info.length, 1);
  assert.ok(sent.info[0].text.includes("喝水"));

  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  assert.ok(scope.appointmentsById["300521-002"].reminderSentAt);
}

async function testPersonalRelativeReminderScanAllowsLateDelivery() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-relative-late-remind-"));
  const { runtime, sent } = createRuntime(path.join(tempDir, "sessions.json"));
  const chatScopeKey = runtime.sessionStore.buildChatScopeKey({
    workspaceId: "default",
    chatId: "oc_relative_late_reminder",
  });
  const reminderAt = new Date("2030-05-21T10:35:00+08:00");
  runtime.sessionStore.updateAppointmentScope(chatScopeKey, () => ({
    chatId: "oc_relative_late_reminder",
    workspaceId: "default",
    appointmentsById: {
      "300521-003": {
        id: "300521-003",
        chatId: "oc_relative_late_reminder",
        workspaceId: "default",
        customerName: "我",
        normalizedCustomerName: "我",
        serviceName: "喝水",
        title: "喝水",
        appointmentAt: reminderAt.toISOString(),
        reminderAt: reminderAt.toISOString(),
        note: "个人事项",
        status: "pending",
        createdAt: reminderAt.toISOString(),
        updatedAt: reminderAt.toISOString(),
        confirmedAt: reminderAt.toISOString(),
        reminderSentAt: "",
        sourceMessageId: "om_relative_late_source",
        sourceSenderId: "ou_relative_late_source",
        kind: "personal_event",
      },
    },
    customerProfilesByName: {},
    pendingDraftsById: {},
    sequenceByDate: {
      "300521": 1,
    },
  }));

  const now = new Date("2030-05-21T10:46:00+08:00");
  await appointmentService.runAppointmentReminderScan(runtime, { now });
  assert.strictEqual(sent.info.length, 1);
  assert.ok(sent.info[0].text.includes("喝水"));

  const scope = runtime.sessionStore.getAppointmentScope(chatScopeKey);
  assert.ok(scope.appointmentsById["300521-003"].reminderSentAt);
}

async function testDispatcherLetsAppointmentTextReachCodexByDefault() {
  const event = buildTextEvent(buildAbsoluteCreateText(), "om_dispatcher");
  let interceptCalled = false;
  let beforeHookCalled = false;
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgePassthroughToCodex: false,
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialAppointmentMessage: async (normalized) => {
      interceptCalled = true;
      return normalized;
    },
    runBeforeMessageHook: async () => {
      beforeHookCalled = true;
      return null;
    },
    dispatchTextCommand: async () => false,
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
      return "thread_appointment_passthrough";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.strictEqual(interceptCalled, false);
  assert.strictEqual(beforeHookCalled, false);
  assert.deepStrictEqual(seen, [["codex", "message", buildAbsoluteCreateText()]]);
}

async function testDispatcherCanOptIntoAppointmentIntercept() {
  const event = buildTextEvent(buildAbsoluteCreateText(), "om_dispatcher_intercept");
  let interceptCalled = false;
  let beforeHookCalled = false;

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "standard",
      appointmentNaturalLanguageInterceptEnabled: true,
      bridgePassthroughToCodex: false,
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialAppointmentMessage: async () => {
      interceptCalled = true;
      return null;
    },
    runBeforeMessageHook: async (args) => {
      beforeHookCalled = true;
      return args.normalized;
    },
    dispatchTextCommand: async () => false,
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
    async ensureThreadAndSendMessage() {
      return "thread_appointment_intercept";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.strictEqual(interceptCalled, true);
  assert.strictEqual(beforeHookCalled, false);
}

async function testThinBridgeHandlesAppointmentCommandLocally() {
  const event = buildTextEvent("/预约 明天下午三点服务沟通", "om_thin_appointment_command");
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "thin",
      appointmentNaturalLanguageInterceptEnabled: true,
      bridgePassthroughToCodex: false,
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialAppointmentMessage: async (normalized) => {
      seen.push(["appointment-intercept", normalized.command]);
      return null;
    },
    runBeforeMessageHook: async (args) => args.normalized,
    dispatchTextCommand: async (normalized) => {
      seen.push(["local-command", normalized.command]);
      return normalized.command === "appointment";
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
    async ensureThreadAndSendMessage() {
      seen.push(["codex"]);
      return "thread_thin_appointment";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.deepStrictEqual(seen, [
    ["local-command", "appointment"],
  ]);
}

async function testThinBridgeHandlesPersonalReminderLocally() {
  const event = buildTextEvent("预约明天晚上7点把电动螺丝刀带回家，在6点50分发提醒给我", "om_thin_personal_reminder");
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "thin",
      appointmentNaturalLanguageInterceptEnabled: true,
      bridgePassthroughToCodex: false,
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialAppointmentMessage: async (normalized) => {
      seen.push(["appointment-intercept", normalized.command, normalized.text]);
      return null;
    },
    runBeforeMessageHook: async (args) => args.normalized,
    dispatchTextCommand: async () => false,
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
    async ensureThreadAndSendMessage() {
      seen.push(["codex"]);
      return "thread_thin_personal";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.deepStrictEqual(seen, [
    ["appointment-intercept", "message", "预约明天晚上7点把电动螺丝刀带回家，在6点50分发提醒给我"],
  ]);
}

async function testThinBridgeHandlesAppointmentListCommandLocally() {
  const event = buildTextEvent("/预约 列表 all", "om_thin_appointment_list");
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "thin",
      appointmentNaturalLanguageInterceptEnabled: true,
      bridgePassthroughToCodex: false,
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialAppointmentMessage: async (normalized) => {
      seen.push(["appointment-intercept", normalized.command]);
      return normalized;
    },
    runBeforeMessageHook: async (args) => args.normalized,
    dispatchTextCommand: async (normalized) => {
      seen.push(["local-command", normalized.command, normalized.text]);
      return normalized.command === "appointment";
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
    async ensureThreadAndSendMessage() {
      seen.push(["codex"]);
      return "thread_thin_appointment_list";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.deepStrictEqual(seen, [
    ["local-command", "appointment", "/预约 列表 all"],
  ]);
}

async function testThinBridgeHandlesAppointmentCancelCommandLocally() {
  const event = buildTextEvent("/预约 取消 260526-001", "om_thin_appointment_cancel");
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "thin",
      appointmentNaturalLanguageInterceptEnabled: true,
      bridgePassthroughToCodex: false,
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialAppointmentMessage: async (normalized) => {
      seen.push(["appointment-intercept", normalized.command]);
      return normalized;
    },
    runBeforeMessageHook: async (args) => args.normalized,
    dispatchTextCommand: async (normalized) => {
      seen.push(["local-command", normalized.command, normalized.text]);
      return normalized.command === "appointment";
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
    async ensureThreadAndSendMessage() {
      seen.push(["codex"]);
      return "thread_thin_appointment_cancel";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.deepStrictEqual(seen, [
    ["local-command", "appointment", "/预约 取消 260526-001"],
  ]);
}

async function testDirectBridgeSendsPersonalReminderToCodex() {
  const event = buildTextEvent("过5分钟提醒我喝水", "om_direct_personal_reminder");
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "direct",
      appointmentNaturalLanguageInterceptEnabled: true,
      bridgePassthroughToCodex: true,
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialPersonalReminderMessage: async (normalized) => {
      seen.push(["personal-reminder-intercept", normalized.command, normalized.text]);
      return normalized;
    },
    handlePotentialAppointmentMessage: async () => {
      seen.push(["appointment-intercept"]);
      return null;
    },
    runBeforeMessageHook: async (args) => args.normalized,
    dispatchTextCommand: async () => false,
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
      return "thread_direct_personal";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.deepStrictEqual(seen, [
    ["codex", "message", "过5分钟提醒我喝水"],
  ]);
}

async function testDirectBridgeSendsCustomerAppointmentToCodex() {
  const event = buildTextEvent("一个小时以后，陈显预约剪头发", "om_direct_customer_appointment");
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "direct",
      appointmentNaturalLanguageInterceptEnabled: true,
      bridgePassthroughToCodex: true,
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialPersonalReminderMessage: async (normalized) => {
      seen.push(["personal-reminder-intercept", normalized.command, normalized.text]);
      return normalized;
    },
    handlePotentialAppointmentMessage: async (normalized) => {
      seen.push(["appointment-intercept", normalized.command, normalized.text]);
      return normalized;
    },
    runBeforeMessageHook: async (args) => args.normalized,
    dispatchTextCommand: async () => false,
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
      return "thread_direct_customer_appointment";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.deepStrictEqual(seen, [
    ["codex", "message", "一个小时以后，陈显预约剪头发"],
  ]);
}

async function testDirectBridgeLetsNonReminderMessageReachCodex() {
  const event = buildTextEvent("提醒我分析一下这个问题", "om_direct_non_reminder");
  const seen = [];

  await dispatcher.onFeishuTextEvent({
    config: {
      defaultWorkspaceId: "default",
      bridgeMode: "direct",
      appointmentNaturalLanguageInterceptEnabled: true,
      bridgePassthroughToCodex: true,
    },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    handlePotentialPersonalReminderMessage: async (normalized) => {
      seen.push(["personal-reminder-intercept", normalized.command, normalized.text]);
      return normalized;
    },
    runBeforeMessageHook: async (args) => args.normalized,
    dispatchTextCommand: async () => false,
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
      return "thread_direct_non_reminder";
    },
    async sendInfoCardMessage() {},
  }, event);

  assert.deepStrictEqual(seen, [
    ["codex", "message", "提醒我分析一下这个问题"],
  ]);
}

function testAppointmentPersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-appointment-persist-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });

  store.updateAppointmentScope("default:oc_test", () => ({
    chatId: "oc_test",
    workspaceId: "default",
    appointmentsById: {
      "300521-001": {
        id: "300521-001",
        chatId: "oc_test",
        workspaceId: "default",
        customerName: ZH.alice,
        normalizedCustomerName: "alice",
        serviceName: "cut",
        appointmentAt: "2030-05-21T07:00:00.000Z",
        reminderAt: "2030-05-21T01:00:00.000Z",
        note: "",
        status: "pending",
        createdAt: "2030-05-20T00:00:00.000Z",
        updatedAt: "2030-05-20T00:00:00.000Z",
        confirmedAt: "2030-05-20T00:00:00.000Z",
        reminderSentAt: "",
        sourceMessageId: "om_test",
        sourceSenderId: "ou_test",
      },
    },
    customerProfilesByName: {},
    pendingDraftsById: {},
    sequenceByDate: {
      "300521": 1,
    },
  }));

  const reloaded = new SessionStore({ filePath });
  const scope = reloaded.getAppointmentScope("default:oc_test");
  assert.ok(scope.appointmentsById["300521-001"]);
  assert.strictEqual(scope.appointmentsById["300521-001"].customerName, ZH.alice);
}

function createRuntime(filePath) {
  const sent = {
    info: [],
    cards: [],
    patches: [],
    cardFeedback: [],
  };
  const runtime = {
    config: {
      defaultWorkspaceId: "default",
      appointmentReminderEnabled: true,
      appointmentReminderTimezone: "Asia/Shanghai",
      appointmentReminderScanIntervalSec: 60,
    },
    sessionStore: new SessionStore({ filePath }),
    sendInfoCardMessage: async (payload) => {
      sent.info.push(payload);
      return payload;
    },
    sendInteractiveCard: async (payload) => {
      sent.cards.push(payload);
      return payload;
    },
    patchInteractiveCard: async (payload) => {
      sent.patches.push(payload);
      return payload;
    },
    queueCardActionWithFeedback: async (_normalized, feedbackText, task) => {
      sent.cardFeedback.push(feedbackText);
      await task();
      return { ok: true };
    },
    buildCardToast: (text) => ({ toast: text }),
  };
  return { runtime, sent };
}

function buildFutureCreateText() {
  return `${ZH.alice}${ZH.appoint}${ZH.tomorrowThreePm} ${ZH.haircolor} ${ZH.note}${ZH.coolTone}`;
}

function buildAbsoluteCreateText() {
  return `${ZH.alice}${ZH.appoint}2030-05-21 15:00 ${ZH.haircolor} ${ZH.note}${ZH.coolTone}`;
}

function seedAppointmentScope(runtime, {
  chatId = "oc_test",
  workspaceId = "default",
  appointments = [],
} = {}) {
  const chatScopeKey = runtime.sessionStore.buildChatScopeKey({
    workspaceId,
    chatId,
  });
  runtime.sessionStore.updateAppointmentScope(chatScopeKey, () => ({
    chatId,
    workspaceId,
    appointmentsById: Object.fromEntries(
      appointments.map((item) => [
        item.id,
        {
          id: item.id,
          chatId,
          workspaceId,
          customerName: item.customerName,
          normalizedCustomerName: String(item.customerName || "").trim().toLowerCase(),
          serviceName: item.serviceName,
          appointmentAt: item.appointmentAt,
          reminderAt: item.reminderAt,
          note: item.note || "",
          status: item.status || "pending",
          createdAt: item.createdAt || item.appointmentAt,
          updatedAt: item.updatedAt || item.appointmentAt,
          confirmedAt: item.confirmedAt || item.appointmentAt,
          reminderSentAt: item.reminderSentAt || "",
          sourceMessageId: item.sourceMessageId || "om_seed",
          sourceSenderId: item.sourceSenderId || "ou_seed",
        },
      ])
    ),
    customerProfilesByName: {},
    pendingDraftsById: {},
    sequenceByDate: {},
  }));
}

async function withFixedNow(fixedNowIso, callback) {
  const originalDateNow = Date.now;
  const OriginalDate = Date;
  global.Date = class extends OriginalDate {
    constructor(...args) {
      if (!args.length) {
        super(fixedNowIso);
        return;
      }
      super(...args);
    }
    static now() {
      return new OriginalDate(fixedNowIso).getTime();
    }
    static parse(value) {
      return OriginalDate.parse(value);
    }
    static UTC(...args) {
      return OriginalDate.UTC(...args);
    }
  };
  Date.now = global.Date.now;
  try {
    await callback();
  } finally {
    global.Date = OriginalDate;
    Date.now = originalDateNow;
  }
}

function normalizeEvent(text, messageId = "om_test") {
  return normalizeFeishuTextEvent(buildTextEvent(text, messageId), {
    defaultWorkspaceId: "default",
  });
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

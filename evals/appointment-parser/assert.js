function gradeAppointmentParse(output, context) {
  const actual = parseOutput(output);
  const vars = context?.vars || {};
  const checks = [];

  addBooleanCheck(checks, "intent-detected", actual.intentDetected, vars.expected_intent_detected, 0.08);
  addBooleanCheck(checks, "datetime-detected", actual.datetimeDetected, vars.expected_datetime_detected, 0.08);
  addBooleanCheck(checks, "ok-flag", actual.ok, vars.expected_ok, 0.08);
  addTextCheck(checks, "current-route", actual.currentRoute, vars.expected_current_route, 0.18);
  addTextCheck(checks, "suggested-route", actual.suggestedRoute, vars.expected_suggested_route, 0.18);
  addTextCheck(checks, "customer-name", actual.customerName, vars.expected_customer_name, 0.12);
  addTextCheck(checks, "service-name", actual.serviceName, vars.expected_service_name, 0.12);
  addContainsCheck(checks, "note-contains", actual.note, vars.expected_note_contains, 0.06);
  addTextCheck(checks, "appointment-iso", actual.appointmentAtIso, vars.expected_appointment_iso, 0.14);
  addTextCheck(checks, "reminder-iso", actual.reminderAtIso, vars.expected_reminder_iso, 0.08);
  addContainsCheck(checks, "message-contains", actual.message, vars.expected_message_contains, 0.08);

  const activeChecks = checks.filter((item) => item.active);
  const totalWeight = activeChecks.reduce((sum, item) => sum + item.weight, 0) || 1;
  const score = activeChecks.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0) / totalWeight;
  const passThreshold = Number.parseFloat(String(context?.config?.passThreshold || "0.85"));
  const failures = activeChecks.filter((item) => !item.pass);

  return {
    pass: score >= passThreshold,
    score,
    reason: failures.length
      ? failures.map((item) => `${item.name}: expected ${item.expectedLabel}, got ${item.actualLabel}`).join("; ")
      : `score ${score.toFixed(2)}`,
    componentResults: activeChecks.map((item) => ({
      pass: item.pass,
      score: item.pass ? 1 : 0,
      name: item.name,
      reason: item.pass ? "ok" : `expected ${item.expectedLabel}, got ${item.actualLabel}`,
    })),
    namedScores: {
      appointment_parser_score: score,
      route_score: averageGroup(activeChecks, ["current-route", "suggested-route"]),
      entity_score: averageGroup(activeChecks, ["customer-name", "service-name", "note-contains"]),
      time_score: averageGroup(activeChecks, ["appointment-iso", "reminder-iso", "datetime-detected"]),
    },
  };
}

function parseOutput(output) {
  if (typeof output === "string") {
    return JSON.parse(output);
  }
  return output || {};
}

function addBooleanCheck(checks, name, actual, expectedRaw, weight) {
  const expected = parseExpectedBoolean(expectedRaw);
  checks.push({
    name,
    active: expected !== null,
    pass: expected === null ? true : Boolean(actual) === expected,
    expectedLabel: expected === null ? "(skip)" : String(expected),
    actualLabel: String(Boolean(actual)),
    weight,
  });
}

function addTextCheck(checks, name, actual, expectedRaw, weight) {
  const expected = normalizeOptional(expectedRaw);
  const normalizedActual = normalizeText(actual);
  checks.push({
    name,
    active: expected !== "",
    pass: expected === "" ? true : normalizedActual === normalizeText(expected),
    expectedLabel: expected === "" ? "(skip)" : expected,
    actualLabel: normalizedActual,
    weight,
  });
}

function addContainsCheck(checks, name, actual, expectedRaw, weight) {
  const expected = normalizeOptional(expectedRaw);
  const normalizedActual = normalizeText(actual);
  checks.push({
    name,
    active: expected !== "",
    pass: expected === "" ? true : normalizedActual.includes(normalizeText(expected)),
    expectedLabel: expected === "" ? "(skip)" : expected,
    actualLabel: normalizedActual,
    weight,
  });
}

function normalizeOptional(value) {
  if (value === undefined || value === null) {
    return "";
  }
  const text = String(value).trim();
  return text;
}

function parseExpectedBoolean(value) {
  const text = normalizeOptional(value).toLowerCase();
  if (!text) {
    return null;
  }
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  return null;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function averageGroup(checks, names) {
  const items = checks.filter((item) => item.active && names.includes(item.name));
  if (!items.length) {
    return 1;
  }
  return items.reduce((sum, item) => sum + (item.pass ? 1 : 0), 0) / items.length;
}

module.exports = {
  gradeAppointmentParse,
};

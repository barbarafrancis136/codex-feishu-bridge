# Appointment Parser Evals

This folder adds a minimal local `promptfoo` scaffold for the appointment parser.

It evaluates the existing parser directly through `src/domain/appointment/service.js` rather than calling an external model. That keeps results stable and makes the score useful for code changes.

## Files

- `provider.js`
  - Local promptfoo provider that calls `parseNaturalLanguageAppointmentText(...)`
  - Emits both `currentRoute` and `suggestedRoute`
- `assert.js`
  - Weighted score for route, entity extraction, datetime extraction, reminder rule, and error text
- `promptfooconfig.baseline.yaml`
  - Green-by-default local regression config with embedded baseline dataset
- `promptfooconfig.growth.yaml`
  - Product-target config with embedded growth dataset that is allowed to expose current gaps

## Route meanings

- `create`
  - Parse succeeded and should produce a confirmation draft/card
- `error`
  - Parse detected a valid datetime shape but should stop with an error message
- `fallthrough`
  - Message should continue to the normal Codex path
- `clarify`
  - Product-target route for "I can tell this is an appointment, but time/details are incomplete"

`currentRoute` mirrors today's bridge behavior.

`suggestedRoute` is a forward-looking eval hint for the product behavior we want later. It is intentionally stricter and can be used to drive optimization work.

## Scoring

The scorer uses weighted checks:

- route: 0.18 current + 0.18 suggested
- parser flags: 0.08 intent + 0.08 datetime + 0.08 ok
- entities: 0.12 customer + 0.12 service + 0.06 note
- time fields: 0.14 appointment + 0.08 reminder
- message text: 0.08

Only populated expectations count toward the score.

Default pass threshold: `0.85`

## Recommended usage

Run the current-code regression suite:

```bash
npm run eval:appointment-parser
```

Run the product-target suite:

```bash
npm run eval:appointment-parser:growth
```

If you need to call promptfoo directly, use the repo-pinned version:

```bash
npx promptfoo@0.118.0 eval -c evals/appointment-parser/promptfooconfig.baseline.yaml
```

## How to use this in the bridge

Recommended order:

1. Keep `baseline` green after every parser change
2. Use `growth` to decide the next optimization target
3. Only promote `growth` cases into `baseline` after the implementation is stable

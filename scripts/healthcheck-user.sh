#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="codex-feishu-bridge.service"
STATE_DIR="${CODEX_IM_HEALTH_STATE_DIR:-$HOME/.codex-feishu-bridge/runtime}"
FAIL_FILE="${STATE_DIR}/health_fail_count"
DOWN_FILE="${STATE_DIR}/health_down_sent"
THRESHOLD="${CODEX_IM_HEALTH_THRESHOLD:-3}"

ALERT_ENV="${CODEX_IM_ALERT_ENV:-$HOME/.config/codex-feishu-bridge/alert.env}"
[ -f "$ALERT_ENV" ] && source "$ALERT_ENV"
WEBHOOK_URL="${ALERT_FEISHU_WEBHOOK:-}"

mkdir -p "$STATE_DIR"
[ -f "$FAIL_FILE" ] || echo 0 > "$FAIL_FILE"

send_msg() {
  local text="$1"
  [ -z "$WEBHOOK_URL" ] && return 0
  curl -sS -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$text\"}}" >/dev/null || true
}

if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  fail_count="$(cat "$FAIL_FILE")"
  if [ "$fail_count" -ge "$THRESHOLD" ] && [ -f "$DOWN_FILE" ]; then
    send_msg "[$(date '+%F %T')] ${SERVICE_NAME} RECOVERED on $(hostname)"
    rm -f "$DOWN_FILE"
  fi
  echo 0 > "$FAIL_FILE"
  exit 0
fi

fail_count="$(cat "$FAIL_FILE")"
fail_count=$((fail_count + 1))
echo "$fail_count" > "$FAIL_FILE"

if [ "$fail_count" -ge "$THRESHOLD" ] && [ ! -f "$DOWN_FILE" ]; then
  send_msg "[$(date '+%F %T')] ${SERVICE_NAME} DOWN x${fail_count} on $(hostname), restarting..."
  touch "$DOWN_FILE"
fi

systemctl --user restart "$SERVICE_NAME" || true

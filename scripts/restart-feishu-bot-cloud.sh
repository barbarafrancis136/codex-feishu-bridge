#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${CODEX_IM_APP_DIR:-/root/snap/codex/common/projects/codex-feishu-bridge-v2/app}"
LOG_FILE="${CODEX_IM_RUNTIME_LOG:-/tmp/codex-feishu-bot.log}"
LOCK_DIR="${CODEX_IM_RESTART_LOCK_DIR:-/tmp/codex-feishu-bot-restart.lock}"
SYSTEMD_SERVICE_NAME="${CODEX_IM_SYSTEMD_SERVICE_NAME:-codex-feishu-bridge.service}"

if [ -z "${TERM:-}" ] || [ "${TERM}" = "dumb" ]; then
  export TERM=xterm-256color
fi

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "[restart] another restart is already in progress: ${LOCK_DIR}"
  exit 1
fi
trap 'rmdir "${LOCK_DIR}" >/dev/null 2>&1 || true' EXIT

echo "[restart] app dir: ${APP_DIR}"
cd "${APP_DIR}"

if command -v systemctl >/dev/null 2>&1 && systemctl status "${SYSTEMD_SERVICE_NAME}" >/dev/null 2>&1; then
  echo "[restart] restarting systemd service: ${SYSTEMD_SERVICE_NAME}"
  systemctl restart "${SYSTEMD_SERVICE_NAME}"
  sleep 3
  echo "[restart] systemd status:"
  systemctl status "${SYSTEMD_SERVICE_NAME}" --no-pager --lines=20 || true
  echo "[restart] feishu-bot processes:"
  ps -ef | grep "node ./bin/codex-im.js feishu-bot" | grep -v grep || true
  echo "[restart] app-server processes:"
  ps -ef | grep "/snap/codex/.*/bin/codex app-server" | grep -v grep || true
  exit 0
fi

echo "[restart] stopping old feishu-bot/app-server processes if present"
OLD_BOT_PIDS="$(pgrep -f "node ./bin/codex-im.js feishu-bot" || true)"
if [ -n "${OLD_BOT_PIDS}" ]; then
  for pid in ${OLD_BOT_PIDS}; do
    CHILD_PIDS="$(pgrep -P "${pid}" || true)"
    if [ -n "${CHILD_PIDS}" ]; then
      kill -TERM ${CHILD_PIDS} 2>/dev/null || true
    fi
    kill -TERM "${pid}" 2>/dev/null || true
  done
  sleep 2
  for pid in ${OLD_BOT_PIDS}; do
    if ps -p "${pid}" >/dev/null 2>&1; then
      CHILD_PIDS="$(pgrep -P "${pid}" || true)"
      if [ -n "${CHILD_PIDS}" ]; then
        kill -KILL ${CHILD_PIDS} 2>/dev/null || true
      fi
      kill -KILL "${pid}" 2>/dev/null || true
    fi
  done
fi
sleep 2

echo "[restart] starting feishu-bot"
nohup sh -c 'exec node ./bin/codex-im.js feishu-bot' >"${LOG_FILE}" 2>&1 &
NEW_PID=$!
sleep 5

if ! ps -p "${NEW_PID}" >/dev/null 2>&1; then
  echo "[restart] failed to start feishu-bot"
  tail -n 80 "${LOG_FILE}" || true
  exit 1
fi

echo "[restart] feishu-bot pid: ${NEW_PID}"
echo "[restart] process tree:"
ps -p "${NEW_PID}" -o pid=,ppid=,cmd=
echo "[restart] app-server processes:"
ps -ef | grep "/snap/codex/.*/bin/codex app-server" | grep -v grep || true
echo "[restart] feishu-bot processes:"
ps -ef | grep "node ./bin/codex-im.js feishu-bot" | grep -v grep || true
echo "[restart] recent log:"
tail -n 80 "${LOG_FILE}" || true

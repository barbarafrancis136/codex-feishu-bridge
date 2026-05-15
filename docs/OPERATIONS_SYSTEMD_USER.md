# systemd --user 7×24 运维指南

本文档提供 `codex-feishu-bridge` 在 Linux 用户级 `systemd`（`systemctl --user`）下的稳定运行方案，目标是：

- 7×24 持续运行
- 失败自动自愈
- Feishu webhook 告警闭环
- 可回滚

## 1. 前置条件

- Linux（建议 Ubuntu 22.04+）
- `systemd --user` 可用
- Node.js `>=18`
- 当前用户可运行 `npm run feishu-bot`

建议先完成一次发布前检查：

```sh
npm run check:release
```

## 2. 文件清单

本仓库提供以下模板与脚本：

- `docs/ops/systemd-user/codex-feishu-bridge.service`
- `docs/ops/systemd-user/codex-feishu-bridge-healthcheck.service`
- `docs/ops/systemd-user/codex-feishu-bridge-healthcheck.timer`
- `scripts/healthcheck-user.sh`

## 3. 安装步骤（复制模板）

1) 准备目录

```sh
mkdir -p ~/.config/systemd/user
mkdir -p ~/.config/codex-feishu-bridge
```

2) 复制模板（按你的实际路径替换占位符）

```sh
cp docs/ops/systemd-user/codex-feishu-bridge.service ~/.config/systemd/user/
cp docs/ops/systemd-user/codex-feishu-bridge-healthcheck.service ~/.config/systemd/user/
cp docs/ops/systemd-user/codex-feishu-bridge-healthcheck.timer ~/.config/systemd/user/
chmod +x scripts/healthcheck-user.sh
```

3) 写入告警配置

```sh
cat > ~/.config/codex-feishu-bridge/alert.env <<'EOF'
ALERT_FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/REPLACE_ME"
EOF
chmod 600 ~/.config/codex-feishu-bridge/alert.env
```

4) 启用服务和定时器

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-feishu-bridge.service
systemctl --user enable --now codex-feishu-bridge-healthcheck.timer
sudo loginctl enable-linger "$(whoami)"
```

## 4. 占位符说明

`docs/ops/systemd-user/*.service` 里有以下占位符，必须替换：

- `__WORKDIR__`：仓库绝对路径（例如 `/home/agentuser/codex-feishu-bridge`）
- `__PATH__`：运行时 PATH（建议至少含 `/usr/local/bin:/usr/bin:/bin`）
- `__HEALTHCHECK_SCRIPT__`：健康检查脚本绝对路径

## 5. 日常巡检

```sh
systemctl --user status codex-feishu-bridge.service --no-pager
systemctl --user list-timers --all | grep codex-feishu-bridge-healthcheck
journalctl --user -u codex-feishu-bridge -n 200 --no-pager
journalctl --user -u codex-feishu-bridge-healthcheck.service -n 80 --no-pager
```

## 6. 30 分钟验收建议

- Timer 每分钟触发
- `kill` 主进程后自动恢复
- `DOWN` / `RECOVERED` 告警均送达
- 30 分钟内重启次数在预期范围

## 7. 回滚

```sh
systemctl --user disable --now codex-feishu-bridge-healthcheck.timer || true
systemctl --user disable --now codex-feishu-bridge.service || true
rm -f ~/.config/systemd/user/codex-feishu-bridge.service
rm -f ~/.config/systemd/user/codex-feishu-bridge-healthcheck.service
rm -f ~/.config/systemd/user/codex-feishu-bridge-healthcheck.timer
systemctl --user daemon-reload
systemctl --user reset-failed
```


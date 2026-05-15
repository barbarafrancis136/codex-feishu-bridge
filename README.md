# codex-feishu-bridge

`codex-feishu-bridge` 是一个把本机 Codex 接入飞书/Lark 的轻量插件。

```text
飞书消息 -> 本机 Codex app-server -> 飞书回复
```

它的定位很单一：让用户可以在飞书里远程使用本机 Codex，继续同一条 Codex 线程、切换本地项目、选择模型、审批 Codex 动作，并把回复以飞书卡片形式展示。

完整中文说明书见：[docs/使用说明.md](docs/使用说明.md)。

架构和维护边界见：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

7×24 部署（`systemd --user`）见：[docs/OPERATIONS_SYSTEMD_USER.md](docs/OPERATIONS_SYSTEMD_USER.md)。

版本更新记录见：[CHANGELOG.md](CHANGELOG.md)。当前版本：`0.2.4`。

## 它能做什么

- 在飞书里和本机 Codex 对话。
- 把一个飞书会话绑定到一个本地项目目录。
- 在飞书里创建、切换、恢复 Codex 线程。
- 查看当前项目、当前线程和最近消息。
- 设置当前项目使用的模型和推理强度。
- 停止正在运行的 Codex 任务。
- 通过飞书审批 Codex 发起的操作请求。
- 把绑定项目内的文件发送到飞书。
- 接收飞书图片并作为 Codex 原生图片输入读取。
- 让 Codex 通过隐藏指令把当前项目内的图片或文件回传到飞书。
- 用流式飞书卡片展示 Codex 回复、工具执行和 token 用量摘要。

## 它不做什么

- 不内置私有知识库。
- 不内置私人任务系统。
- 不内置记忆编译、召回脚本或每日沉淀。
- 不绑定任何特定团队的项目中枢或自动化系统。
- 不携带任何密钥、token、私有 ID、本地日志或个人工作区数据。

## 安装

```sh
npm install -g codex-feishu-bridge
codex-im feishu-bot
```

本地开发运行：

```sh
npm install
npm run feishu-bot
```

## 基本配置

复制 `.env.example` 为 `.env`，填入飞书应用和 Codex 默认参数：

```text
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
CODEX_IM_DEFAULT_CODEX_MODEL=gpt-5.3-codex
CODEX_IM_DEFAULT_CODEX_EFFORT=medium
CODEX_IM_DEFAULT_CODEX_ACCESS_MODE=default
```

图片和附件会下载到本机私有缓存，默认位置：

```text
~/.codex-feishu-bridge/attachments
```

可选配置：

```text
CODEX_IM_ATTACHMENTS_DIR=/Users/your-name/.codex-feishu-bridge/attachments
CODEX_IM_MAX_IMAGE_BYTES=10485760
CODEX_IM_MAX_ATTACHMENT_BYTES=104857600
CODEX_IM_FEISHU_RETRY_MAX_ATTEMPTS=3
CODEX_IM_FEISHU_RETRY_BASE_DELAY_MS=300
```

配置加载顺序：

1. 当前目录的 `.env`
2. `~/.codex-im/.env`
3. 当前 shell 环境变量

## 常用命令

- `/codex bind /absolute/path`
- `/codex where`
- `/codex workspace`
- `/codex remove /absolute/path`
- `/codex send <relative-file-path>`
- `/codex switch <threadId>`
- `/codex message`
- `/codex new`
- `/codex stop`
- `/codex model`
- `/codex model update`
- `/codex model <modelId>`
- `/codex effort`
- `/codex effort <low|medium|high|xhigh>`
- `/codex profile`
- `/codex profile main`
- `/codex approve`
- `/codex approve workspace`
- `/codex reject`
- `/codex help`

## 飞书应用要求

事件订阅：

| 事件 | 标识 |
| --- | --- |
| 接收消息 | `im.message.receive_v1` |
| 卡片回传交互 | `card.action.trigger` |

推荐权限：

| 权限 | 标识 |
| --- | --- |
| 创建与更新卡片 | `cardkit:card:write` |
| 获取卡片信息 | `cardkit:card:read` |
| 以应用身份发消息 | `im:message:send_as_bot` |
| 读取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` |
| 发送/删除表情回复 | `im:message.reactions:write_only` |
| 获取与上传图片或文件资源 | `im:resource` |

## 媒体附件

- 收图：飞书/Lark 图片会下载到本地私有缓存，并作为 Codex `localImage` 输入进入当前轮。
- 收文件/语音：文件和音频会下载到本地私有缓存；文本类文件会附带安全预览，二进制文件和音频先传元信息与本地路径。
- 手动回传：`/codex send <当前项目下的相对文件路径>` 会自动按类型发送，图片走飞书图片消息，`.opus/.mp4` 走音频消息，其他文件走普通文件消息。
- 自动回传：Codex 回复中可包含独立一行隐藏指令 `[[codex-feishu-send:relative/path/from/workspace]]`，桥会上传该文件并从飞书发出，同时从展示文本中移除指令。

## 开发检查

```sh
npm run check
npm run test:media
npm run test:directives
npm run privacy:scan
npm audit --omit=dev
npm pack --dry-run
```

## License

MIT

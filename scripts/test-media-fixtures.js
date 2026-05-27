#!/usr/bin/env node

const assert = require("assert");
const { FeishuClientAdapter } = require("../src/infra/feishu/client-adapter");
const { normalizeFeishuTextEvent } = require("../src/presentation/message/normalizers");
const dispatcher = require("../src/app/dispatcher");
const { handleManualAttachmentDirectives } = require("../src/app/dispatcher");
const {
  classifyLocalAttachment,
  inferFeishuFileType,
  isSafeTextFile,
} = require("../src/shared/media-types");

async function main() {
  testMediaClassification();
  testNonTextNormalizers();
  testPassthroughDecision();
  await testManualDirectiveEntryBehavior();
  await testFeishuAdapterResources();
  await testMergeForwardExpansion();
  await testMergeForwardExpansionFallbackNote();
  await testMergeForwardRecoveryAfterHookRewrite();
  await testMergeForwardRecoveryWhenHookDropsMessageType();
  await testWrappedMergeForwardEventCompatibility();
  await testDirectModeWrappedMergeForwardExpansion();
  console.log("media fixtures ok");
}

function testMediaClassification() {
  assert.strictEqual(classifyLocalAttachment("out.png"), "image");
  assert.strictEqual(classifyLocalAttachment("voice.opus"), "audio");
  assert.strictEqual(classifyLocalAttachment("voice.mp4"), "audio");
  assert.strictEqual(classifyLocalAttachment("notes.md"), "file");
  assert.strictEqual(inferFeishuFileType("voice.opus"), "opus");
  assert.strictEqual(inferFeishuFileType("clip.mp4"), "mp4");
  assert.strictEqual(inferFeishuFileType("paper.pdf"), "pdf");
  assert.strictEqual(inferFeishuFileType("notes.md"), "stream");
  assert.strictEqual(isSafeTextFile("notes.md"), true);
  assert.strictEqual(isSafeTextFile("archive.zip"), false);
}

function testPassthroughDecision() {
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "message",
  }, {}), true);
  assert.strictEqual(dispatcher.isThinBridgeMode({}), true);
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "image_message",
  }, {}), true);
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "attachment_message",
  }, {}), true);
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "bind",
  }, {}), false);
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "message",
  }, {
    bridgePassthroughToCodex: false,
  }), true);
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "message",
  }, {
    bridgeMode: "standard",
    bridgePassthroughToCodex: false,
  }), false);
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "message",
  }, {
    bridgeMode: "thin",
    bridgePassthroughToCodex: false,
  }), true);
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "goal",
  }, {
    bridgeMode: "direct",
  }), true);
  assert.strictEqual(dispatcher.shouldPassthroughToCodex({
    command: "unsupported_message",
  }, {
    bridgeMode: "direct",
  }), true);
  assert.strictEqual(dispatcher.coerceThinModeCommandToMessage({
    command: "goal",
    text: "/goal keep context in Codex",
  }, {
    bridgeMode: "thin",
  }).command, "goal");
  assert.strictEqual(dispatcher.coerceThinModeCommandToMessage({
    command: "appointment",
    text: "/预约 明天三点沟通",
  }, {
    bridgeMode: "thin",
  }).command, "appointment");
  assert.strictEqual(dispatcher.coerceThinModeCommandToMessage({
    command: "plugin",
    text: "/codex plugin list",
  }, {
    bridgeMode: "thin",
  }).command, "message");
  assert.strictEqual(dispatcher.coerceThinModeCommandToMessage({
    command: "bind",
    text: "/codex bind /srv/project",
  }, {
    bridgeMode: "thin",
  }).command, "bind");
}

function testNonTextNormalizers() {
  const config = { defaultWorkspaceId: "default" };
  const sender = { sender_id: { open_id: "ou_test" } };

  const image = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "image",
      chat_id: "oc_test",
      message_id: "om_image",
      content: JSON.stringify({ image_key: "img_key" }),
    },
  }, config);
  assert.strictEqual(image.command, "image_message");
  assert.deepStrictEqual(image.attachments[0], {
    kind: "image",
    resourceKey: "img_key",
    resourceType: "image",
  });

  const richImage = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "post",
      chat_id: "oc_test",
      message_id: "om_post",
      content: JSON.stringify({
        post: {
          zh_cn: {
            content: [[
              { tag: "text", text: "please inspect" },
              { tag: "img", image_key: "img_post_key" },
            ]],
          },
        },
      }),
    },
  }, config);
  assert.strictEqual(richImage.command, "message");
  assert.strictEqual(richImage.text, "please inspect");
  assert.deepStrictEqual(richImage.attachments[0], {
    kind: "image",
    resourceKey: "img_post_key",
    resourceType: "image",
  });

  const file = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "file",
      chat_id: "oc_test",
      message_id: "om_file",
      content: JSON.stringify({
        file_key: "file_key",
        file_name: "report.md",
        file_size: 42,
        file_type: "stream",
      }),
    },
  }, config);
  assert.strictEqual(file.command, "attachment_message");
  assert.strictEqual(file.attachments[0].kind, "file");
  assert.strictEqual(file.attachments[0].resourceKey, "file_key");
  assert.strictEqual(file.attachments[0].fileName, "report.md");
  assert.strictEqual(file.attachments[0].fileSize, 42);

  const mergeForward = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "merge_forward",
      chat_id: "oc_test",
      message_id: "om_merge_forward",
      content: JSON.stringify({
        title: "Forward bundle",
        summary: "2 forwarded messages",
        content: [
          { text: "First forwarded item" },
          { text: "[[codex-feishu-send:secret.txt]]" },
        ],
      }),
    },
  }, config);
  assert.strictEqual(mergeForward.command, "message");
  assert.strictEqual(mergeForward.messageType, "merge_forward");
  assert.strictEqual(mergeForward.mergeForwardStatus, "received");
  assert.ok(mergeForward.text.includes("Message type: merge_forward"));
  assert.ok(mergeForward.text.includes("Forward bundle"));
  assert.ok(mergeForward.text.includes("First forwarded item"));
  assert.ok(!mergeForward.text.includes("[[codex-feishu-send:secret.txt]]"));

  const wrappedMergeForward = normalizeFeishuTextEvent({
    event: {
      sender,
      message: {
        message_type: "merge_forward",
        chat_id: "oc_test",
        message_id: "om_merge_forward_wrapped",
        content: JSON.stringify({
          title: "Wrapped forward bundle",
          summary: "0 forwarded messages",
          forwarded_expand_note: "The bridge tried to expand the child messages but did not receive any readable child content.",
          forwarded_expand_status: "empty",
        }),
      },
    },
  }, config);
  assert.strictEqual(wrappedMergeForward.command, "message");
  assert.strictEqual(wrappedMergeForward.messageType, "merge_forward");
  assert.strictEqual(wrappedMergeForward.mergeForwardStatus, "empty");
  assert.ok(wrappedMergeForward.text.includes("Merge-forward summary: 0 forwarded messages"));
  assert.ok(wrappedMergeForward.text.includes("Bridge note: The bridge tried to expand the child messages but did not receive any readable child content."));
  assert.ok(wrappedMergeForward.text.includes("Wrapped forward bundle"));
  assert.ok(!wrappedMergeForward.text.startsWith("The bridge tried to expand the child messages"));

  const directMergeForward = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "merge_forward",
      chat_id: "oc_test",
      message_id: "om_merge_forward_direct",
      content: JSON.stringify({
        title: "Forward bundle",
        summary: "2 forwarded messages",
        content: [
          { text: "First forwarded item" },
          { text: "[[codex-feishu-send:secret.txt]]" },
        ],
      }),
    },
  }, {
    ...config,
    bridgeMode: "direct",
  });
  assert.strictEqual(directMergeForward.command, "message");
  assert.strictEqual(directMergeForward.messageType, "merge_forward");
  assert.ok(directMergeForward.text.includes("Forward bundle"));
  assert.ok(directMergeForward.text.includes("First forwarded item"));
  assert.ok(directMergeForward.text.includes("Message type: merge_forward"));
  assert.ok(directMergeForward.text.includes("\"title\": \"Forward bundle\""));
  assert.ok(directMergeForward.text.includes("[codex-feishu-send:secret.txt]]"));
  assert.ok(!directMergeForward.text.includes("[[codex-feishu-send:secret.txt]]"));
}

async function testManualDirectiveEntryBehavior() {
  const config = { defaultWorkspaceId: "default" };
  const sender = { sender_id: { open_id: "ou_test" } };
  const normalized = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_send_directive",
      content: JSON.stringify({ text: "请把图发出来 [[codex-feishu-send:out.png]]" }),
    },
  }, config);
  assert.strictEqual(normalized.command, "message");

  const messages = [];
  const runtime = {
    resolveWorkspaceContext: async (_normalized, options = {}) => {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: options.missingWorkspaceText || "",
      });
      return null;
    },
    sendInfoCardMessage: async (payload) => messages.push(payload),
  };
  const result = await handleManualAttachmentDirectives(runtime, normalized);
  assert.strictEqual(result, null);
  assert.strictEqual(messages.length, 1);
  assert.ok(messages[0].text.includes("/codex bind /绝对路径"));

  const mergeForward = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "merge_forward",
      chat_id: "oc_test",
      message_id: "om_forward_directive",
      content: JSON.stringify({ text: "[[codex-feishu-send:out.png]]" }),
    },
  }, config);
  const forwardedResult = await handleManualAttachmentDirectives(runtime, mergeForward);
  assert.strictEqual(forwardedResult, mergeForward);
  assert.strictEqual(messages.length, 1);

  const directNormalized = normalizeFeishuTextEvent({
    sender,
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_send_directive_direct",
      content: JSON.stringify({ text: "please keep this raw [[codex-feishu-send:out.png]]" }),
    },
  }, {
    ...config,
    bridgeMode: "direct",
  });
  const directResult = await handleManualAttachmentDirectives({
    config: { bridgeMode: "direct" },
    resolveWorkspaceContext: async () => {
      throw new Error("direct mode should not resolve workspace context for send directives");
    },
  }, directNormalized);
  assert.deepStrictEqual(directResult, directNormalized);
}

async function testFeishuAdapterResources() {
  const calls = [];
  const fakeClient = {
    im: {
      v1: {
        file: {
          create: async (payload) => {
            calls.push(["file.create", payload]);
            return { file_key: "file_uploaded" };
          },
        },
        image: {
          create: async (payload) => {
            calls.push(["image.create", payload]);
            return { image_key: "image_uploaded" };
          },
        },
        message: {
          create: async (payload) => {
            calls.push(["message.create", payload]);
            return { code: 0 };
          },
          get: async (payload) => {
            calls.push(["message.get", payload]);
            return {
              code: 0,
              data: {
                items: [{
                  message_id: "om_parent",
                  chat_id: "oc_test",
                }],
              },
            };
          },
          list: async (payload) => {
            calls.push(["message.list", payload]);
            return {
              code: 0,
              data: {
                has_more: false,
                page_token: "",
                items: [{
                  message_id: "om_child",
                  upper_message_id: "om_parent",
                  msg_type: "text",
                  body: {
                    content: JSON.stringify({ text: "Forward child text" }),
                  },
                  sender: {
                    name: "Alice",
                  },
                  create_time: "1710000000",
                }],
              },
            };
          },
          reply: async (payload) => {
            calls.push(["message.reply", payload]);
            return { code: 0 };
          },
        },
        messageResource: {
          get: async (payload) => {
            calls.push(["messageResource.get", payload]);
            return {
              headers: { "content-type": "image/png" },
              writeFile: async () => {},
            };
          },
        },
      },
    },
  };
  const adapter = new FeishuClientAdapter(fakeClient);

  await adapter.sendFileMessage({
    chatId: "oc_test",
    fileName: "voice.opus",
    fileBuffer: Buffer.from("audio"),
    fileType: "opus",
    msgType: "audio",
  });
  assert.strictEqual(calls[0][0], "file.create");
  assert.strictEqual(calls[0][1].data.file_type, "opus");
  assert.strictEqual(calls[1][1].data.msg_type, "audio");
  assert.strictEqual(calls[1][1].data.content, JSON.stringify({ file_key: "file_uploaded" }));

  await adapter.sendImageMessage({
    chatId: "oc_test",
    imageBuffer: Buffer.from("image"),
    replyToMessageId: "om_parent:extra",
  });
  assert.strictEqual(calls[2][0], "image.create");
  assert.strictEqual(calls[2][1].data.image_type, "message");
  assert.strictEqual(calls[3][0], "message.reply");
  assert.strictEqual(calls[3][1].path.message_id, "om_parent");
  assert.strictEqual(calls[3][1].data.msg_type, "image");
  assert.strictEqual(calls[3][1].data.content, JSON.stringify({ image_key: "image_uploaded" }));

  const downloaded = await adapter.downloadMessageResource({
    messageId: "om_image:extra",
    fileKey: "img_key",
    type: "image",
  });
  assert.strictEqual(downloaded.headers["content-type"], "image/png");
  assert.strictEqual(calls[4][0], "messageResource.get");
  assert.strictEqual(calls[4][1].path.message_id, "om_image");
  assert.strictEqual(calls[4][1].path.file_key, "img_key");
  assert.strictEqual(calls[4][1].params.type, "image");

  const fetchedMessage = await adapter.getMessage({ messageId: "om_parent:extra" });
  assert.strictEqual(calls[5][0], "message.get");
  assert.strictEqual(calls[5][1].path.message_id, "om_parent");
  assert.strictEqual(fetchedMessage[0].chat_id, "oc_test");

  const listedMessages = await adapter.listMessages({
    containerIdType: "chat",
    containerId: "oc_test",
  });
  assert.strictEqual(calls[6][0], "message.list");
  assert.strictEqual(calls[6][1].params.container_id_type, "chat");
  assert.strictEqual(calls[6][1].params.container_id, "oc_test");
  assert.strictEqual(listedMessages.items[0].upper_message_id, "om_parent");
}

async function testMergeForwardExpansion() {
  const fakeAdapter = {
    async getMessage() {
      return [{
        message_id: "om_merge_forward",
        chat_id: "oc_test",
      }];
    },
    async listMessages() {
      return {
        hasMore: false,
        pageToken: "",
        items: [
          {
            message_id: "om_child_1",
            upper_message_id: "om_merge_forward",
            msg_type: "text",
            body: {
              content: JSON.stringify({ text: "First forwarded text" }),
            },
            sender: { name: "Alice" },
            create_time: "1710000000",
          },
          {
            message_id: "om_child_2",
            upper_message_id: "om_merge_forward",
            msg_type: "post",
            body: {
              content: JSON.stringify({
                post: {
                  zh_cn: {
                    content: [[
                      { tag: "text", text: "Second forwarded text" },
                    ]],
                  },
                },
              }),
            },
            sender: { name: "Bob" },
            create_time: "1710000300",
          },
        ],
      };
    },
  };
  const runtime = {
    config: { defaultWorkspaceId: "default" },
    requireFeishuAdapter() {
      return fakeAdapter;
    },
  };
  const event = {
    sender: { sender_id: { open_id: "ou_test" } },
    message: {
      message_type: "merge_forward",
      chat_id: "oc_test",
      message_id: "om_merge_forward",
      content: JSON.stringify({
        title: "Forward bundle",
        summary: "2 forwarded messages",
      }),
    },
  };

  const expanded = await dispatcher.expandMergeForwardEvent(runtime, event);
  const normalized = normalizeFeishuTextEvent(expanded, runtime.config);
  assert.strictEqual(normalized.command, "message");
  assert.strictEqual(normalized.messageType, "merge_forward");
  assert.ok(normalized.text.includes("Forwarded item (text)"));
  assert.ok(normalized.text.includes("First forwarded text"));
  assert.ok(normalized.text.includes("Second forwarded text"));
  assert.ok(normalized.text.includes("Sender: Alice"));
}

async function testMergeForwardExpansionFallbackNote() {
  const runtime = {
    config: { defaultWorkspaceId: "default" },
    requireFeishuAdapter() {
      return {
        async getMessage() {
          return [{
            message_id: "om_merge_forward",
            chat_id: "oc_test",
          }];
        },
        async listMessages() {
          return {
            hasMore: false,
            pageToken: "",
            items: [],
          };
        },
      };
    },
  };
  const event = {
    sender: { sender_id: { open_id: "ou_test" } },
    message: {
      message_type: "merge_forward",
      chat_id: "oc_test",
      message_id: "om_merge_forward",
      content: JSON.stringify({
        title: "Forward bundle",
        summary: "0 forwarded messages",
      }),
    },
  };

  const expanded = await dispatcher.expandMergeForwardEvent(runtime, event);
  const normalized = normalizeFeishuTextEvent(expanded, runtime.config);
  assert.strictEqual(normalized.command, "message");
  assert.strictEqual(normalized.mergeForwardStatus, "empty");
  assert.ok(normalized.text.includes("bridge tried to expand the child messages"));
  assert.ok(normalized.text.includes("Merge-forward summary: 0 forwarded messages"));
  assert.ok(normalized.text.includes("resend the original text or files directly"));
}

async function testMergeForwardRecoveryAfterHookRewrite() {
  const sentInfoCards = [];
  const sentMessages = [];
  const runtime = {
    config: { defaultWorkspaceId: "default" },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    async runBeforeMessageHook({ normalized }) {
      return {
        ...normalized,
        command: "unsupported_message",
        text: "",
        unsupportedMessageType: "merge_forward",
      };
    },
    async dispatchTextCommand() {
      return false;
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
    async ensureThreadAndSendMessage({ normalized }) {
      sentMessages.push(normalized);
      return "thread_merge_forward";
    },
    async sendInfoCardMessage(payload) {
      sentInfoCards.push(payload);
    },
  };
  const event = {
    sender: { sender_id: { open_id: "ou_test" } },
    message: {
      message_type: "merge_forward",
      chat_id: "oc_test",
      message_id: "om_merge_forward_recovery",
      content: JSON.stringify({
        title: "Forward bundle",
        summary: "1 forwarded message",
      }),
    },
  };

  await dispatcher.onFeishuTextEvent(runtime, event);
  assert.strictEqual(sentInfoCards.length, 0);
  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].command, "message");
  assert.strictEqual(sentMessages[0].messageType, "merge_forward");
  assert.ok(sentMessages[0].text.includes("Forward bundle"));
}

async function testMergeForwardRecoveryWhenHookDropsMessageType() {
  const sentInfoCards = [];
  const sentMessages = [];
  const runtime = {
    config: { defaultWorkspaceId: "default" },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    async runBeforeMessageHook({ normalized }) {
      return {
        ...normalized,
        command: "unsupported_message",
        messageType: "",
        text: "",
        unsupportedMessageType: "merge_forward",
      };
    },
    async dispatchTextCommand() {
      return false;
    },
    getCurrentThreadContext() {
      return { bindingKey: "binding_merge_forward_2", workspaceRoot: "", threadId: "" };
    },
    async resolveWorkspaceThreadState() {
      throw new Error("should not resolve workspace thread state");
    },
    setPendingBindingContext() {},
    setPendingThreadContext() {},
    async addPendingReaction() {},
    movePendingReactionToThread() {},
    async clearPendingReactionForBinding() {},
    async ensureThreadAndSendMessage({ normalized }) {
      sentMessages.push(normalized);
      return "thread_merge_forward_2";
    },
    async sendInfoCardMessage(payload) {
      sentInfoCards.push(payload);
    },
  };
  const event = {
    event: {
      sender: { sender_id: { open_id: "ou_test" } },
      message: {
        message_type: "merge_forward",
        chat_id: "oc_test",
        message_id: "om_merge_forward_recovery_2",
        content: JSON.stringify({
          title: "Forward bundle 2",
          summary: "0 forwarded messages",
        }),
      },
    },
  };

  await dispatcher.onFeishuTextEvent(runtime, event);
  assert.strictEqual(sentInfoCards.length, 0);
  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].command, "message");
  assert.strictEqual(sentMessages[0].messageType, "merge_forward");
  assert.ok(sentMessages[0].text.includes("Forward bundle 2"));
}

async function testWrappedMergeForwardEventCompatibility() {
  const sentInfoCards = [];
  const sentMessages = [];
  const runtime = {
    config: { defaultWorkspaceId: "default" },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    requireFeishuAdapter() {
      return {
        getMessage: async () => [{ chat_id: "oc_test" }],
        listMessages: async () => [],
      };
    },
    async runBeforeMessageHook({ normalized }) {
      return normalized;
    },
    async dispatchTextCommand() {
      return false;
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
    async ensureThreadAndSendMessage({ normalized }) {
      sentMessages.push(normalized);
      return "thread_wrapped_merge_forward";
    },
    async sendInfoCardMessage(payload) {
      sentInfoCards.push(payload);
    },
  };
  const event = {
    event: {
      sender: { sender_id: { open_id: "ou_test" } },
      message: {
        message_type: "merge_forward",
        chat_id: "oc_test",
        message_id: "om_wrapped_merge_forward",
        content: JSON.stringify({
          title: "Wrapped forward bundle",
          summary: "0 forwarded messages",
        }),
      },
    },
  };

  await dispatcher.onFeishuTextEvent(runtime, event);
  assert.strictEqual(sentInfoCards.length, 0);
  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].command, "message");
  assert.strictEqual(sentMessages[0].messageType, "merge_forward");
  assert.strictEqual(sentMessages[0].mergeForwardStatus, "empty");
  assert.ok(sentMessages[0].text.includes("Wrapped forward bundle"));
  assert.ok(sentMessages[0].text.includes("Bridge note: This is a merged-forwarded Feishu message."));
  assert.ok(!sentMessages[0].text.startsWith("This is a merged-forwarded Feishu message."));
}

async function testDirectModeWrappedMergeForwardExpansion() {
  const sentInfoCards = [];
  const sentMessages = [];
  let adapterRequested = false;
  let beforeHookCalled = false;
  const runtime = {
    config: { defaultWorkspaceId: "default", bridgeMode: "direct" },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    requireFeishuAdapter() {
      adapterRequested = true;
      return {
        getMessage: async () => [{
          message_id: "om_wrapped_merge_forward_direct",
          chat_id: "oc_test",
        }],
        listMessages: async () => ({
          hasMore: false,
          pageToken: "",
          items: [
            {
              message_id: "om_child_direct_1",
              upper_message_id: "om_wrapped_merge_forward_direct",
              msg_type: "text",
              sender: { id: "Alice" },
              create_time: "1779775555184",
              body: {
                content: JSON.stringify({ text: "First forwarded direct item" }),
              },
            },
            {
              message_id: "om_child_direct_2",
              upper_message_id: "om_wrapped_merge_forward_direct",
              msg_type: "post",
              sender: { id: "Bob" },
              create_time: "1779775556184",
              body: {
                content: JSON.stringify({
                  title: "",
                  content: [[{ tag: "text", text: "Second forwarded direct item" }]],
                }),
              },
            },
          ],
        }),
      };
    },
    async runBeforeMessageHook() {
      beforeHookCalled = true;
      return null;
    },
    async dispatchTextCommand() {
      return false;
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
    async ensureThreadAndSendMessage({ normalized }) {
      sentMessages.push(normalized);
      return "thread_wrapped_merge_forward_direct";
    },
    async sendInfoCardMessage(payload) {
      sentInfoCards.push(payload);
    },
  };
  const event = {
    event: {
      sender: { sender_id: { open_id: "ou_test" } },
      message: {
        message_type: "merge_forward",
        chat_id: "oc_test",
        message_id: "om_wrapped_merge_forward_direct",
        content: JSON.stringify({
          title: "Wrapped forward bundle",
          summary: "2 forwarded messages",
          content: [
            { text: "First forwarded item" },
            { text: "[[codex-feishu-send:secret.txt]]" },
          ],
        }),
      },
    },
  };

  await dispatcher.onFeishuTextEvent(runtime, event);
  assert.strictEqual(adapterRequested, true);
  assert.strictEqual(beforeHookCalled, false);
  assert.strictEqual(sentInfoCards.length, 0);
  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].command, "message");
  assert.strictEqual(sentMessages[0].messageType, "merge_forward");
  assert.strictEqual(sentMessages[0].mergeForwardStatus, "expanded");
  assert.ok(sentMessages[0].text.includes("First forwarded direct item"));
  assert.ok(sentMessages[0].text.includes("Second forwarded direct item"));
  assert.ok(sentMessages[0].text.includes("Message type: merge_forward"));
  assert.ok(sentMessages[0].text.includes("\"title\": \"Wrapped forward bundle\""));
  assert.ok(sentMessages[0].text.includes("[codex-feishu-send:secret.txt]]"));
  assert.ok(!sentMessages[0].text.includes("[[codex-feishu-send:secret.txt]]"));
  assert.ok(!sentMessages[0].text.includes("Bridge note:"));
}

async function testPlainTextPassthroughSkipsBeforeMessageHook() {
  const sentMessages = [];
  let beforeHookCalled = false;
  const runtime = {
    config: { defaultWorkspaceId: "default" },
    activeTurnIdByThreadId: new Map(),
    pendingApprovalByThreadId: new Map(),
    async runBeforeMessageHook() {
      beforeHookCalled = true;
      return null;
    },
    async dispatchTextCommand() {
      return false;
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
    async ensureThreadAndSendMessage({ normalized }) {
      sentMessages.push(normalized);
      return "thread_plain_passthrough";
    },
    async sendInfoCardMessage() {},
  };
  const event = {
    sender: { sender_id: { open_id: "ou_test" } },
    message: {
      message_type: "text",
      chat_id: "oc_test",
      message_id: "om_plain_passthrough",
      content: JSON.stringify({
        text: "这条普通消息应该直接进入 Codex",
      }),
    },
  };

  await dispatcher.onFeishuTextEvent(runtime, event);
  assert.strictEqual(beforeHookCalled, false);
  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].text, "这条普通消息应该直接进入 Codex");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

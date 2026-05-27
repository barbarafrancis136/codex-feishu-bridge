#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  extractSendDirectives,
  handleManualAttachmentDirectives,
  handleOutboundAttachmentDirectives,
  stripSendDirectives,
  stripSendDirectivesForDisplay,
} = require("../src/domain/attachments/outbound-directive-service");

async function main() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-directive-"));
  const attachmentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-directive-attachments-"));
  fs.writeFileSync(path.join(workspaceRoot, "note.txt"), "hello", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "out.png"), Buffer.from("image"));
  fs.writeFileSync(path.join(attachmentsRoot, "snap-only.png"), Buffer.from("snap-image"));
  const originalAttachmentsDir = process.env.CODEX_IM_ATTACHMENTS_DIR;
  process.env.CODEX_IM_ATTACHMENTS_DIR = attachmentsRoot;
  try {

  const sent = [];
  const runtime = {
    sentAttachmentDirectiveKeys: new Set(),
    workspaceRootByThreadId: new Map([["thread-1", workspaceRoot]]),
    resolveWorkspaceRootForThread: () => workspaceRoot,
    sendLocalAttachmentToFeishu: async (payload) => sent.push(payload),
    sendInfoCardMessage: async (payload) => sent.push({ kind: "info", ...payload }),
  };

  const text = "Here is the file.\n[[codex-feishu-send:note.txt]]";
  assert.deepStrictEqual(extractSendDirectives(text), ["note.txt"]);
  assert.strictEqual(stripSendDirectives(text), "Here is the file.");
  assert.strictEqual(stripSendDirectivesForDisplay("Hello [[codex-feishu-send:note.txt]]"), "Hello");
  assert.strictEqual(stripSendDirectivesForDisplay("Hello [[codex-feishu-send:note.txt"), "Hello");

  const result = await handleOutboundAttachmentDirectives(runtime, {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "oc_test",
    text,
  });
  assert.strictEqual(result.text, "Here is the file.");
  assert.strictEqual(result.sent, 1);
  assert.strictEqual(sent[0].fileName, "note.txt");
  assert.strictEqual(sent[0].kind, "file");

  const imageResult = await handleOutboundAttachmentDirectives(runtime, {
    threadId: "thread-1",
    turnId: "turn-2",
    chatId: "oc_test",
    text: "Image\n[[codex-feishu-send:out.png]]",
  });
  assert.strictEqual(imageResult.text, "Image");
  assert.strictEqual(imageResult.sent, 1);
  assert.strictEqual(sent[1].fileName, "out.png");
  assert.strictEqual(sent[1].kind, "image");

  const duplicate = await handleOutboundAttachmentDirectives(runtime, {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "oc_test",
    text,
  });
  assert.strictEqual(duplicate.sent, 0);

  const manual = await handleManualAttachmentDirectives(runtime, {
    messageId: "om_manual_1",
    chatId: "oc_test",
    workspaceRoot,
    text: "[[codex-feishu-send:note.txt]]",
  });
  assert.strictEqual(manual.text, "");
  assert.strictEqual(manual.sent, 1);
  assert.strictEqual(sent[2].fileName, "note.txt");

  const manualMixed = await handleManualAttachmentDirectives(runtime, {
    messageId: "om_manual_2",
    chatId: "oc_test",
    workspaceRoot,
    text: "请把图发出来 [[codex-feishu-send:out.png]]",
  });
  assert.strictEqual(manualMixed.text, "请把图发出来");
  assert.strictEqual(manualMixed.sent, 1);
  assert.strictEqual(sent[3].fileName, "out.png");

  const manualMulti = await handleManualAttachmentDirectives(runtime, {
    messageId: "om_manual_3",
    chatId: "oc_test",
    workspaceRoot,
    text: "[[codex-feishu-send:note.txt]]\n[[codex-feishu-send:out.png]]",
  });
  assert.strictEqual(manualMulti.text, "");
  assert.strictEqual(manualMulti.sent, 2);
  assert.strictEqual(sent[4].fileName, "note.txt");
  assert.strictEqual(sent[5].fileName, "out.png");

  const manualDuplicate = await handleManualAttachmentDirectives(runtime, {
    messageId: "om_manual_3",
    chatId: "oc_test",
    workspaceRoot,
    text: "[[codex-feishu-send:note.txt]]",
  });
  assert.strictEqual(manualDuplicate.sent, 0);

  const escaped = await handleManualAttachmentDirectives(runtime, {
    messageId: "om_manual_4",
    chatId: "oc_test",
    workspaceRoot,
    text: "[[codex-feishu-send:../escape.txt]]",
  });
  assert.strictEqual(escaped.sent, 1);
  assert.strictEqual(sent[6].kind, "info");
  assert.ok(sent[6].text.includes("路径不能跳出当前项目目录"));

  const snapFallback = await handleManualAttachmentDirectives(runtime, {
    messageId: "om_manual_5",
    chatId: "oc_test",
    workspaceRoot,
    text: "[[codex-feishu-send:snap-only.png]]",
  });
  assert.strictEqual(snapFallback.text, "");
  assert.strictEqual(snapFallback.sent, 1);
  assert.strictEqual(sent[7].fileName, "snap-only.png");
  assert.strictEqual(sent[7].kind, "image");

  const dotDirFallback = await handleManualAttachmentDirectives(runtime, {
    messageId: "om_manual_6",
    chatId: "oc_test",
    workspaceRoot,
    text: "[[codex-feishu-send:.codex-feishu-attachments/snap-only.png]]",
  });
  assert.strictEqual(dotDirFallback.text, "");
  assert.strictEqual(dotDirFallback.sent, 1);
  assert.strictEqual(sent[8].fileName, "snap-only.png");
  assert.strictEqual(sent[8].kind, "image");

  fs.writeFileSync(path.join(attachmentsRoot, "snap-out.png"), Buffer.from("snap-out-image"));
  const feishuOutDir = path.join(path.dirname(attachmentsRoot), "feishu-out");
  fs.mkdirSync(feishuOutDir, { recursive: true });
  fs.writeFileSync(path.join(feishuOutDir, "cloud-only.png"), Buffer.from("cloud-only-image"));

  const feishuOutFallback = await handleManualAttachmentDirectives(runtime, {
    messageId: "om_manual_7",
    chatId: "oc_test",
    workspaceRoot,
    text: "[[codex-feishu-send:feishu-out/cloud-only.png]]",
  });
  assert.strictEqual(feishuOutFallback.text, "");
  assert.strictEqual(feishuOutFallback.sent, 1);
  assert.strictEqual(sent[9].fileName, "cloud-only.png");
  assert.strictEqual(sent[9].kind, "image");

    console.log("outbound directive fixtures ok");
  } finally {
    if (originalAttachmentsDir) {
      process.env.CODEX_IM_ATTACHMENTS_DIR = originalAttachmentsDir;
    } else {
      delete process.env.CODEX_IM_ATTACHMENTS_DIR;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

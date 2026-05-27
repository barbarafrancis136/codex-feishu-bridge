#!/usr/bin/env node

const assert = require("assert");
const path = require("path");
const {
  buildAttachmentReceiptText,
  createAttachmentReceipt,
  markAttachmentReceiptCached,
  markAttachmentReceiptDelivered,
  markAttachmentReceiptFailure,
} = require("../src/domain/attachments/attachment-service");
const { resolveAttachmentsDir } = require("../src/infra/config/config");

function main() {
  testImageReceiptLifecycle();
  testFailureReceipt();
  testSnapAttachmentDirFallback();
  console.log("attachment receipt ok");
}

function testImageReceiptLifecycle() {
  const normalized = {
    command: "image_message",
    attachments: [
      {
        kind: "image",
        resourceKey: "img_123",
        resourceType: "image",
        fileName: "chart.png",
      },
    ],
  };

  const initial = createAttachmentReceipt(normalized, { expectedKind: "image" });
  assert.strictEqual(initial.subject, "图片");
  assert.strictEqual(initial.stages.received.status, "success");
  assert.strictEqual(initial.stages.cached.status, "pending");
  assert.strictEqual(initial.stages.delivered.status, "pending");

  const cached = markAttachmentReceiptCached(initial, [{
    kind: "image",
    resourceKey: "img_123",
    fileName: "chart.png",
    filePath: path.join("/tmp", "chart.png"),
    size: 123,
    contentType: "image/png",
  }]);
  assert.strictEqual(cached.stages.cached.status, "success");
  assert.ok(cached.stages.cached.detail.includes("当前实例可读"));

  const delivered = markAttachmentReceiptDelivered(cached);
  assert.strictEqual(delivered.stages.delivered.status, "success");
  const text = buildAttachmentReceiptText(delivered);
  assert.ok(text.includes("图片已接收：成功"));
  assert.ok(text.includes("图片已落盘：成功"));
  assert.ok(text.includes("图片已送入 Codex：成功"));
  assert.ok(text.includes("localImage"));
}

function testFailureReceipt() {
  const normalized = {
    command: "attachment_message",
    attachments: [
      {
        kind: "file",
        resourceKey: "file_1",
        fileName: "report.md",
      },
    ],
  };
  const initial = createAttachmentReceipt(normalized, {});
  const failed = markAttachmentReceiptFailure(initial, {
    stage: "cached",
    detail: "附件下载失败。",
    error: new Error("download failed"),
  });
  assert.strictEqual(failed.stages.cached.status, "failed");
  assert.strictEqual(failed.stages.delivered.status, "pending");
  const text = buildAttachmentReceiptText(failed);
  assert.ok(text.includes("文件已接收：成功"));
  assert.ok(text.includes("文件已落盘：失败"));
  assert.ok(text.includes("文件已送入 Codex：未开始"));
  assert.ok(text.includes("download failed"));
}

function testSnapAttachmentDirFallback() {
  const original = process.env.CODEX_IM_ATTACHMENTS_DIR;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = path.join(__dirname, "..", ".tmp-test-home");
  const snapCommon = path.join(tempHome, "snap", "codex", "common");
  try {
    delete process.env.CODEX_IM_ATTACHMENTS_DIR;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    require("fs").mkdirSync(snapCommon, { recursive: true });
    const resolved = resolveAttachmentsDir();
    assert.strictEqual(resolved, path.join(snapCommon, ".codex-feishu-attachments"));
  } finally {
    if (original) {
      process.env.CODEX_IM_ATTACHMENTS_DIR = original;
    } else {
      delete process.env.CODEX_IM_ATTACHMENTS_DIR;
    }
    if (originalHome) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    if (originalUserProfile) {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
  }
}

main();

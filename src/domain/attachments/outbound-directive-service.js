const fs = require("fs");
const path = require("path");
const {
  classifyLocalAttachment,
  inferFeishuFileType,
} = require("../../shared/media-types");
const {
  isAbsoluteWorkspacePath,
  normalizeWorkspacePath,
  pathMatchesWorkspaceRoot,
} = require("../../shared/workspace-paths");

const SEND_DIRECTIVE_RE = /\[\[codex-feishu-send:([^\]\n]+)\]\]/g;
const LEGACY_SEND_DIRECTIVE_RE = /\[\[yuan-feishu-send:([^\]\n]+)\]\]/g;
const DISPLAY_PARTIAL_SEND_DIRECTIVE_RE = /\[\[(?:codex-feishu-send|yuan-feishu-send):[^\]]*$/g;
const MAX_FEISHU_UPLOAD_FILE_BYTES = 30 * 1024 * 1024;
const MAX_FEISHU_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

async function handleOutboundAttachmentDirectives(runtime, {
  threadId = "",
  turnId = "",
  chatId = "",
  text = "",
} = {}) {
  const workspaceRoot = runtime.resolveWorkspaceRootForThread(threadId)
    || runtime.workspaceRootByThreadId.get(threadId)
    || "";
  const directives = extractSendDirectives(text);
  if (!directives.length || !workspaceRoot || !chatId) {
    return { text: stripSendDirectives(text), sent: 0 };
  }

  let sent = 0;
  for (const requestedPath of directives) {
    sent += await sendWorkspaceAttachmentOnce(runtime, {
      dedupeKey: `assistant:${threadId}:${turnId}:${requestedPath}`,
      chatId,
      workspaceRoot,
      requestedPath,
    });
  }
  return { text: stripSendDirectives(text), sent };
}

async function handleManualAttachmentDirectives(runtime, {
  messageId = "",
  chatId = "",
  workspaceRoot = "",
  text = "",
} = {}) {
  const directives = extractSendDirectives(text);
  if (!directives.length || !workspaceRoot || !chatId) {
    return { text: stripSendDirectives(text), sent: 0 };
  }

  let sent = 0;
  for (const requestedPath of directives) {
    sent += await sendWorkspaceAttachmentOnce(runtime, {
      dedupeKey: `manual:${messageId}:${requestedPath}`,
      chatId,
      workspaceRoot,
      requestedPath,
    });
  }
  return { text: stripSendDirectives(text), sent };
}

function extractSendDirectives(text) {
  return [
    ...extractSendDirectivesWithRegex(text, SEND_DIRECTIVE_RE),
    ...extractSendDirectivesWithRegex(text, LEGACY_SEND_DIRECTIVE_RE),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function extractSendDirectivesWithRegex(text, regex) {
  const result = [];
  const source = String(text || "");
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(source))) {
    const requestedPath = String(match[1] || "").trim();
    if (requestedPath) {
      result.push(requestedPath);
    }
  }
  return result;
}

function stripSendDirectives(text) {
  return String(text || "")
    .replace(SEND_DIRECTIVE_RE, "")
    .replace(LEGACY_SEND_DIRECTIVE_RE, "")
    .trim();
}

function stripSendDirectivesForDisplay(text) {
  return String(text || "")
    .replace(SEND_DIRECTIVE_RE, "")
    .replace(LEGACY_SEND_DIRECTIVE_RE, "")
    .replace(DISPLAY_PARTIAL_SEND_DIRECTIVE_RE, "")
    .trim();
}

async function sendWorkspaceAttachment(runtime, { chatId, workspaceRoot, requestedPath }) {
  const resolved = await resolveWorkspaceSendTarget(runtime, workspaceRoot, requestedPath);
  if (resolved.errorText) {
    await runtime.sendInfoCardMessage({
      chatId,
      text: `附件发送指令无效：${resolved.errorText}`,
    });
    return;
  }

  const stats = await fs.promises.stat(resolved.filePath);
  if (!stats.isFile()) {
    await runtime.sendInfoCardMessage({
      chatId,
      text: `附件发送失败：只支持文件，不支持目录: ${resolved.displayPath}`,
    });
    return;
  }
  if (stats.size <= 0) {
    await runtime.sendInfoCardMessage({
      chatId,
      text: `附件发送失败：文件为空: ${resolved.displayPath}`,
    });
    return;
  }
  const kind = classifyLocalAttachment(resolved.filePath);
  const maxBytes = kind === "image" ? MAX_FEISHU_UPLOAD_IMAGE_BYTES : MAX_FEISHU_UPLOAD_FILE_BYTES;
  if (stats.size > maxBytes) {
    await runtime.sendInfoCardMessage({
      chatId,
      text: `附件发送失败：文件过大: ${resolved.displayPath}`,
    });
    return;
  }

  await runtime.sendLocalAttachmentToFeishu({
    kind,
    chatId,
    fileName: path.basename(resolved.filePath),
    fileBuffer: await fs.promises.readFile(resolved.filePath),
    fileType: inferFeishuFileType(resolved.filePath),
    msgType: kind === "audio" ? "audio" : "file",
  });
}

async function sendWorkspaceAttachmentOnce(runtime, {
  dedupeKey = "",
  chatId,
  workspaceRoot,
  requestedPath,
}) {
  if (dedupeKey && runtime.sentAttachmentDirectiveKeys.has(dedupeKey)) {
    return 0;
  }
  if (dedupeKey) {
    runtime.sentAttachmentDirectiveKeys.add(dedupeKey);
  }
  await sendWorkspaceAttachment(runtime, {
    chatId,
    workspaceRoot,
    requestedPath,
  });
  return 1;
}

async function resolveWorkspaceSendTarget(runtime, workspaceRoot, requestedPath) {
  const normalizedInput = normalizeWorkspacePath(requestedPath);
  if (!normalizedInput) {
    return { errorText: "缺少相对路径。" };
  }
  if (isAbsoluteWorkspacePath(normalizedInput)) {
    return { errorText: "只支持当前项目下的相对路径，不支持绝对路径。" };
  }
  const workspaceFilePath = path.resolve(workspaceRoot, requestedPath);
  if (!pathMatchesWorkspaceRoot(workspaceFilePath, workspaceRoot)) {
    return { errorText: "路径不能跳出当前项目目录。" };
  }
  return resolveWorkspaceSendTargetWithFallback(runtime, workspaceRoot, requestedPath, workspaceFilePath);
}

async function resolveWorkspaceSendTargetWithFallback(runtime, workspaceRoot, requestedPath, workspaceFilePath) {
  if (await isExistingFile(workspaceFilePath)) {
    return {
      filePath: workspaceFilePath,
      displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, workspaceFilePath)) || requestedPath,
    };
  }

  const attachmentsDir = normalizeWorkspacePath(
    runtime?.config?.attachmentsDir || process.env.CODEX_IM_ATTACHMENTS_DIR || ""
  );
  if (!attachmentsDir) {
    return {
      filePath: workspaceFilePath,
      displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, workspaceFilePath)) || requestedPath,
    };
  }

  for (const fallbackRoot of buildAttachmentFallbackRoots(attachmentsDir)) {
    for (const candidatePath of buildAttachmentFallbackCandidates(requestedPath, fallbackRoot.rootDir, fallbackRoot.prefixes)) {
      const attachmentsFilePath = path.resolve(fallbackRoot.rootDir, candidatePath);
      if (!pathMatchesWorkspaceRoot(attachmentsFilePath, fallbackRoot.rootDir)) {
        continue;
      }
      if (await isExistingFile(attachmentsFilePath)) {
        return {
          filePath: attachmentsFilePath,
          displayPath: normalizeWorkspacePath(path.relative(fallbackRoot.rootDir, attachmentsFilePath)) || candidatePath,
        };
      }
    }
  }

  return {
    filePath: workspaceFilePath,
    displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, workspaceFilePath)) || requestedPath,
  };
}

function buildAttachmentFallbackRoots(attachmentsDir) {
  const normalizedAttachmentsDir = normalizeWorkspacePath(attachmentsDir);
  const roots = [];
  if (!normalizedAttachmentsDir) {
    return roots;
  }

  pushAttachmentFallbackRoot(roots, normalizedAttachmentsDir, [
    path.posix.basename(normalizedAttachmentsDir),
    ".codex-feishu-attachments",
  ]);

  const siblingFeishuOutDir = normalizeWorkspacePath(path.posix.join(path.posix.dirname(normalizedAttachmentsDir), "feishu-out"));
  if (siblingFeishuOutDir && siblingFeishuOutDir !== normalizedAttachmentsDir) {
    pushAttachmentFallbackRoot(roots, siblingFeishuOutDir, [
      path.posix.basename(siblingFeishuOutDir),
      "feishu-out",
    ]);
  }

  return roots;
}

function pushAttachmentFallbackRoot(target, rootDir, prefixes = []) {
  const normalizedRootDir = normalizeWorkspacePath(rootDir);
  if (!normalizedRootDir) {
    return;
  }
  if (target.some((item) => item.rootDir === normalizedRootDir)) {
    return;
  }
  const normalizedPrefixes = [];
  for (const prefix of prefixes) {
    const normalizedPrefix = normalizeWorkspacePath(prefix);
    if (normalizedPrefix && !normalizedPrefixes.includes(normalizedPrefix)) {
      normalizedPrefixes.push(normalizedPrefix);
    }
  }
  target.push({
    rootDir: normalizedRootDir,
    prefixes: normalizedPrefixes,
  });
}

function buildAttachmentFallbackCandidates(requestedPath, rootDir, extraPrefixes = []) {
  const normalizedRequestedPath = normalizeWorkspacePath(requestedPath);
  const requestedWithoutDotPrefix = normalizedRequestedPath.replace(/^\.\//, "");
  const rootDirName = path.posix.basename(normalizeWorkspacePath(rootDir));
  const prefixCandidates = [
    rootDirName,
    ...extraPrefixes,
  ].filter(Boolean);
  const candidates = [];

  pushUniqueCandidate(candidates, normalizedRequestedPath);
  pushUniqueCandidate(candidates, requestedWithoutDotPrefix);

  for (const prefix of prefixCandidates) {
    const matchers = [`${prefix}/`, `./${prefix}/`];
    for (const matcher of matchers) {
      if (normalizedRequestedPath.startsWith(matcher)) {
        pushUniqueCandidate(candidates, normalizedRequestedPath.slice(matcher.length));
      }
      if (requestedWithoutDotPrefix.startsWith(matcher)) {
        pushUniqueCandidate(candidates, requestedWithoutDotPrefix.slice(matcher.length));
      }
    }
  }

  return candidates.filter(Boolean);
}

function pushUniqueCandidate(target, value) {
  const normalizedValue = normalizeWorkspacePath(value);
  if (normalizedValue && !target.includes(normalizedValue)) {
    target.push(normalizedValue);
  }
}

async function isExistingFile(targetPath) {
  try {
    const stats = await fs.promises.stat(targetPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

module.exports = {
  extractSendDirectives,
  handleManualAttachmentDirectives,
  handleOutboundAttachmentDirectives,
  sendWorkspaceAttachment,
  stripSendDirectives,
  stripSendDirectivesForDisplay,
};

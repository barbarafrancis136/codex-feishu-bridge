const path = require("path");

const IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const FEISHU_AUDIO_EXTENSIONS = new Set([
  ".mp4",
  ".opus",
]);

function classifyLocalAttachment(filePath) {
  const ext = getLowerExtension(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (FEISHU_AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  return "file";
}

function inferFeishuFileType(filePath) {
  const ext = getLowerExtension(filePath);
  if (ext === ".opus") {
    return "opus";
  }
  if (ext === ".mp4") {
    return "mp4";
  }
  if (ext === ".pdf") {
    return "pdf";
  }
  if (ext === ".doc" || ext === ".docx") {
    return "doc";
  }
  if (ext === ".xls" || ext === ".xlsx" || ext === ".csv") {
    return "xls";
  }
  if (ext === ".ppt" || ext === ".pptx") {
    return "ppt";
  }
  return "stream";
}

function getLowerExtension(filePath) {
  return path.extname(String(filePath || "")).toLowerCase();
}

module.exports = {
  FEISHU_AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  classifyLocalAttachment,
  inferFeishuFileType,
};

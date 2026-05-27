"use strict";

const fs = require("fs");
const path = require("path");

function loadPromptAsset(filePath = process.env.PROMPT_ASSET_FILE) {
  if (!filePath) {
    return "";
  }
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

module.exports = { loadPromptAsset };

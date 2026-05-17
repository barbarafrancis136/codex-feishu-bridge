const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET_DIRS = ["src", "bin", "scripts"];

function main() {
  const files = TARGET_DIRS
    .map((dir) => path.join(ROOT, dir))
    .flatMap((dir) => walkJsFiles(dir));

  if (!files.length) {
    console.log("[check] no JavaScript files found");
    return;
  }

  let failed = false;
  for (const filePath of files) {
    const result = spawnSync(process.execPath, ["--check", filePath], {
      stdio: "inherit",
      shell: false,
    });
    if ((result.status || 0) !== 0) {
      failed = true;
      console.error(`[check] syntax failed: ${path.relative(ROOT, filePath)}`);
    }
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log(`[check] syntax ok (${files.length} files)`);
}

function walkJsFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const result = [];
  walk(dirPath, result);
  return result;
}

function walk(currentPath, result) {
  const stat = fs.statSync(currentPath);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      walk(path.join(currentPath, entry.name), result);
    }
    return;
  }

  if (stat.isFile() && currentPath.endsWith(".js")) {
    result.push(currentPath);
  }
}

main();
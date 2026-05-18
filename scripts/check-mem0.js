const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const { Mem0Client } = require("../src/infra/memory/mem0-client");

loadEnv();

async function main() {
  const client = new Mem0Client({
    enabled: true,
    baseUrl: process.env.MEM0_BASE_URL || "https://api.mem0.ai",
    apiKey: process.env.MEM0_API_KEY || "",
    userIdPrefix: process.env.MEM0_USER_ID_PREFIX || "feishu",
    searchLimit: parseIntEnv("MEM0_SEARCH_LIMIT", 3),
    timeoutMs: parseIntEnv("MEM0_TIMEOUT_MS", 15000),
  });

  if (!process.env.MEM0_API_KEY) {
    throw new Error("MEM0_API_KEY is required");
  }

  const probeSender = process.env.MEM0_PROBE_SENDER_ID || "healthcheck-user";
  const query = process.env.MEM0_PROBE_QUERY || "hello";
  const userId = client.buildUserId(probeSender);

  const memories = await client.searchMemories({
    userId,
    query,
  });

  console.log(JSON.stringify({
    ok: true,
    baseUrl: process.env.MEM0_BASE_URL || "https://api.mem0.ai",
    userId,
    query,
    resultCount: memories.length,
    sample: memories.slice(0, 3),
  }, null, 2));
}

function parseIntEnv(name, defaultValue) {
  const parsed = Number.parseInt(String(process.env[name] || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
  }, null, 2));
  process.exit(1);
});

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

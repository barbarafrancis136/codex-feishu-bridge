#!/usr/bin/env node

const net = require("node:net");

const host = process.argv[2];
const port = Number.parseInt(process.argv[3] || "22", 10);
const timeoutMs = Number.parseInt(process.argv[4] || "8000", 10);

if (!host || Number.isNaN(port) || Number.isNaN(timeoutMs)) {
  console.error(
    "Usage: node ./scripts/ssh-banner-probe.js <host> [port=22] [timeoutMs=8000]"
  );
  process.exit(64);
}

const startedAt = Date.now();
const socket = new net.Socket();
let connectedAt = null;
let finished = false;
let buffer = "";

function finish(code, payload) {
  if (finished) {
    return;
  }
  finished = true;
  try {
    socket.destroy();
  } catch (error) {
    // Ignore close errors during probe teardown.
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

socket.setTimeout(timeoutMs);

socket.on("connect", () => {
  connectedAt = Date.now();
});

socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lineEnd = buffer.indexOf("\n");
  if (lineEnd === -1 && buffer.length < 255) {
    return;
  }

  const banner = (lineEnd === -1 ? buffer : buffer.slice(0, lineEnd)).trim();
  const elapsedMs = Date.now() - startedAt;
  const bannerDelayMs = connectedAt ? Date.now() - connectedAt : null;

  if (banner.startsWith("SSH-")) {
    finish(0, {
      ok: true,
      status: "banner_received",
      host,
      port,
      timeoutMs,
      elapsedMs,
      tcpConnectMs: connectedAt ? connectedAt - startedAt : null,
      bannerDelayMs,
      banner,
    });
    return;
  }

  finish(3, {
    ok: false,
    status: "non_ssh_data",
    host,
    port,
    timeoutMs,
    elapsedMs,
    tcpConnectMs: connectedAt ? connectedAt - startedAt : null,
    bannerDelayMs,
    received: banner,
  });
});

socket.on("timeout", () => {
  const elapsedMs = Date.now() - startedAt;
  finish(2, {
    ok: false,
    status: connectedAt ? "banner_timeout" : "connect_timeout",
    host,
    port,
    timeoutMs,
    elapsedMs,
    tcpConnectMs: connectedAt ? connectedAt - startedAt : null,
    hint: connectedAt
      ? "TCP connected but the remote side did not send an SSH banner in time."
      : "TCP connect did not complete before timeout.",
  });
});

socket.on("error", (error) => {
  const elapsedMs = Date.now() - startedAt;
  finish(1, {
    ok: false,
    status: connectedAt ? "banner_error" : "connect_error",
    host,
    port,
    timeoutMs,
    elapsedMs,
    tcpConnectMs: connectedAt ? connectedAt - startedAt : null,
    error: {
      name: error.name,
      message: error.message,
      code: error.code || null,
    },
  });
});

socket.connect(port, host);

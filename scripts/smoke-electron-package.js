#!/usr/bin/env node

const { existsSync } = require("node:fs");
const { mkdtempSync } = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const appPath = process.argv[2];
if (!appPath) {
  throw new Error("Usage: node scripts/smoke-electron-package.js <AgentMailbox.app path>");
}

const appName = path.basename(appPath, ".app");
const executable = path.join(appPath, "Contents", "MacOS", appName);
const appArchive = path.join(appPath, "Contents", "Resources", "app.asar");

if (!existsSync(executable) || !existsSync(appArchive)) {
  throw new Error(`Invalid macOS app bundle: ${appPath}`);
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), "agentmailbox-desktop-smoke-"));
const logs = [];
const child = spawn(executable, [], {
  env: {
    ...process.env,
    AGENTSMCP_DB: path.join(dataDir, "agentmailbox.db"),
    AGENTSMCP_INGESTION_STATE_DIR: path.join(dataDir, "ingestion"),
    ELECTRON_ENABLE_LOGGING: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 750 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
  });
}

async function findServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (let port = 3217; port < 3317; port += 1) {
      try {
        const health = await request(port, "/health");
        if (health.statusCode === 200) return port;
      } catch {
        // The next port may be the server selected by the desktop shell.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Desktop server did not become ready.\n${logs.join("")}`);
}

async function main() {
  try {
    const port = await findServer();
    const ui = await request(port, "/");
    if (ui.statusCode !== 200 || !ui.body.includes("AgentMailbox | Mainframe Knowledge")) {
      throw new Error(`Desktop UI was not served from the packaged app on port ${port}`);
    }
    console.log(`Packaged AgentMailbox smoke test passed on port ${port}.`);
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  child.kill("SIGKILL");
  process.exitCode = 1;
});

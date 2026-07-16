import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";

const DEFAULT_PORT = 3217;
const SERVER_READY_TIMEOUT_MS = 30_000;

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort = DEFAULT_PORT;

async function createMainWindow(): Promise<void> {
  serverPort = await findAvailablePort(DEFAULT_PORT);
  await startAgentMailboxServer(serverPort);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 760,
    title: "AgentMailbox",
    backgroundColor: "#f5f8f5",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) {
      return { action: "allow" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Serving the UI from the local API origin avoids file:// CORS behavior
  // while keeping every desktop request strictly on loopback.
  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
}

async function startAgentMailboxServer(port: number): Promise<void> {
  const serverEntry = resolveServerEntry();
  if (!serverEntry) {
    throw new Error("Server build not found. Run npm run build before starting Electron.");
  }

  const dbPath = process.env.AGENTSMCP_DB ?? path.join(app.getPath("userData"), "agentmailbox.db");
  const ingestionStateDir = process.env.AGENTSMCP_INGESTION_STATE_DIR ?? path.join(app.getPath("userData"), "ingestion");

  // Development launches the server with the user's Node binary so native
  // modules retain the ABI used by tests. Packaged builds use Electron, whose
  // native modules are rebuilt by electron-builder for the packaged app.
  const serverRuntime = process.env.AGENTMAILBOX_NODE_PATH ?? process.execPath;
  serverProcess = spawn(serverRuntime, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      AGENTSMCP_DB: dbPath,
      AGENTSMCP_INGESTION_STATE_DIR: ingestionStateDir,
      AGENTSMCP_API_JSON_LIMIT: process.env.AGENTSMCP_API_JSON_LIMIT ?? "50mb",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout?.on("data", (chunk) => {
    process.stdout.write(`[agentmailbox-server] ${chunk}`);
  });
  serverProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(`[agentmailbox-server] ${chunk}`);
  });

  serverProcess.once("exit", (code, signal) => {
    serverProcess = null;
    if (mainWindow && code !== 0) {
      mainWindow.webContents.send("agentmailbox:server-exit", { code, signal });
    }
  });

  await waitForServer(port, SERVER_READY_TIMEOUT_MS);
}

function resolveServerEntry(): string | null {
  const candidates = [
    path.join(app.getAppPath(), "dist", "server.js"),
    path.join(process.cwd(), "dist", "server.js"),
    path.join(process.resourcesPath, "app.asar.unpacked", "dist", "server.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`AgentMailbox server did not become ready on port ${port}`);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (!(await canConnect(port))) return port;
  }
  throw new Error("No available localhost port found for AgentMailbox desktop server");
}

function stopAgentMailboxServer(): void {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  child.kill("SIGTERM");
}

app.whenReady().then(() => {
  ipcMain.handle("agentmailbox:get-config", () => ({
    apiBase: `http://127.0.0.1:${serverPort}`,
    desktop: true,
    userDataPath: app.getPath("userData"),
  }));

  void createMainWindow().catch((error) => {
    console.error(error);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopAgentMailboxServer();
});

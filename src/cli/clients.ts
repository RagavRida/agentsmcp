/**
 * Platform-aware detection and config writing for supported MCP clients
 * (Claude Desktop, Cursor, Continue). All paths come from os.homedir() +
 * documented config-file locations — no hardcoded usernames or absolute paths.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { homedir, platform } from "os";

export type ClientId = "claude-desktop" | "cursor" | "continue";

export interface McpClient {
  id: ClientId;
  name: string;
  configPath: string;
  restartInstructions: string;
}

export interface McpEntryConfig {
  agentId: string;
  server: string;
  apiKey?: string;
}

/** Resolve the config file path for each supported client on this OS. */
export function clientConfigPaths(opts?: {
  home?: string;
  plat?: NodeJS.Platform;
  appdata?: string;
}): Record<ClientId, string> {
  const home = opts?.home ?? homedir();
  const plat = opts?.plat ?? platform();
  const appdata =
    opts?.appdata ?? process.env.APPDATA ?? join(home, "AppData", "Roaming");

  let claudeDesktop: string;
  if (plat === "darwin") {
    claudeDesktop = join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  } else if (plat === "win32") {
    claudeDesktop = join(appdata, "Claude", "claude_desktop_config.json");
  } else {
    // Linux + others — follow XDG-style default
    claudeDesktop = join(home, ".config", "Claude", "claude_desktop_config.json");
  }

  return {
    "claude-desktop": claudeDesktop,
    cursor: join(home, ".cursor", "mcp.json"),
    continue: join(home, ".continue", "config.json"),
  };
}

/**
 * Detect which MCP clients appear to be installed. Presence of the client's
 * config directory is the signal — false negatives are possible (Cursor never
 * launched, etc.) but never false positives.
 */
export function detectInstalledClients(opts?: {
  home?: string;
  plat?: NodeJS.Platform;
}): McpClient[] {
  const paths = clientConfigPaths(opts);
  const out: McpClient[] = [];

  if (existsSync(dirname(paths["claude-desktop"]))) {
    out.push({
      id: "claude-desktop",
      name: "Claude Desktop",
      configPath: paths["claude-desktop"],
      restartInstructions:
        platform() === "darwin"
          ? "Quit Claude Desktop completely (⌘Q) and reopen"
          : "Quit Claude Desktop and reopen",
    });
  }
  if (existsSync(dirname(paths.cursor))) {
    out.push({
      id: "cursor",
      name: "Cursor",
      configPath: paths.cursor,
      restartInstructions: "Quit Cursor and reopen, or restart MCP from the command palette",
    });
  }
  if (existsSync(dirname(paths.continue))) {
    out.push({
      id: "continue",
      name: "Continue",
      configPath: paths.continue,
      restartInstructions: "Reload the editor window (Cmd/Ctrl+Shift+P → Reload Window)",
    });
  }
  return out;
}

/**
 * Merge an agentsmcp entry into the client's mcpServers map. Returns a fresh
 * object — does not mutate `existing`. Preserves every other key in the file.
 */
export function mergeConfig(
  existing: unknown,
  cfg: McpEntryConfig
): Record<string, unknown> {
  const env: Record<string, string> = {
    AGENTSMCP_AGENT_ID: cfg.agentId,
    AGENTSMCP_SERVER: cfg.server,
  };
  if (cfg.apiKey) env.AGENTSMCP_API_KEY = cfg.apiKey;

  const ourEntry = {
    command: "npx",
    args: ["-y", "agentsmcp"],
    env,
  };

  const base =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const existingServers = base.mcpServers;
  const servers =
    typeof existingServers === "object" &&
    existingServers !== null &&
    !Array.isArray(existingServers)
      ? { ...(existingServers as Record<string, unknown>) }
      : {};

  servers.agentsmcp = ourEntry;
  base.mcpServers = servers;
  return base;
}

export interface WriteResult {
  configPath: string;
  backupPath?: string;
  created: boolean;
}

/**
 * Write the merged config to disk. If a config already exists:
 *  - Valid JSON → back it up to `<path>.bak`, then write the merged result.
 *  - Invalid JSON → throw. We refuse to overwrite a file we can't safely
 *    round-trip, since doing so could destroy the user's config.
 */
export function writeClientConfig(
  client: McpClient,
  cfg: McpEntryConfig
): WriteResult {
  const path = client.configPath;
  mkdirSync(dirname(path), { recursive: true });

  let existing: unknown = {};
  let created = true;
  let backupPath: string | undefined;

  if (existsSync(path)) {
    created = false;
    const raw = readFileSync(path, "utf8");
    try {
      existing = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `${path} is not valid JSON — refusing to overwrite. ` +
          `Fix or remove the file and re-run init. (${(e as Error).message})`
      );
    }
    backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
  }

  const merged = mergeConfig(existing, cfg);
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return { configPath: path, backupPath, created };
}

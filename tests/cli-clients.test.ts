import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  clientConfigPaths,
  mergeConfig,
  writeClientConfig,
  type McpClient,
} from "../src/cli/clients";

describe("cli/clients — mergeConfig", () => {
  it("adds an agentsmcp block to a fresh config", () => {
    const out = mergeConfig(
      {},
      { agentId: "alice", server: "https://example.com", apiKey: "sk_live_x" }
    );
    expect(out.mcpServers).toBeDefined();
    const servers = out.mcpServers as Record<string, unknown>;
    expect(servers.agentsmcp).toBeDefined();
    const entry = servers.agentsmcp as Record<string, unknown>;
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "agentsmcp"]);
    const env = entry.env as Record<string, string>;
    expect(env.AGENTSMCP_AGENT_ID).toBe("alice");
    expect(env.AGENTSMCP_SERVER).toBe("https://example.com");
    expect(env.AGENTSMCP_API_KEY).toBe("sk_live_x");
  });

  it("preserves other mcpServers entries", () => {
    const existing = {
      mcpServers: {
        github: { command: "github-mcp", args: [], env: { TOKEN: "..." } },
        filesystem: { command: "fs-mcp", args: ["/tmp"] },
      },
    };
    const out = mergeConfig(existing, {
      agentId: "alice",
      server: "https://example.com",
    });
    const servers = out.mcpServers as Record<string, unknown>;
    expect(servers.github).toEqual(existing.mcpServers.github);
    expect(servers.filesystem).toEqual(existing.mcpServers.filesystem);
    expect(servers.agentsmcp).toBeDefined();
  });

  it("preserves top-level non-mcpServers keys", () => {
    const existing = {
      theme: "dark",
      mcpServers: {},
      experimental: { foo: true },
    };
    const out = mergeConfig(existing, {
      agentId: "alice",
      server: "https://example.com",
    });
    expect(out.theme).toBe("dark");
    expect(out.experimental).toEqual({ foo: true });
  });

  it("replaces an existing agentsmcp entry rather than duplicating", () => {
    const existing = {
      mcpServers: {
        agentsmcp: { command: "old", args: [], env: { AGENTSMCP_AGENT_ID: "bob" } },
      },
    };
    const out = mergeConfig(existing, {
      agentId: "alice",
      server: "https://example.com",
    });
    const servers = out.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["agentsmcp"]);
    const entry = servers.agentsmcp as Record<string, unknown>;
    expect((entry.env as Record<string, string>).AGENTSMCP_AGENT_ID).toBe("alice");
  });

  it("omits AGENTSMCP_API_KEY when apiKey is not supplied", () => {
    const out = mergeConfig(
      {},
      { agentId: "alice", server: "https://example.com" }
    );
    const env = (
      (out.mcpServers as Record<string, unknown>).agentsmcp as Record<string, unknown>
    ).env as Record<string, string>;
    expect(env.AGENTSMCP_API_KEY).toBeUndefined();
  });

  it("treats non-object existing config as empty", () => {
    const out = mergeConfig(null, {
      agentId: "alice",
      server: "https://example.com",
    });
    expect(out.mcpServers).toBeDefined();
  });

  it("does not mutate the input", () => {
    const existing = { mcpServers: { other: { command: "x" } } };
    const before = JSON.stringify(existing);
    mergeConfig(existing, { agentId: "alice", server: "https://x.com" });
    expect(JSON.stringify(existing)).toBe(before);
  });
});

describe("cli/clients — clientConfigPaths", () => {
  it("resolves Mac paths under Library/Application Support", () => {
    const paths = clientConfigPaths({ home: "/Users/me", plat: "darwin" });
    expect(paths["claude-desktop"]).toBe(
      "/Users/me/Library/Application Support/Claude/claude_desktop_config.json"
    );
    expect(paths.cursor).toBe("/Users/me/.cursor/mcp.json");
    expect(paths.continue).toBe("/Users/me/.continue/config.json");
  });

  it("resolves Linux paths under .config", () => {
    const paths = clientConfigPaths({ home: "/home/me", plat: "linux" });
    expect(paths["claude-desktop"]).toBe(
      "/home/me/.config/Claude/claude_desktop_config.json"
    );
  });

  it("uses APPDATA on Windows", () => {
    const paths = clientConfigPaths({
      home: "C:\\Users\\me",
      plat: "win32",
      appdata: "C:\\Users\\me\\AppData\\Roaming",
    });
    expect(paths["claude-desktop"]).toContain("Claude");
    expect(paths["claude-desktop"]).toContain("claude_desktop_config.json");
  });
});

describe("cli/clients — writeClientConfig", () => {
  function makeClient(configPath: string): McpClient {
    return {
      id: "claude-desktop",
      name: "Claude Desktop",
      configPath,
      restartInstructions: "test",
    };
  }

  it("creates a new file when none exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentsmcp-test-"));
    try {
      const path = join(dir, "fresh", "config.json");
      const client = makeClient(path);
      const res = writeClientConfig(client, {
        agentId: "alice",
        server: "https://example.com",
        apiKey: "sk_live_x",
      });
      expect(res.created).toBe(true);
      expect(res.backupPath).toBeUndefined();
      const written = JSON.parse(readFileSync(path, "utf8"));
      const env = written.mcpServers.agentsmcp.env;
      expect(env.AGENTSMCP_AGENT_ID).toBe("alice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs up an existing file before writing the merged config", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentsmcp-test-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(
        path,
        JSON.stringify({ mcpServers: { other: { command: "x" } } })
      );
      const client = makeClient(path);
      const res = writeClientConfig(client, {
        agentId: "alice",
        server: "https://example.com",
      });
      expect(res.created).toBe(false);
      expect(res.backupPath).toBe(path + ".bak");
      const merged = JSON.parse(readFileSync(path, "utf8"));
      expect(merged.mcpServers.other).toEqual({ command: "x" });
      expect(merged.mcpServers.agentsmcp).toBeDefined();
      const backup = JSON.parse(readFileSync(path + ".bak", "utf8"));
      expect(backup.mcpServers.agentsmcp).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentsmcp-test-"));
    try {
      const path = join(dir, "broken.json");
      writeFileSync(path, "{ this is not json");
      const client = makeClient(path);
      expect(() =>
        writeClientConfig(client, {
          agentId: "alice",
          server: "https://example.com",
        })
      ).toThrow(/not valid JSON/);
      // Original is untouched
      expect(readFileSync(path, "utf8")).toBe("{ this is not json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

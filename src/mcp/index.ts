#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AgentMailbox } from "../agentmailbox";
import { parseInitArgv, runInit } from "../cli/init";

import { buildMcpServer } from "./server";

interface Config {
  agentId: string;
  server: string;
  apiKey?: string;
}

function parseArgs(argv: string[]): Partial<Config> {
  const out: Partial<Config> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      i += 1;
      return v;
    };
    if (a === "--agent-id") out.agentId = next();
    else if (a === "--server") out.server = next();
    else if (a === "--api-key") out.apiKey = next();
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printUsage(): void {
  process.stderr.write(
    "usage:\n" +
      "  agentsmcp init [options]                 one-command MCP client setup\n" +
      "  agentsmcp index [options]                CI codebase indexer\n" +
      "  agentsmcp [--agent-id ID] [--server URL] [--api-key KEY]\n" +
      "                                           start the MCP server (stdio)\n" +
      "\n" +
      "env: AGENTSMCP_AGENT_ID, AGENTSMCP_SERVER, AGENTSMCP_API_KEY\n" +
      "Run `agentsmcp init --help` for setup flags.\n" +
      "Run `agentsmcp-index --help` for indexer flags.\n"
  );
}

function die(msg: string): never {
  process.stderr.write(`agentsmcp: ${msg}\n`);
  process.exit(1);
}

function readEnv(name: string): string | undefined {
  const val = process.env[name];
  if (val !== undefined && val !== "") return val;
  return undefined;
}

function resolveConfig(): Config {
  const args = parseArgs(process.argv.slice(2));
  const agentId =
    args.agentId ?? readEnv("AGENTSMCP_AGENT_ID") ?? "";
  const server =
    args.server ??
    readEnv("AGENTSMCP_SERVER") ??
    "http://localhost:3000";
  const apiKey =
    args.apiKey ?? readEnv("AGENTSMCP_API_KEY");
  if (!agentId) {
    die(
      "AGENTSMCP_AGENT_ID is required (or pass --agent-id). " +
        "This identifies the agent this MCP server represents."
    );
  }
  return { agentId, server, apiKey };
}

async function main(): Promise<void> {
  // Subcommand dispatch — keeps `agentsmcp` (no args) starting the MCP server
  // for backward compatibility while exposing `agentsmcp init` for setup.
  const sub = process.argv[2];
  if (sub === "init") {
    const initArgs = parseInitArgv(process.argv.slice(3));
    await runInit(initArgs);
    return;
  }

  // `agentsmcp agentsmcp-index ...` — delegate to the CI codebase indexer.
  // The indexer reads its own argv from process.argv, so we shift the
  // subcommand name out so it sees the flags at argv[2+].
  if (sub === "agentsmcp-index" || sub === "index") {
    process.argv.splice(2, 1); // remove the subcommand, keep flags
    // Dynamic require — the indexer is a self-contained script that calls
    // main() on load. We use require() so it runs inline.
    const indexerPath = require("path").resolve(__dirname, "../scripts/index-codebase.js");
    try {
      require(indexerPath);
    } catch (e: unknown) {
      // Fallback: try tsx for development (script is .ts, not compiled)
      const tsPath = indexerPath.replace(/\.js$/, ".ts");
      try {
        require(tsPath);
      } catch {
        const msg = e instanceof Error ? e.message : String(e);
        die(`cannot load codebase indexer: ${msg}`);
      }
    }
    return;
  }

  const cfg = resolveConfig();
  const agent = new AgentMailbox({
    agentId: cfg.agentId,
    server: cfg.server,
    apiKey: cfg.apiKey,
  });

  try {
    await agent.connect();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    die(`cannot reach AgentMailbox server at ${cfg.server}: ${msg}`);
  }

  const server = buildMcpServer(agent);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`agentsmcp: ${signal} received, shutting down\n`);
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  process.stderr.write(
    `agentsmcp: connected as ${cfg.agentId} -> ${cfg.server}\n`
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agentsmcp: fatal: ${msg}\n`);
  process.exit(1);
});

/**
 * `agentsmcp init` — one-command setup. Detects installed MCP clients,
 * gathers credentials (interactively or via flags), registers a fresh account
 * when needed, verifies the server, and writes merged configs.
 */
import { createInterface } from "readline";
import { hostname, userInfo } from "os";
import {
  ClientId,
  McpClient,
  detectInstalledClients,
  writeClientConfig,
} from "./clients";
import { loginWithGitHub } from "./github-login";

/** Override with AGENTSMCP_DEFAULT_SERVER env var for self-hosted defaults. */
const FALLBACK_SERVER = "https://hdnxa5c8yr.us-east-1.awsapprunner.com";

export interface InitArgs {
  /** Skip prompts and use defaults; requires apiKey, email, or github. */
  yes?: boolean;
  agentId?: string;
  server?: string;
  apiKey?: string;
  /** Email for registering a new account when no apiKey is given. */
  email?: string;
  /** Force GitHub OAuth flow even when other options are present. */
  github?: boolean;
  /** Force the email-registration fallback (disables GitHub default). */
  noGithub?: boolean;
  /** Specific client ids to set up, or ["all"]. Unset → interactive prompt. */
  clients?: string[];
}

export async function runInit(args: InitArgs): Promise<void> {
  out("agentsmcp setup\n");

  // 1. Detect installed clients
  const available = detectInstalledClients();
  if (available.length === 0) {
    die(
      "No supported MCP clients detected.\n" +
        "Install Claude Desktop, Cursor, or Continue first, then re-run."
    );
  }

  // 2. Pick which clients to configure
  const selected = await selectClients(available, args);

  // 3. Resolve agent ID
  const defaultAgentId = sanitizeAgentId(`${userInfo().username}-${hostname()}`);
  const agentId = args.agentId
    ? sanitizeAgentId(args.agentId)
    : args.yes
      ? defaultAgentId
      : sanitizeAgentId(
          (await prompt(`Agent ID [${defaultAgentId}]: `)) || defaultAgentId
        );

  // 4. Resolve server URL
  const defaultServer =
    process.env.AGENTSMCP_DEFAULT_SERVER ?? FALLBACK_SERVER;
  const rawServer =
    args.server ??
    process.env.AGENTSMCP_SERVER ??
    (args.yes
      ? defaultServer
      : (await prompt(`Server URL [${defaultServer}]: `)) || defaultServer);
  const server = normalizeServer(rawServer);

  // 5. Resolve API key (or register, or GitHub login)
  let apiKey = args.apiKey ?? process.env.AGENTSMCP_API_KEY;
  if (!apiKey) {
    apiKey = await resolveApiKey(server, agentId, args);
  }

  // 6. Verify connection (non-fatal — server might be self-hosted without /health)
  out("\nVerifying server reachable...");
  const reachable = await testConnection(server);
  if (!reachable) {
    out(`  ! ${server} is not responding. Configs will be written anyway.`);
  } else {
    out("  ✓ Reachable");
  }

  // 7. Write configs
  out("\nWriting configs:");
  let anyFailed = false;
  for (const client of selected) {
    try {
      const res = writeClientConfig(client, { agentId, server, apiKey });
      const note = res.created ? "(new file)" : `(backup: ${res.backupPath})`;
      out(`  ✓ ${client.name} → ${res.configPath} ${note}`);
    } catch (e) {
      anyFailed = true;
      out(`  ✗ ${client.name}: ${(e as Error).message}`);
    }
  }

  // 8. Restart instructions
  out("\nDone. Restart your MCP client(s):");
  for (const client of selected) {
    out(`  - ${client.name}: ${client.restartInstructions}`);
  }
  out("\nVerify by asking the agent to call `agentsmcp_session_start`.");

  if (anyFailed) process.exit(1);
}

async function selectClients(
  available: McpClient[],
  args: InitArgs
): Promise<McpClient[]> {
  if (args.clients && args.clients.length > 0) {
    if (args.clients.includes("all")) return available;
    const filtered = available.filter((c) =>
      args.clients!.includes(c.id)
    );
    if (filtered.length === 0) {
      die(
        `No matching clients. Detected: ${available.map((c) => c.id).join(", ")}`
      );
    }
    return filtered;
  }
  if (args.yes || available.length === 1) return available;

  out("Detected MCP clients:");
  available.forEach((c, i) => out(`  ${i + 1}. ${c.name}`));
  out(`  ${available.length + 1}. All`);
  const ans = await prompt(
    `Configure [1-${available.length + 1}, default: all]: `
  );
  if (!ans) return available;
  const allChoice = String(available.length + 1);
  if (ans === allChoice) return available;
  const idx = parseInt(ans, 10) - 1;
  if (idx >= 0 && idx < available.length) return [available[idx]];
  out("Unrecognized choice — configuring all.");
  return available;
}

async function resolveApiKey(
  server: string,
  agentId: string,
  args: InitArgs
): Promise<string> {
  // --yes mode: must have explicit credentials or it can't proceed silently.
  if (args.yes) {
    if (args.github) return githubLogin(server, agentId);
    if (args.email) return registerNew(server, args.email);
    die("--yes requires one of: --api-key, --email, or --github");
  }

  // Forced choices via flags
  if (args.github) return githubLogin(server, agentId);
  if (args.email) return registerNew(server, args.email);

  // Default: GitHub OAuth (one click, no copy-paste). --no-github escapes.
  if (!args.noGithub) {
    const useGithub = await promptYesNo(
      "Sign in with GitHub? (opens your browser)",
      true
    );
    if (useGithub) return githubLogin(server, agentId);
  }

  // Fallback: existing key or email register.
  const hasKey = await promptYesNo(
    "Do you already have an agentsmcp API key?",
    false
  );
  if (hasKey) {
    const key = (await prompt("Paste your sk_live_... key: ")).trim();
    if (!key.startsWith("sk_live_")) {
      die("That doesn't look like a valid key (expected sk_live_...).");
    }
    return key;
  }
  const email = (await prompt("Email to register a new account: ")).trim();
  if (!email || !email.includes("@")) {
    die("Valid email required to register.");
  }
  return registerNew(server, email);
}

async function githubLogin(server: string, agentId: string): Promise<string> {
  out("\nOpening GitHub login in your browser...");
  try {
    const result = await loginWithGitHub({
      server,
      label: agentId,
      onReady: (url) => {
        out(`If the browser does not open automatically, visit:\n  ${url}\n`);
      },
    });
    const who = result.githubLogin ? ` (${result.githubLogin})` : "";
    out(`✓ Signed in${who}`);
    return result.apiKey;
  } catch (e) {
    die(`GitHub login failed: ${(e as Error).message}`);
  }
}

async function registerNew(server: string, email: string): Promise<string> {
  out(`\nRegistering ${email}...`);
  const url = new URL("/auth/register", server).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch (e) {
    die(`Could not reach ${url}: ${(e as Error).message}`);
  }
  if (res.status === 429) {
    die("Registration rate limited (10/hour/IP). Wait and try again.");
  }
  if (res.status === 409) {
    die(
      "An account with that email already exists. " +
        "Re-run with --api-key <your existing key>."
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`Registration failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { apiKey?: string };
  if (!data.apiKey) die("Server response missing apiKey field.");

  out("\n  ╔══════════════════════════════════════════════════════════╗");
  out("  ║  SAVE THIS API KEY — IT WILL NOT BE SHOWN AGAIN          ║");
  out("  ╠══════════════════════════════════════════════════════════╣");
  out(`  ║  ${data.apiKey!.padEnd(56)}║`);
  out("  ╚══════════════════════════════════════════════════════════╝");
  out("  (Also stored in your MCP client config below.)\n");
  return data.apiKey!;
}

async function testConnection(server: string): Promise<boolean> {
  try {
    const url = new URL("/health", server).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

function normalizeServer(s: string): string {
  let v = s.trim();
  if (!v) die("Server URL cannot be empty.");
  if (!/^https?:\/\//.test(v)) v = "https://" + v;
  try {
    const u = new URL(v);
    // strip trailing slash, drop hash/query
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    die(`Invalid server URL: ${s}`);
  }
}

/**
 * Strip characters that would be awkward in URLs/paths. Agents are addressed
 * by string in URLs, so reserve [a-z0-9-] only.
 */
function sanitizeAgentId(s: string): string {
  const v = s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!v) die("Agent ID cannot be empty.");
  return v;
}

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    die(
      `Cannot prompt in non-interactive shell for: ${question}\n` +
        "Pass --yes plus the required flags (--agent-id, --server, --api-key or --email)."
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptYesNo(question: string, def: boolean): Promise<boolean> {
  const hint = def ? "[Y/n]" : "[y/N]";
  const ans = await prompt(`${question} ${hint}: `);
  if (!ans) return def;
  return /^y/i.test(ans);
}

function out(s: string): void {
  process.stdout.write(s + "\n");
}

function die(msg: string): never {
  process.stderr.write(`agentsmcp init: ${msg}\n`);
  process.exit(1);
}

/** Parse argv slice after `init` subcommand. Tolerates both flag styles. */
export function parseInitArgv(argv: string[]): InitArgs {
  const out: InitArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) die(`missing value for ${a}`);
      i += 1;
      return v;
    };
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--agent-id") out.agentId = next();
    else if (a === "--server") out.server = next();
    else if (a === "--api-key") out.apiKey = next();
    else if (a === "--email") out.email = next();
    else if (a === "--github") out.github = true;
    else if (a === "--no-github") out.noGithub = true;
    else if (a === "--client") {
      out.clients = (out.clients ?? []).concat(next().split(","));
    } else if (a === "--all") {
      out.clients = ["all"];
    } else if (a === "-h" || a === "--help") {
      printInitHelp();
      process.exit(0);
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printInitHelp(): void {
  process.stderr.write(
    `usage: agentsmcp init [options]

Options:
  --yes, -y              Skip prompts, use defaults
  --agent-id ID          Agent identifier (default: <user>-<hostname>)
  --server URL           AgentMailbox server URL
  --github               Sign in with GitHub (default — opens browser)
  --no-github            Skip GitHub and use email registration instead
  --api-key KEY          Existing sk_live_... key (skips all auth)
  --email EMAIL          Email to register a new account (skips GitHub)
  --client ID            Configure a specific client (claude-desktop|cursor|continue)
                         Pass multiple times or comma-separate to configure several
  --all                  Configure every detected client
  -h, --help             Show this help

Examples:
  agentsmcp init                                       # GitHub login (default)
  agentsmcp init --yes --github --all                  # unattended GitHub login
  agentsmcp init --api-key sk_live_... --client cursor # use existing key
  agentsmcp init --yes --email me@example.com --all    # email registration
`
  );
}


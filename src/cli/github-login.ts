/**
 * Browser-based GitHub OAuth login for the CLI. Spins up a one-shot HTTP
 * server on a random loopback port, opens the user's browser to the server's
 * /auth/github endpoint with `cli_redirect` pointing at the local port, then
 * awaits the callback with the freshly-minted API key.
 *
 * Security boundary: the local listener binds to 127.0.0.1 only, accepts at
 * most one /callback request, and tears down within ~5 minutes. The CSRF
 * state is generated client-side and round-tripped through GitHub.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { platform } from "os";

export interface GitHubLoginResult {
  apiKey: string;
  githubLogin?: string;
}

export interface GitHubLoginOptions {
  /** Base AgentMailbox server URL (e.g. https://hdnxa5c8yr.us-east-1.awsapprunner.com). */
  server: string;
  /** Label used to name the minted API key — e.g. the agent id. */
  label?: string;
  /** Total time to wait for the callback. Default 5 min. */
  timeoutMs?: number;
  /** Hook called once the local port is bound — used by the wizard to print the URL. */
  onReady?: (loginUrl: string) => void;
  /** Disable auto-opening the browser (tests / headless shells). */
  noOpen?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function loginWithGitHub(
  opts: GitHubLoginOptions
): Promise<GitHubLoginResult> {
  const { server, label, timeoutMs = DEFAULT_TIMEOUT_MS, onReady, noOpen } = opts;

  const cliState = randomBytes(24).toString("hex");
  const { port, done, close } = await startCallbackServer(cliState);

  const callbackUrl = `http://127.0.0.1:${port}/callback`;
  const loginUrl = buildLoginUrl(server, callbackUrl, cliState, label);

  onReady?.(loginUrl);

  if (!noOpen) {
    openBrowser(loginUrl);
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for GitHub login`)),
          timeoutMs
        );
      }),
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    close();
  }
}

/** Build the full /auth/github URL with cli_redirect + label encoded. */
export function buildLoginUrl(
  server: string,
  callbackUrl: string,
  cliState: string,
  label?: string
): string {
  const u = new URL("/auth/github", server);
  u.searchParams.set("cli_redirect", callbackUrl);
  u.searchParams.set("cli_state", cliState);
  if (label) u.searchParams.set("cli_label", label.slice(0, 64));
  return u.toString();
}

interface CallbackServer {
  port: number;
  done: Promise<GitHubLoginResult>;
  close: () => void;
}

function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveDone!: (r: GitHubLoginResult) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<GitHubLoginResult>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    let handled = false;
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
        return;
      }
      if (handled) {
        res.writeHead(409, { "Content-Type": "text/plain" }).end("already handled");
        return;
      }
      handled = true;

      const apiKey = url.searchParams.get("apiKey");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const githubLogin = url.searchParams.get("githubLogin") ?? undefined;

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(failurePage(error));
        rejectDone(new Error(`GitHub OAuth failed: ${error}`));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(failurePage("state_mismatch"));
        rejectDone(new Error("OAuth state mismatch — refusing to use this response"));
        return;
      }
      if (!apiKey) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(failurePage("missing_api_key"));
        rejectDone(new Error("Server did not return an apiKey"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" }).end(successPage(githubLogin));
      resolveDone({ apiKey, githubLogin });
    });

    server.on("error", (e) => rejectServer(e));
    // Bind to 127.0.0.1 only — never expose the listener on a public interface.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port =
        typeof addr === "object" && addr !== null && "port" in addr
          ? (addr as { port: number }).port
          : 0;
      resolveServer({
        port,
        done,
        close: () => {
          try {
            server.close();
          } catch {
            /* best-effort */
          }
        },
      });
    });
  });
}

/** Open the user's default browser. Returns immediately — fire-and-forget. */
function openBrowser(url: string): void {
  const p = platform();
  let cmd: string;
  let args: string[];
  if (p === "darwin") {
    cmd = "open";
    args = [url];
  } else if (p === "win32") {
    // start "" "<url>" — through cmd /c so quoting works
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // Silently swallow — caller has already printed the URL via onReady.
    });
    child.unref();
  } catch {
    /* nothing — printing the URL is the fallback */
  }
}

function successPage(githubLogin?: string): string {
  const who = githubLogin ? ` as <strong>${escapeHtml(githubLogin)}</strong>` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>agentsmcp — logged in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px;
          padding: 32px 40px; max-width: 480px; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { margin: 8px 0; color: #aaa; }
  .check { color: #4ade80; font-size: 32px; }
</style></head>
<body><div class="card">
  <div class="check">✓</div>
  <h1>Signed in${who}</h1>
  <p>Your API key has been delivered to the CLI.</p>
  <p>You can close this tab and return to your terminal.</p>
</div></body></html>`;
}

function failurePage(code: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>agentsmcp — login failed</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px;
          padding: 32px 40px; max-width: 480px; }
  h1 { margin: 0 0 8px; font-size: 22px; color: #f87171; }
  code { background: #2a2a2a; padding: 2px 6px; border-radius: 4px; }
</style></head>
<body><div class="card">
  <h1>Login failed</h1>
  <p>Error: <code>${escapeHtml(code)}</code></p>
  <p>You can close this tab and re-run <code>agentsmcp init</code>.</p>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

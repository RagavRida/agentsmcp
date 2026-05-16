/**
 * Supervisor for the research-bench demo. Boots the AgentMailbox HTTP
 * server in-process and spawns the explorer + synthesizer as separate
 * child processes so you can kill them individually (e.g. with
 * `pkill -f explorer.ts`) to demonstrate cold-restart.
 *
 * One Ctrl-C in this terminal shuts everything down cleanly.
 */
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { createServer } from "agentsmcp";

const PORT = Number(process.env.PORT ?? 43500);
const DB = process.env.AGENTMAILBOX_DB ?? path.join(__dirname, "..", "bench.db");
const SERVER_URL = `http://localhost:${PORT}`;

function spawnAgent(name: string, file: string): ChildProcess {
  const child = spawn("npx", ["ts-node", file], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, AGENTMAILBOX_SERVER: SERVER_URL },
    stdio: ["ignore", "inherit", "inherit"],
  });
  process.stdout.write(`[start] spawned ${name} (pid=${child.pid})\n`);
  child.on("exit", (code, signal) => {
    process.stdout.write(
      `[start] ${name} exited (code=${code}, signal=${signal}). ` +
        `Restart it with: npm run ${name}\n`
    );
  });
  return child;
}

async function main(): Promise<void> {
  // 1. HTTP server in-process so we control the lifecycle.
  const { app, ready } = createServer(DB);
  await ready;
  const httpServer = app.listen(PORT, () => {
    process.stdout.write(`[server] listening on ${SERVER_URL}\n`);
    process.stdout.write(`[server] db: ${DB}\n`);
  });

  // 2. Two agents as separate processes so Ctrl-C on the supervisor
  //    leaves them in distinct PIDs (visible in the "[start] spawned"
  //    lines above) and you can kill either one independently.
  const explorer = spawnAgent("explorer", "src/explorer.ts");
  const synthesizer = spawnAgent("synthesizer", "src/synthesizer.ts");

  // 3. Clean shutdown on Ctrl-C.
  let shuttingDown = false;
  const shutdown = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n[start] ${sig} received, shutting down...\n`);
    explorer.kill("SIGINT");
    synthesizer.kill("SIGINT");
    httpServer.close(() => process.exit(0));
    // Hard cap so a hung child doesn't pin the supervisor.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 4. Tell the user how to interact.
  setTimeout(() => {
    process.stdout.write(
      "\n[start] ready. Three ways to drive the demo:\n" +
        `  1. Claude Desktop with the MCP adapter pointing at ${SERVER_URL}\n` +
        "     (see examples/research-bench/README.md for the config snippet)\n" +
        "  2. curl/Postman against the HTTP API\n" +
        "  3. A one-shot kickoff: npx ts-node -e 'see README'\n" +
        "\n[start] Ctrl-C in this terminal to stop everything.\n\n"
    );
  }, 1000);
}

main().catch((err: Error) => {
  process.stderr.write(`[start] fatal: ${err.message}\n`);
  process.exit(1);
});

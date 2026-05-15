/**
 * Kickoff script. Sends one task into the researcher's mailbox, then
 * waits for a draft to come back from the writer and prints it.
 *
 * Usage:
 *   npx ts-node src/kickoff.ts "summarize diffusion models"
 */
import { AgentMailbox } from "agentsmcp";

const SERVER = process.env.AGENTMAILBOX_SERVER ?? "http://localhost:3000";
const ME = "user@demo";
const RESEARCHER = "researcher@demo";
const WRITER = "writer@demo";
const POLL_MS = 1500;
const TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  const task = process.argv.slice(2).join(" ") || "summarize diffusion models";

  const agent = new AgentMailbox({ agentId: ME, server: SERVER });
  await agent.connect();
  process.stdout.write(`[kickoff] dispatching task to ${RESEARCHER}: ${task}\n`);

  const sent = await agent.send(
    RESEARCHER,
    { task },
    {
      cc: [WRITER],
      contextSnapshot: { step: "task_dispatched", priority: "normal" },
    }
  );
  process.stdout.write(`[kickoff] thread ${sent.threadId} created\n`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const unread = await agent.unread();
    const draft = unread.find((f) => f.from === WRITER);
    if (draft) {
      const payload = draft.payload as { draft?: string };
      process.stdout.write(
        `[kickoff] draft received from writer:\n${payload.draft ?? "(empty)"}\n`
      );
      await agent.markRead(draft.threadId);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  process.stderr.write(
    `[kickoff] timed out after ${TIMEOUT_MS}ms with no draft from writer\n`
  );
  process.exit(2);
}

main().catch((err: Error) => {
  process.stderr.write(`[kickoff] fatal: ${err.message}\n`);
  process.exit(1);
});

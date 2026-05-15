/**
 * Writer agent. Loops on receive(): when it gets findings from the
 * researcher, calls Claude to write a summary, replies with a
 * contextSnapshot describing the draft.
 *
 * The interesting bit: if you kill this process mid-task and restart
 * it, the next loop iteration goes through sync() for every thread it
 * already participates in, so it picks up cold from researcher's last
 * snapshot — no local state required.
 */
import { AgentMailbox } from "agentsmcp";
import { complete } from "./llm";

const SERVER = process.env.AGENTMAILBOX_SERVER ?? "http://localhost:3000";
const ME = "writer@demo";
const RESEARCHER = "researcher@demo";
const POLL_MS = 1500;

interface FindingsPayload {
  findings?: string;
  papers?: string[];
  sourceTask?: string;
}

async function handleFindings(
  agent: AgentMailbox,
  threadId: string,
  payload: FindingsPayload
): Promise<void> {
  process.stdout.write(
    `[writer] drafting summary from ${payload.papers?.length ?? 0} papers\n`
  );

  const prompt =
    `Topic: ${payload.sourceTask ?? "unknown"}\n\n` +
    `Research findings:\n${payload.findings ?? "(none)"}\n\n` +
    "Write a 3-sentence summary suitable for a non-expert.";

  const { text, stub } = await complete(
    "You are a writer agent. Summarize research findings clearly.",
    prompt
  );

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  await agent.replyAll(
    threadId,
    { draft: text },
    {
      contextSnapshot: {
        step: "draft_complete",
        wordCount,
        stub,
      },
    }
  );
  await agent.markRead(threadId);
  process.stdout.write(
    `[writer] sent draft (words=${wordCount}, stub=${stub})\n`
  );
}

async function coldResumeAllThreads(agent: AgentMailbox): Promise<void> {
  // After restart, look at every thread we're in and re-sync. We don't
  // act on past messages we already responded to (markRead handled that)
  // — this just rehydrates context so any pending unread is handled
  // with the latest researcher snapshot visible.
  const threads = await agent.threads();
  for (const t of threads) {
    const { context } = await agent.sync(t.id);
    process.stdout.write(
      `[writer] cold-resume thread ${t.id} snapshot=${JSON.stringify(context.snapshot)}\n`
    );
  }
}

async function main(): Promise<void> {
  const agent = new AgentMailbox({ agentId: ME, server: SERVER });
  await agent.connect();
  process.stdout.write(`[writer] online at ${SERVER}\n`);

  await coldResumeAllThreads(agent);

  for (;;) {
    const unread = await agent.unread();
    for (const frame of unread) {
      if (frame.from !== RESEARCHER) {
        await agent.markRead(frame.threadId);
        continue;
      }
      try {
        await handleFindings(
          agent,
          frame.threadId,
          frame.payload as FindingsPayload
        );
      } catch (err) {
        process.stderr.write(
          `[writer] error handling ${frame.id}: ${(err as Error).message}\n`
        );
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err: Error) => {
  process.stderr.write(`[writer] fatal: ${err.message}\n`);
  process.exit(1);
});

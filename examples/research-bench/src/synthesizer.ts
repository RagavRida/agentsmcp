/**
 * Synthesizer agent. Long-running loop. Receives findings from the
 * explorer (or anyone else) and folds them into a running summary that
 * it replyAlls back to the thread. Everyone visible on the thread —
 * including you, if you're connected via Claude Desktop's MCP adapter —
 * sees the updated summary.
 *
 * Cold-restart property: same as explorer. On startup, sync()s every
 * thread so the next loop iteration starts from the latest snapshot.
 */
import { AgentMailbox } from "agentsmcp";
import { complete } from "./llm";

const SERVER = process.env.AGENTMAILBOX_SERVER ?? "http://localhost:43500";
const ME = "synthesizer@demo";
const EXPLORER = "explorer@demo";
const POLL_MS = 1500;

interface FindingsPayload {
  findings?: string;
  angles?: string[];
  sourceTopic?: string;
}

async function handleFindings(
  agent: AgentMailbox,
  threadId: string,
  payload: FindingsPayload
): Promise<void> {
  const angleCount = payload.angles?.length ?? 0;
  process.stdout.write(
    `[synthesizer] folding ${angleCount} new angles into thread ${threadId.slice(0, 8)}\n`
  );

  // Pull the existing summary so the LLM can extend it rather than restart.
  const { context } = await agent.sync(threadId);
  const priorSummary =
    context.threadSummaryStructured?.text ?? context.threadSummary ?? "";

  const prompt =
    `Topic: ${payload.sourceTopic ?? "unknown"}\n\n` +
    `Prior running summary (extend, don't rewrite):\n${priorSummary || "(none yet)"}\n\n` +
    `New findings:\n${payload.findings ?? "(none)"}\n\n` +
    "Update the running summary in 2-4 sentences. Preserve open questions.";

  const { text, stub } = await complete(
    "You are a synthesizer agent. Maintain a tight running summary across multiple rounds of findings.",
    prompt
  );

  await agent.replyAll(
    threadId,
    { runningSummary: text },
    {
      contextSnapshot: {
        step: "summary_updated",
        round: (context.snapshot?.round as number | undefined) !== undefined
          ? ((context.snapshot.round as number) + 1)
          : 1,
        lastTopic: payload.sourceTopic,
        stub,
      },
    }
  );
  await agent.markRead(threadId);
  process.stdout.write(
    `[synthesizer] replied with updated summary (stub=${stub})\n`
  );
}

async function coldResume(agent: AgentMailbox): Promise<void> {
  const threads = await agent.threads();
  for (const t of threads) {
    const { context } = await agent.sync(t.id);
    process.stdout.write(
      `[synthesizer] cold-resume thread ${t.id.slice(0, 8)} snapshot=${JSON.stringify(
        context.snapshot
      )}\n`
    );
  }
}

async function main(): Promise<void> {
  const agent = new AgentMailbox({ agentId: ME, server: SERVER });
  await agent.connect();
  process.stdout.write(`[synthesizer] online at ${SERVER}\n`);
  await coldResume(agent);

  for (;;) {
    const unread = await agent.unread();
    for (const frame of unread) {
      // Ignore our own echoes (replyAll fans out to everyone but the sender,
      // so this shouldn't fire — keeping the guard for safety).
      if (frame.from === ME) {
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
          `[synthesizer] error on ${frame.id}: ${(err as Error).message}\n`
        );
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err: Error) => {
  process.stderr.write(`[synthesizer] fatal: ${err.message}\n`);
  process.exit(1);
});

/**
 * Explorer agent. Long-running loop. When it receives a topic (from a
 * human or another agent), it generates three investigative angles and
 * sends them to the synthesizer with the original sender CC'd so they
 * stay in the thread.
 *
 * Cold-restart property: on startup, sync()s every thread it's part of
 * so the next loop iteration sees the latest snapshot from the
 * synthesizer (or anyone else) without keeping local state.
 */
import { AgentMailbox } from "agentsmcp";
import { complete } from "./llm";

const SERVER = process.env.AGENTMAILBOX_SERVER ?? "http://localhost:43500";
const ME = "explorer@demo";
const SYNTHESIZER = "synthesizer@demo";
const POLL_MS = 1500;

interface TopicPayload {
  topic?: string;
  followup?: string;
  // Anything else is fine — we only read the topic/followup fields.
}

async function handleIncoming(
  agent: AgentMailbox,
  threadId: string,
  from: string,
  payload: TopicPayload
): Promise<void> {
  const topic = payload.topic ?? payload.followup ?? "(no topic given)";
  process.stdout.write(`[explorer] topic from ${from}: ${topic}\n`);

  const { text, stub } = await complete(
    "You are an explorer agent. Given a topic, list 3 angles worth investigating, one per line.",
    topic
  );

  const angles = text.split("\n").filter((l) => l.trim().length > 0);

  await agent.send(
    SYNTHESIZER,
    { findings: text, angles, sourceTopic: topic },
    {
      threadId,
      cc: [from],
      contextSnapshot: {
        step: "angles_generated",
        anglesCount: angles.length,
        lastTopic: topic,
        stub,
      },
    }
  );
  await agent.markRead(threadId);
  process.stdout.write(
    `[explorer] handed off to synthesizer (angles=${angles.length}, stub=${stub})\n`
  );
}

async function coldResume(agent: AgentMailbox): Promise<void> {
  const threads = await agent.threads();
  for (const t of threads) {
    const { context } = await agent.sync(t.id);
    process.stdout.write(
      `[explorer] cold-resume thread ${t.id.slice(0, 8)} snapshot=${JSON.stringify(
        context.snapshot
      )}\n`
    );
  }
}

async function main(): Promise<void> {
  const agent = new AgentMailbox({ agentId: ME, server: SERVER });
  await agent.connect();
  process.stdout.write(`[explorer] online at ${SERVER}\n`);
  await coldResume(agent);

  for (;;) {
    const unread = await agent.unread();
    for (const frame of unread) {
      // Ignore the synthesizer's running summaries — that's its job, not ours.
      if (frame.from === SYNTHESIZER) {
        await agent.markRead(frame.threadId);
        continue;
      }
      try {
        await handleIncoming(
          agent,
          frame.threadId,
          frame.from,
          frame.payload as TopicPayload
        );
      } catch (err) {
        process.stderr.write(
          `[explorer] error on ${frame.id}: ${(err as Error).message}\n`
        );
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err: Error) => {
  process.stderr.write(`[explorer] fatal: ${err.message}\n`);
  process.exit(1);
});

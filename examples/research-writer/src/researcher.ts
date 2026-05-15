/**
 * Researcher agent. Loops on receive(): when it gets a new task,
 * calls Claude to "find papers", then sends results to the writer
 * with a contextSnapshot describing what it just did.
 */
import { AgentMailbox } from "agentsmcp";
import { complete } from "./llm";

const SERVER = process.env.AGENTMAILBOX_SERVER ?? "http://localhost:3000";
const ME = "researcher@demo";
const WRITER = "writer@demo";
const POLL_MS = 1500;

interface TaskPayload {
  task?: string;
  followup?: string;
}

async function handleTask(
  agent: AgentMailbox,
  threadId: string,
  from: string,
  payload: TaskPayload
): Promise<void> {
  const prompt = payload.task ?? payload.followup ?? "(no task)";
  process.stdout.write(`[researcher] task from ${from}: ${prompt}\n`);

  const { text, stub } = await complete(
    "You are a research agent. Given a topic, list a few relevant papers.",
    prompt
  );

  const papers = text.split("\n").filter((l) => l.trim().length > 0);

  await agent.send(
    WRITER,
    { findings: text, papers, sourceTask: prompt },
    {
      threadId,
      contextSnapshot: {
        step: "research_complete",
        papersFound: papers.length,
        lastQuery: prompt,
        stub,
      },
    }
  );

  await agent.markRead(threadId);
  process.stdout.write(
    `[researcher] sent findings to writer (papers=${papers.length}, stub=${stub})\n`
  );
}

async function main(): Promise<void> {
  const agent = new AgentMailbox({ agentId: ME, server: SERVER });
  await agent.connect();
  process.stdout.write(`[researcher] online at ${SERVER}\n`);

  for (;;) {
    const unread = await agent.unread();
    for (const frame of unread) {
      // ignore the writer's drafts coming back — researcher's job is to
      // start the work, not critique the draft.
      if (frame.from === WRITER) {
        await agent.markRead(frame.threadId);
        continue;
      }
      try {
        await handleTask(
          agent,
          frame.threadId,
          frame.from,
          frame.payload as TaskPayload
        );
      } catch (err) {
        process.stderr.write(
          `[researcher] error handling ${frame.id}: ${(err as Error).message}\n`
        );
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err: Error) => {
  process.stderr.write(`[researcher] fatal: ${err.message}\n`);
  process.exit(1);
});

# Research bench — a multi-agent demo you can join from Claude Desktop

Two long-running agents collaborate on a research thread. You drop in
from Claude Desktop (or any MCP-aware client) and steer them in real
time. Kill anything — nothing's lost.

This is the demo we point people at when they ask **why AgentMailbox**.

## What you'll see

1. **Cross-tool visibility.** From Claude Desktop, "what are the agents
   working on?" → Claude calls `agentsmcp_threads` + `agentsmcp_sync`,
   reads the structured summary, tells you. Zero glue code.

2. **Cross-tool steering.** "Tell the explorer to also look at
   adversarial robustness" → Claude calls `agentsmcp_send` → the
   explorer agent picks it up on its next loop. You're a peer in a
   multi-agent system without writing one line of integration.

3. **Crash-survival.** Kill the explorer mid-task. Restart it. It cold-
   resumes from the synthesizer's last snapshot. Neither the
   synthesizer nor Claude Desktop notices.

4. **Compression in action.** After ~30 messages, `agentsmcp_sync`
   returns a structured summary (`decisions`, `openQuestions`,
   `artifacts`) instead of 30 verbatim messages. Threads stay joinable
   forever without burning the context window.

## Setup

```bash
cd examples/research-bench
npm install
```

This pulls in the local `agentsmcp` build via `file:../..` plus the
Anthropic SDK. If `ANTHROPIC_API_KEY` is set the agents call Claude
Haiku; otherwise they print clearly-labeled `[STUB]` responses so the
demo runs offline.

## Run it (one command)

```bash
npm run demo
```

You'll see:

```
[server] listening on http://localhost:43500
[start] spawned explorer (pid=12345)
[start] spawned synthesizer (pid=12346)
[explorer] online at http://localhost:43500
[synthesizer] online at http://localhost:43500
[start] ready. Three ways to drive the demo: ...
```

Keep this terminal open. Ctrl-C shuts everything down.

## Wire up Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "research-bench": {
      "command": "npx",
      "args": ["-y", "agentsmcp-adapter"],
      "env": {
        "AGENTMAILBOX_AGENT_ID": "you@desktop",
        "AGENTMAILBOX_SERVER": "http://localhost:43500"
      }
    }
  }
}
```

Restart Claude Desktop. Eight tools should appear under "research-bench".

## The walkthrough

### Round 1 — kick off a topic

In Claude Desktop:

> Use the research-bench tools. Send the explorer a topic: "diffusion
> models for protein folding". Then show me whatever the synthesizer
> replies with.

Claude will:
1. Call `agentsmcp_send` with `to: "explorer@demo"` and the topic.
2. Wait a beat, call `agentsmcp_unread` until the synthesizer's
   running-summary lands in your mailbox.
3. Read it back to you.

In your supervisor terminal you'll see:

```
[explorer] topic from you@desktop: diffusion models for protein folding
[explorer] handed off to synthesizer (angles=3, stub=false)
[synthesizer] folding 3 new angles into thread abc12345
[synthesizer] replied with updated summary (stub=false)
```

### Round 2 — steer the conversation

> Now ask the explorer to also look at adversarial robustness on the
> same thread.

Claude calls `agentsmcp_send` with the existing `threadId`. The cycle
repeats. The synthesizer's running summary now folds in both rounds.

### Round 3 — the cold-restart moment

This is the one that surprises people.

In a **second terminal**, find the explorer's PID (printed by the
supervisor on startup) and kill it:

```bash
kill <explorer-pid>
# or:
pkill -f explorer.ts
```

Your supervisor terminal logs:

```
[start] explorer exited (code=null, signal=SIGTERM). Restart it with: npm run explorer
```

In the second terminal, bring it back:

```bash
cd examples/research-bench
npm run explorer
```

Watch the output:

```
[explorer] online at http://localhost:43500
[explorer] cold-resume thread abc12345 snapshot={"step":"summary_updated","round":2,...}
```

That snapshot came from the protocol, not from anything the explorer
process kept on disk. Now in Claude Desktop:

> Ask the explorer to investigate one more angle: scaling behavior.

The newly-restarted explorer picks it up like nothing happened.

### Round 4 — watch compression kick in

Send ~25 more rounds of follow-ups (you can ask Claude to "loop on
this" if you want speed). Then:

> Show me the thread context using `agentsmcp_sync`.

In the raw response you'll see a `threadSummaryStructured` field with
`decisions[]`, `openQuestions[]`, `artifacts{}` — that's the
compressed view. Older messages are gone from `recentMessages` (still
last 10) but their substance is in the structured summary.

> Tell me what the agents have decided so far.

Claude reads `threadSummaryStructured.decisions` directly. The thread
is now arbitrarily long but the context Claude sees is bounded.

## How the agents work

Both agents are ~80 lines each. The shape is the same:

```
1. Connect (idempotent).
2. coldResume(): call sync() on every existing thread so the next loop
   iteration starts from the latest snapshot. No local state needed.
3. Forever:
   - For each unread message, do the agent's job and send the result.
   - Sleep 1.5s.
```

The cold-restart property falls out of step 2 — there's nothing
process-local to lose.

Files:

- `src/explorer.ts` — generates 3 investigative angles per topic
- `src/synthesizer.ts` — folds findings into a running summary
- `src/llm.ts` — Anthropic SDK wrapper, stub fallback
- `src/start.ts` — supervisor

## Running pieces individually

If you'd rather run each piece in its own terminal:

```bash
# Terminal 1
PORT=43500 AGENTMAILBOX_DB=./bench.db npm run server

# Terminal 2
AGENTMAILBOX_SERVER=http://localhost:43500 npm run explorer

# Terminal 3
AGENTMAILBOX_SERVER=http://localhost:43500 npm run synthesizer
```

This is the layout used in the cold-restart walkthrough above.

## What's actually being demonstrated

Three properties no agent framework gives you out of the box:

| Property | Where in the code |
|---|---|
| Context survives any process crash | `coldResume()` in each agent — it's *all* the persistence logic they need |
| Any MCP client is a peer participant | `agentsmcp-adapter` exposes 8 tools to Claude Desktop; no SDK on the client side |
| Threads stay bounded as they grow | Server-side compression via `NoopCompressor` (default) or `ClaudeCompressor` (opt-in) — agents don't manage it at all |

Read [the protocol docs](../../README.md) for the broader picture.

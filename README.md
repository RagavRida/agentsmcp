# AgentMailbox

**A context-sync protocol for AI agents.** Every agent has a mailbox. No
agent ever starts cold.

[![npm](https://img.shields.io/npm/v/agentsmcp.svg?label=npm%20agentsmcp)](https://www.npmjs.com/package/agentsmcp)
[![PyPI](https://img.shields.io/pypi/v/agentsmcp.svg?label=PyPI%20agentsmcp)](https://pypi.org/project/agentsmcp/)
[![npm adapter](https://img.shields.io/npm/v/agentsmcp-adapter.svg?label=npm%20agentsmcp-adapter)](https://www.npmjs.com/package/agentsmcp-adapter)
[![CI](https://github.com/RagavRida/agentsmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/RagavRida/agentsmcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

Agents today lose context between runs, restarts, and handoffs. Every
agent framework reinvents persistence, and none of them interoperate.
AgentMailbox solves this with a single primitive: **every message
carries the thread's full state**. Any agent, any framework, any
restart picks up exactly where the last one left off.

The protocol is implemented as an HTTP server with SDKs in JavaScript
and Python, plus a Model Context Protocol adapter that exposes it to
Claude Desktop, Cursor, Continue, and every other MCP-aware client.

## Try it without installing the server

A public demo server runs at
**https://hdnxa5c8yr.us-east-1.awsapprunner.com**.

Quick gut check:

```bash
curl https://hdnxa5c8yr.us-east-1.awsapprunner.com/health
# {"ok":true}
```

Point any SDK at it and send a real message:

```ts
import { AgentMailbox } from "agentsmcp";

const alice = new AgentMailbox({
  agentId: "alice@demo",
  server: "https://hdnxa5c8yr.us-east-1.awsapprunner.com",
});
await alice.connect();
const { threadId } = await alice.send("bob@demo", { task: "hi" });
```

```python
from agentmailbox import AgentMailbox

async with AgentMailbox(
    "alice@demo",
    server="https://hdnxa5c8yr.us-east-1.awsapprunner.com",
) as alice:
    await alice.connect()
    result = await alice.send("bob@demo", {"task": "hi"})
```

> **Demo caveats.** Open access, no SLA, in-memory storage — data
> wipes on every container restart and agent IDs collide across
> users. Don't put real data on it. For anything beyond kicking the
> tires, run your own server with the [Install](#install) instructions
> below or [deploy your own](./deploy/AWS.md).

## What you get

- **Durable, addressable threads.** Send a message to `writer@app`;
  the server creates the thread, persists it, and fans it out to
  every recipient (`to`, `cc`, `bcc`).
- **Cold-restart by construction.** An agent process can crash mid-task
  and resume on restart by reading the thread — no local state, no
  checkpointing logic to write.
- **Structured context compression.** Threads stay joinable forever:
  older messages fold into a structured summary
  (`decisions`, `openQuestions`, `artifacts`) the moment they cross
  a configurable threshold. Default is zero-config; opt in to
  Claude-backed compression with one constructor argument.
- **Cross-tool peer participation.** Any MCP-aware client becomes a
  peer in the conversation without writing SDK code.
- **Multi-agent semantics.** TO / CC / BCC roles work the way email
  does, with full context propagated to every recipient.

## Install

```bash
# JavaScript / TypeScript SDK + HTTP server
npm install agentsmcp

# Python SDK (PyPI distribution name; import path stays `agentmailbox`)
pip install agentsmcp

# MCP adapter for Claude Desktop / Cursor / Continue / ...
npm install -g agentsmcp-adapter
```

## Quick start

### 1. Start the server

```bash
npx agentsmcp-server
# or, from a clone:
npm run start
```

Defaults: `http://localhost:3000`, SQLite at `./agentmailbox.db`.
Override with `PORT` and `AGENTSMCP_DB` env vars.

### 2. Send a message

```ts
import { AgentMailbox } from "agentsmcp";

const researcher = new AgentMailbox({
  agentId: "researcher@demo",
  server: "http://localhost:3000",
});
await researcher.connect();

const { threadId } = await researcher.send(
  "writer@demo",
  { task: "summarize diffusion models", papers: ["paper1", "paper2"] },
  { contextSnapshot: { step: "research_complete", paperCount: 2 } }
);
```

### 3. Receive — even after a restart

```ts
const writer = new AgentMailbox({
  agentId: "writer@demo",
  server: "http://localhost:3000",
});
await writer.connect();

const { messages, context } = await writer.receive();
// context.snapshot                  → researcher's state at send time
// context.threadSummaryStructured   → structured summary of older messages
// context.recentMessages            → last 10 verbatim
```

The Python SDK mirrors the same surface:

```python
from agentmailbox import AgentMailbox

async with AgentMailbox("writer@demo", server="http://localhost:3000") as writer:
    await writer.connect()
    result = await writer.receive()
    snapshot = result.context.snapshot
    summary = result.context.thread_summary_structured  # None until threshold crossed
```

## The headline demo

[`examples/research-bench/`](./examples/research-bench/README.md) —
a multi-agent research thread you can join from Claude Desktop. One
command boots a supervisor with two long-running agents; you drop in
via the MCP adapter and steer them. Kill any process and the system
keeps working.

It demonstrates, in one runnable artifact, the four things AgentMailbox
gives you that no other agent library does in a single page:

1. Cross-tool visibility — Claude Desktop reads agent threads via MCP.
2. Cross-tool steering — you are a peer participant, not just an
   observer.
3. Crash-survival — `coldResume()` on agent startup is the entire
   persistence story.
4. Compression in action — after ~30 messages, threads return a
   structured summary instead of raw history.

A minimal two-agent SDK-only pipeline is also available at
[`examples/research-writer/`](./examples/research-writer/README.md).

## Multi-agent threads

CC, BCC, and ReplyAll work the way email does — but with full context
propagated to every recipient on every message.

| Role | Visibility | Can reply |
|---|---|---|
| `to` | Primary recipient, context owner | Yes |
| `cc` | Active participant | Yes |
| `bcc` | Silent participant; invisible to others | Yes |

The `bcc` field is stripped from every message view except the original
sender's.

```ts
const { threadId } = await orchestrator.send(
  "researcher@demo",
  { task: "find 50 papers on diffusion models" },
  {
    cc: ["writer@demo"],
    bcc: ["logger@demo"],
    contextSnapshot: { step: "task_dispatched", priority: "high" },
  }
);

await researcher.replyAll(threadId, { result: "found 50 papers" });
```

## Context compression

Threads grow without bound; the verbatim window does not. The server
folds older messages into a structured `ThreadSummary` and caches it.

```ts
import { createServer, ClaudeCompressor } from "agentsmcp";

const { app, ready } = createServer("./db.sqlite", {
  compressor: new ClaudeCompressor(),     // reads ANTHROPIC_API_KEY
  compressionThreshold: 20,               // default
});
await ready;
app.listen(3000);
```

`ClaudeCompressor` calls Claude Haiku and extracts `{ text, decisions,
openQuestions, artifacts, coversMessageIds, generatedAt }`. The default
is `NoopCompressor` — keeps zero-config installs working without an
LLM dependency. The interface is provider-agnostic; additional
compressors (OpenAI, local models) can be added by implementing
`Compressor.compress()`.

`@anthropic-ai/sdk` is an optional peer dependency, installed only by
projects that use `ClaudeCompressor`.

## MCP adapter

`agentsmcp-adapter` exposes the protocol to any MCP-aware client. Each
adapter instance represents one agent identity.

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp-adapter"],
      "env": {
        "AGENTSMCP_AGENT_ID": "claude@local",
        "AGENTSMCP_SERVER": "http://localhost:3000"
      }
    }
  }
}
```

Eight tools and two read-only resources are exposed. See
[`mcp/README.md`](./mcp/README.md) for the full reference.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/agents/register` | Register an agent, create its mailbox |
| POST | `/messages/send` | Send a message; supports `cc`, `bcc`, `replyTo` |
| POST | `/messages/reply-all` | Reply to every visible participant |
| GET | `/mailbox/:agentId` | All threads for an agent (bcc stripped) |
| GET | `/mailbox/:agentId/unread` | Unread messages as full context frames |
| POST | `/mailbox/:agentId/read` | Mark a thread read |
| GET | `/threads/:threadId` | Full thread with messages |
| GET | `/threads/:threadId/sync` | Assembled context (snapshot + summary + recent 10) |
| GET | `/threads/:threadId/participants` | Visible participants with roles |

## Authentication

Set `AGENTSMCP_API_KEY` on the server and pass `apiKey` to every
SDK constructor. With the env var unset the server is open; with it
set, every route except `/health` requires
`Authorization: Bearer <key>` and returns 401 otherwise.

```bash
AGENTSMCP_API_KEY=s3cret npx agentsmcp-server
```

```ts
new AgentMailbox({ agentId: "x@demo", server: "...", apiKey: "s3cret" });
```

```python
AgentMailbox("x@demo", server="...", api_key="s3cret")
```

## How it works

Every message persisted by the server carries enough state for any
recipient — present or future — to reconstruct the thread without
local memory. On `receive()` or `sync()`, the server returns:

- `snapshot` — the sender's `contextSnapshot` from the last message
- `threadSummaryStructured` — a cached structured summary of older
  messages (populated once the compression threshold is crossed)
- `threadSummary` — the prose `text` field of the structured summary,
  for callers that just want a string
- `recentMessages` — last 10 messages verbatim
- `tokenCount` — rough estimate of the combined payload size

Storage is pluggable: ship-default SQLite, with the
`Storage` interface ready for Postgres and Redis adapters. Compression
is pluggable through the `Compressor` interface.

## Development

```bash
# JS SDK + server
npm ci && npx tsc --noEmit && npm test

# MCP adapter
cd mcp && npm ci && npx tsc --noEmit && npm run build

# Python SDK
cd sdk-py && pip install -e ".[dev]" && pytest -q
```

The full test matrix runs in CI on every push to `main`.

## Contributing

Contributions are welcome. The protocol is small and the surface is
deliberately stable, but there is a lot of useful work still to do.

**Particularly wanted:**

- Additional `Compressor` adapters (Gemini, Bedrock, Ollama for local
  models — OpenAI and Claude already ship). The interface is small —
  ~80 lines per adapter.
- A live smoke test for `ClaudeCompressor`. The parsing path is
  covered by mock tests; the actual "does Haiku return valid JSON"
  gate hasn't been exercised. `scripts/smoke-openai-compressor.ts`
  is the template — same shape, swap the import.
- Additional `Storage` adapters (Postgres, Redis). The `Storage`
  interface is async-first and provider-agnostic; SQLite is the
  reference implementation.
- Framework adapters (LangGraph checkpointer, CrewAI task handoff,
  Vercel AI SDK middleware).
- Real-world demos beyond `examples/research-bench`. Multi-day
  workflows, cross-language pipelines, agent-in-the-loop patterns.
- Documentation, tutorials, and integration recipes.

**Process:**

1. Open an issue describing what you want to build or change. Small
   PRs that fix bugs or add tests can skip this step.
2. Fork, branch, and submit a PR against `main`. Match the existing
   coding style (no formatter beyond TypeScript defaults; tests
   colocated with code under `tests/`).
3. CI must be green. Run the test matrix locally before pushing:
   ```bash
   npm ci && npx tsc --noEmit && npm test
   cd mcp && npm ci && npx tsc --noEmit && npm run build
   cd sdk-py && pip install -e ".[dev]" && pytest -q
   ```
4. Include a CHANGELOG entry under the current unreleased version
   header for user-visible changes.

Bug reports, design discussion, and integration questions are all
welcome in [GitHub Issues](https://github.com/RagavRida/agentsmcp/issues).

## License

MIT — see [LICENSE](./LICENSE).

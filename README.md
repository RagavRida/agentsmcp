# AgentMailbox

Context-sync protocol for AI agents.
Every agent has a mailbox. No agent ever starts cold.

[![npm](https://img.shields.io/npm/v/agentsmcp.svg?label=npm%20agentsmcp)](https://www.npmjs.com/package/agentsmcp)
[![PyPI](https://img.shields.io/pypi/v/agentsmcp.svg?label=PyPI%20agentsmcp)](https://pypi.org/project/agentsmcp/)
[![npm adapter](https://img.shields.io/npm/v/agentsmcp-adapter.svg?label=npm%20agentsmcp-adapter)](https://www.npmjs.com/package/agentsmcp-adapter)
[![CI](https://github.com/RagavRida/agentsmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/RagavRida/agentsmcp/actions/workflows/ci.yml)

## Install

```bash
# JavaScript / TypeScript SDK + server
npm install agentsmcp

# Python SDK (distribution name; import as `agentmailbox`)
pip install agentsmcp

# MCP adapter (Claude Desktop, Cursor, Continue, ...)
npm install -g agentsmcp-adapter
```

## Start the server

```bash
npx agentmailbox-server
# or, from a clone:
npm run start
```

Defaults: `http://localhost:3000`, SQLite at `./agentmailbox.db`.
Override with `PORT` and `AGENTMAILBOX_DB` env vars.

## Quick Start

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

// Writer — picks up full context even after restart.
const writer = new AgentMailbox({
  agentId: "writer@demo",
  server: "http://localhost:3000",
});
await writer.connect();

const { messages, context } = await writer.receive();
console.log(context.snapshot);
// → { step: "research_complete", paperCount: 2 }

await writer.send(
  "researcher@demo",
  { draft: "Diffusion models work by..." },
  { threadId, contextSnapshot: { step: "draft_complete", wordCount: 500 } }
);
```

Run the bundled demo:

```bash
npm run start &       # server
npm run example       # two-agent flow
```

## Authentication

Set `AGENTMAILBOX_API_KEY` on the server and pass `apiKey` to the SDK to
require auth. With the env var unset the server is open (current
behaviour). With it set, every route except `/health` requires
`Authorization: Bearer <key>` — missing or wrong returns 401.

```bash
AGENTMAILBOX_API_KEY=s3cret npx agentmailbox-server
```

```ts
new AgentMailbox({ agentId: "x@demo", server: "...", apiKey: "s3cret" });
```

```python
AgentMailbox("x@demo", server="...", api_key="s3cret")
```

## Multi-Agent Threads

CC, BCC, and ReplyAll work the way email does — but with full context
propagated to every recipient on every message.

Three roles:

- **TO** — primary recipient, context owner.
- **CC** — active participant, receives full context, can reply.
- **BCC** — silent participant, receives context, invisible to others.
  The `bcc` field is stripped from the message in every view except
  the original sender's.

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

Run the multi-agent demo:

```bash
npm run start &
npx ts-node examples/multi-agent.ts
```

**The killer demo** — multi-agent research thread you can join from
Claude Desktop, with cross-tool steering, cold-restart, and compression
in action: [`examples/research-bench/`](./examples/research-bench/README.md).

A minimal two-agent pipeline (no MCP, just SDK) is also available at
[`examples/research-writer/`](./examples/research-writer/README.md).

## MCP adapter

`agentsmcp-adapter` exposes the protocol to any MCP-aware client (Claude
Desktop, Cursor, Continue, ...) as a set of tools — no SDK or glue
code in the client.

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp-adapter"],
      "env": {
        "AGENTMAILBOX_AGENT_ID": "claude@local",
        "AGENTMAILBOX_SERVER": "http://localhost:3000"
      }
    }
  }
}
```

See [`mcp/README.md`](./mcp/README.md) for the full tool list.

## HTTP API

| Method | Path                                   | Purpose                                       |
| ------ | -------------------------------------- | --------------------------------------------- |
| POST   | `/agents/register`                     | Register an agent, create its mailbox         |
| POST   | `/messages/send`                       | Send a message; supports cc/bcc/replyTo       |
| POST   | `/messages/reply-all`                  | Reply to every visible participant on a thread |
| GET    | `/mailbox/:agentId`                    | All threads for an agent (bcc stripped)       |
| GET    | `/mailbox/:agentId/unread`             | Unread messages as full context frames        |
| POST   | `/mailbox/:agentId/read`               | Mark a thread read                            |
| GET    | `/threads/:threadId`                   | Full thread, all messages + context           |
| GET    | `/threads/:threadId/sync`              | Assembled context (snapshot + recent 10)      |
| GET    | `/threads/:threadId/participants`      | Visible participants with roles               |

## Why AgentMailbox

Agents today lose context between runs, restarts, and handoffs.
AgentMailbox makes context persistence the protocol — not an afterthought.

Every message carries:
- the recipient agent's full inbox thread
- the sender's `contextSnapshot` at send time
- a rolling summary of older messages
- the last 10 messages verbatim
- a rough token count

Pick up a thread cold, you still know exactly where things stand.

## Development

```bash
npm ci && npx tsc --noEmit && npm test
cd mcp && npm ci && npx tsc --noEmit && npm run build
cd sdk-py && pip install -e ".[dev]" && pytest -q
```

## Roadmap

- [x] Core protocol
- [x] JS SDK
- [x] CC/BCC/ReplyAll multi-agent threads
- [x] Python SDK
- [x] MCP server adapter
- [x] Optional API-key auth
- [ ] LLM-based context compression
- [ ] Cloud hosted tier
- [ ] Thread dashboard UI

## License

MIT — see [LICENSE](./LICENSE).

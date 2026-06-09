# AgentMailbox

**Cut your AI agent's context tokens by 90%.** One command to set up. Zero config files to edit.

[![npm version](https://img.shields.io/npm/v/agentsmcp.svg)](https://www.npmjs.com/package/agentsmcp)
[![npm downloads](https://img.shields.io/npm/dm/agentsmcp.svg)](https://www.npmjs.com/package/agentsmcp)
[![PyPI](https://img.shields.io/pypi/v/agentsmcp.svg)](https://pypi.org/project/agentsmcp/)
[![npm langgraph](https://img.shields.io/npm/v/agentsmcp-langgraph.svg?label=langgraph)](https://www.npmjs.com/package/agentsmcp-langgraph)
[![CI](https://github.com/RagavRida/agentsmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/RagavRida/agentsmcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![skills.sh](https://skills.sh/b/RagavRida/agentsmcp)](https://skills.sh/RagavRida/agentsmcp)

🌐 [Website](https://agentmailbox.vercel.app) · ☁️ [Cloud API](https://hdnxa5c8yr.us-east-1.awsapprunner.com) · 📖 [Docs](./deploy/AWS.md)

---

## The Problem

Every time an AI agent starts a task, it re-reads your entire codebase to understand where to make changes. For a 10,000-file repo, that's **200,000+ tokens per session** — just to figure out the architecture.

Multiply that by 50 developers, each running multiple agents daily:

| | Without AgentMailbox | With AgentMailbox |
|---|---|---|
| **Tokens per session start** | ~200,000 | ~5,000–15,000 |
| **Daily cost (50 devs)** | ~$47/day | ~$3.50/day |
| **Session start latency** | 30–60 seconds | 2–5 seconds |
| **Context across restarts** | ❌ Lost | ✅ Persistent |
| **Agent-to-agent messaging** | ❌ Custom plumbing | ✅ Built-in |

## How It Works

AgentMailbox is a **context-sync protocol** for AI agents. It sits beneath your agent framework and provides:

1. **Codebase Indexing** — A CI bot statically analyzes your code (zero LLM cost) and pushes ~40-token summaries per file to the server. Agents read summaries instead of raw source.
2. **Knowledge Graph** — Agents persist relationships (files → symbols → decisions) that survive restarts and are searchable by any agent.
3. **Smart Briefings** — When an agent starts a task, it calls `session_start("Add OAuth")` and gets back a targeted JSON briefing with relevant files, stale-file warnings, and architecture context.
4. **Async Messaging** — Agents leave messages for each other in threads (TO/CC/BCC), enabling parallel multi-agent workflows without blocking.

## Quick Start — One Command

```bash
npx agentsmcp init
```

That's it. The wizard:
1. Detects your MCP clients (Claude Desktop, Cursor, Continue)
2. Opens GitHub login in your browser — one click to authorize
3. Writes the config to each client (backs up existing configs first)
4. Done. Restart your MCP client.

**Scripted / CI-friendly:**

```bash
# Fully unattended — GitHub OAuth
npx agentsmcp init --yes --github --all

# Use an existing API key
npx agentsmcp init --api-key sk_live_xxx --all

# Just one client
npx agentsmcp init --api-key sk_live_xxx --client cursor
```

After restart, your agent has all **24 MCP tools** available — persistent memory, async messaging, codebase search, and more.

## Platform Integration Guides

<details>
<summary><b>Cursor</b></summary>

Add to **Settings → MCP → Add** (or let `npx agentsmcp init` do it):

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp"],
      "env": {
        "AGENTSMCP_AGENT_ID": "cursor@local",
        "AGENTSMCP_SERVER": "https://hdnxa5c8yr.us-east-1.awsapprunner.com",
        "AGENTSMCP_API_KEY": "sk_live_YOUR_KEY"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "agentsmcp": {
      "command": "npx",
      "args": ["-y", "agentsmcp"],
      "env": {
        "AGENTSMCP_AGENT_ID": "claude@desktop",
        "AGENTSMCP_SERVER": "https://hdnxa5c8yr.us-east-1.awsapprunner.com",
        "AGENTSMCP_API_KEY": "sk_live_YOUR_KEY"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add agentsmcp -- npx -y agentsmcp
```

Set environment variables:
```
AGENTSMCP_AGENT_ID=claude-code@local
AGENTSMCP_SERVER=https://hdnxa5c8yr.us-east-1.awsapprunner.com
AGENTSMCP_API_KEY=sk_live_YOUR_KEY
```
</details>

<details>
<summary><b>Antigravity / Gemini CLI</b></summary>

```bash
npx skills add RagavRida/agentsmcp
```
</details>

<details>
<summary><b>Any MCP Client (Continue, Cline, Windsurf, …)</b></summary>

Same config shape: `command: npx`, `args: ["-y", "agentsmcp"]` with the three env vars: `AGENTSMCP_AGENT_ID`, `AGENTSMCP_SERVER`, `AGENTSMCP_API_KEY`.
</details>

### Python

```bash
pip install agentsmcp
```

```python
from agentmailbox import AgentMailbox

agent = AgentMailbox(
    agent_id="my-agent@app",
    server="https://hdnxa5c8yr.us-east-1.awsapprunner.com",
    api_key="sk_live_YOUR_KEY",
)

# Send & receive
await agent.send("other-agent@app", {"task": "analyze data"})
messages = await agent.receive()

# Context graph
await agent.upsert_node(id="file:main.py", type="file", name="main.py",
                        description="Entrypoint")
result = await agent.query_graph("main")

# Codebase index
await agent.upsert_index(key="file:main.py", category="file",
                         summary="FastAPI entrypoint with lifespan handlers")
hits = await agent.search_index("FastAPI", category="file")
```

### JavaScript / TypeScript

```bash
npm install agentsmcp
```

```ts
import { AgentMailbox } from "agentsmcp";

const agent = new AgentMailbox({
  agentId: "my-agent@app",
  server: "https://hdnxa5c8yr.us-east-1.awsapprunner.com",
  apiKey: "sk_live_YOUR_KEY",
});

await agent.send("other@app", { task: "done", result: data });
const { messages } = await agent.receive();

// Context graph
await agent.upsertNode({ id: "file:server.ts", type: "file", name: "server.ts" });
const { nodes, edges } = await agent.queryGraph("server");

// Codebase index
await agent.upsertIndex({ key: "api:POST /invoke", category: "api",
                           summary: "Invokes the compiled graph" });
const hits = await agent.searchIndex("invoke", "api");
```

### LangGraph

```bash
npm install agentsmcp-langgraph @langchain/langgraph
```

```ts
import { AgentsmcpSaver } from "agentsmcp-langgraph";

const checkpointer = new AgentsmcpSaver({
  server: "https://hdnxa5c8yr.us-east-1.awsapprunner.com",
  agentId: "langgraph@my-app",
  apiKey: "sk_live_YOUR_KEY",
});
await checkpointer.connect();

const graph = workflow.compile({ checkpointer });
await graph.invoke(input, { configurable: { thread_id: "session-abc" } });
```

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        Your Agents                             │
│  Claude Desktop  │  Cursor  │  Python Script  │  LangGraph     │
└────────┬─────────┴────┬─────┴───────┬─────────┴───────┬────────┘
         │ MCP          │ MCP         │ SDK             │ Saver
         ▼              ▼             ▼                 ▼
┌────────────────────────────────────────────────────────────────┐
│                   AgentMailbox Server                           │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Messaging│  │ Knowledge │  │ Codebase │  │   Context     │  │
│  │ Threads  │  │   Graph   │  │  Index   │  │  Compression  │  │
│  └──────────┘  └───────────┘  └──────────┘  └──────────────┘  │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────────────────┐│
│  │Rate Limit│  │  GitHub   │  │ Multi-tenant Scoped Storage  ││
│  │& Auth    │  │  OAuth    │  │   SQLite (local) │ Postgres   ││
│  └──────────┘  └───────────┘  └──────────────────────────────┘│
└────────────────────────────────────────────────────────────────┘
         │                                              │
    ┌────▼────┐                                    ┌────▼────┐
    │  SQLite │  (single dev, zero config)         │Postgres │  (cloud, multi-tenant)
    └─────────┘                                    └─────────┘
```

## MCP Tools (24 tools)

| Category | Tool | What it does |
|:---|:---|:---|
| **Session** | `agentsmcp_session_start` | Smart context briefing — graph + index + stale detection |
| | `agentsmcp_context_briefing` | Targeted briefing for a specific task |
| **Messaging** | `agentsmcp_send` | Send a message to another agent |
| | `agentsmcp_receive` | Get unread messages with full thread context |
| | `agentsmcp_reply_all` | Reply to all participants on a thread |
| | `agentsmcp_mark_read` | Mark a thread as read |
| | `agentsmcp_threads` | List all threads |
| | `agentsmcp_sync` | Sync full context for a thread |
| | `agentsmcp_unread` | Peek at unread without consuming |
| | `agentsmcp_participants` | Get participants and roles |
| **Graph** | `agentsmcp_upsert_node` | Persist a knowledge graph node |
| | `agentsmcp_add_edge` | Connect two nodes with a typed edge |
| | `agentsmcp_query_graph` | Keyword search + N-hop traversal |
| **Index** | `agentsmcp_upsert_index` | Register/update a codebase summary |
| | `agentsmcp_get_index` | Exact-key lookup |
| | `agentsmcp_search_index` | Keyword search with category filter |
| | `agentsmcp_check_staleness` | Batch hash check for stale files |
| | `agentsmcp_rollup_module` | Aggregate file summaries into modules |
| **Git** | `agentsmcp_git_commit` | Create a commit |
| | `agentsmcp_git_diff` | View staged/unstaged changes |
| | `agentsmcp_git_log` | View commit history |
| | `agentsmcp_git_branch` | Branch operations |
| **Annotations** | `agentsmcp_annotate_file` | Add inline code annotations |
| | `agentsmcp_get_annotations` | Read annotations for a file |

## Self-Hosted

Free, unlimited, MIT-licensed. SQLite by default, Postgres when you need it.

```bash
# SQLite (zero config)
npx agentsmcp-server

# Postgres
AGENTSMCP_DB=postgresql://user:pass@localhost:5432/agentsmcp \
  npx agentsmcp-server

# With auth
AGENTSMCP_API_KEY=your-secret npx agentsmcp-server

# With LLM compression
ANTHROPIC_API_KEY=sk-ant-xxx npx agentsmcp-server
```

See [deploy/AWS.md](./deploy/AWS.md) for a Docker + App Runner walkthrough.

## Free Tier (Cloud)

| Resource | Limit |
|:---|:---|
| Agents | 10 |
| Messages / day | 500 |
| Threads | 100 |
| Retention | 7 days |
| API keys | 2 |

Need more? [Self-host](#self-hosted) for unlimited — same code, MIT licensed.

## API Reference

<details>
<summary><b>Messaging Endpoints</b></summary>

| Method | Endpoint | Description |
|:---|:---|:---|
| POST | `/auth/register` | Sign up, get API key |
| POST | `/auth/github` | GitHub OAuth login |
| GET | `/auth/me` | Your account + usage |
| GET | `/auth/keys` | List active API keys |
| POST | `/auth/keys` | Mint an additional key |
| DELETE | `/auth/keys/:keyId` | Revoke a key |
| POST | `/agents/register` | Register an agent |
| POST | `/messages/send` | Send message (TO/CC/BCC) |
| POST | `/messages/reply-all` | Reply to all participants |
| GET | `/mailbox/:agentId` | List threads |
| GET | `/mailbox/:agentId/unread` | Unread messages + context |
| POST | `/mailbox/:agentId/read` | Mark thread as read |
| GET | `/threads/:threadId` | Thread detail |
| GET | `/threads/:threadId/sync` | Assembled context frame |
| GET | `/health` | Health check |
</details>

<details>
<summary><b>Context Graph Endpoints</b></summary>

| Method | Endpoint | Description |
|:---|:---|:---|
| POST | `/mailbox/:agentId/graph/nodes` | Upsert a node |
| DELETE | `/mailbox/:agentId/graph/nodes/:nodeId` | Delete a node + edges |
| POST | `/mailbox/:agentId/graph/edges` | Add a directed edge |
| DELETE | `/mailbox/:agentId/graph/edges` | Remove an edge |
| GET | `/mailbox/:agentId/graph/query?q=…&limit=N&depth=D` | Search + traversal |
</details>

<details>
<summary><b>Codebase Index Endpoints</b></summary>

| Method | Endpoint | Description |
|:---|:---|:---|
| POST | `/mailbox/:agentId/index` | Upsert an entry |
| GET | `/mailbox/:agentId/index?q=…&category=…&limit=N` | Keyword search |
| GET | `/mailbox/:agentId/index/:key` | Exact-key lookup |
| DELETE | `/mailbox/:agentId/index/:key` | Delete an entry |
| POST | `/mailbox/:agentId/index/check-staleness` | Batch hash check |
| POST | `/mailbox/:agentId/index/rollup` | Aggregate file summaries |
</details>

## Development

```bash
# Install + type-check + test
npm ci && npx tsc --noEmit && npm test

# End-to-end smoke test
npm run smoke:e2e

# LangGraph adapter
cd langgraph && npm install && npm run build && npm test

# Python SDK
cd sdk-py && pip install -e ".[dev]" && pytest -q
```

163 tests across 16 test files. Full matrix (JS + LangGraph + Python 3.10/3.11/3.12) runs in CI on every push.

## Contributing

Contributions welcome! Particularly wanted:

- **Framework adapters** — CrewAI, OpenAI Agents SDK, AutoGen, Vercel AI SDK
- **Compressor adapters** — Gemini, Bedrock, Ollama (Claude and OpenAI already ship)
- **Storage adapters** — Redis, DynamoDB (SQLite and Postgres are done)
- **Demos** — Multi-day workflows, cross-language pipelines, agent-in-the-loop patterns

See the [Contributing Guide](#contributing) for process details.

## License

MIT — see [LICENSE](./LICENSE).

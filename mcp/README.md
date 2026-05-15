# agentsmcp-adapter

MCP server adapter for [agentsmcp](https://www.npmjs.com/package/agentsmcp)
(the AgentMailbox protocol). Exposes AgentMailbox to any MCP-aware
client. Each MCP server instance represents one agent identity.

## Install

```bash
npm install -g agentsmcp-adapter
```

This pulls in the `agentsmcp` SDK as a dependency — no separate setup.

## Configuration

Required:

- `AGENTMAILBOX_AGENT_ID` — the agent identity this MCP server represents
  (e.g. `claude@local`).

Optional:

- `AGENTMAILBOX_SERVER` — HTTP server URL, defaults to `http://localhost:3000`.
- `AGENTMAILBOX_API_KEY` — passed through as a Bearer token.

CLI flags mirror env vars and take precedence:

```bash
agentsmcp-adapter --agent-id claude@local --server http://localhost:3000
```

Make sure the AgentMailbox HTTP server is running first (`npx agentmailbox-server`
or `npm start` in a clone).

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

## Cursor / Continue / other MCP clients

Same shape — point them at `npx -y agentsmcp-adapter` with
`AGENTMAILBOX_AGENT_ID` set.

## Available tools

| Tool                    | Description                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| `agentsmcp_send`        | Send a message to another agent; auto-creates a thread if needed.      |
| `agentsmcp_receive`     | Get unread messages with full thread context attached.                 |
| `agentsmcp_unread`      | List unread context frames without consuming them.                     |
| `agentsmcp_sync`        | Rejoin a thread with full assembled context.                           |
| `agentsmcp_threads`     | List all threads this agent is part of.                                |
| `agentsmcp_mark_read`   | Mark a thread as read for this agent.                                  |
| `agentsmcp_reply_all`   | Reply to every visible participant on a thread.                        |
| `agentsmcp_participants`| List visible participants on a thread with their roles (to/cc/bcc).    |

Two read-only MCP resources are also exposed:

- `agentsmcp://mailbox` — JSON listing of all threads.
- `agentsmcp://thread/{threadId}` — JSON with thread context and participants.

## Why MCP

A two-agent system used to require both agents to install the JS or
Python SDK. With this adapter, any MCP-aware client gets a mailbox for
free — no SDK, no glue code. Cross-tool context sync becomes a
config-file change.

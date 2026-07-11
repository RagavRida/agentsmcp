import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer, type TestServer } from "./setup";
import { listToolDefs, runTool } from "../src/mcp/tools";
import { AgentMailbox } from "../src/agentmailbox";

let server: TestServer;
let agent: AgentMailbox;

describe("MCP tools — listToolDefs", () => {
  it("returns all 31 tool definitions with valid schemas", () => {
    const tools = listToolDefs();
    expect(tools.length).toBe(49);

    // Every tool has the expected shape
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name).toMatch(/^agentsmcp_/);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.inputSchema).toBe("object");
      expect(t.inputSchema).toHaveProperty("type");
    }
  });

  it("includes all expected tool names", () => {
    const names = listToolDefs().map((t) => t.name).sort();
    expect(names).toEqual([
      "agentsmcp_add_edge",
      "agentsmcp_analyze_legacy_impact",
      "agentsmcp_annotate_file",
      "agentsmcp_check_staleness",
      "agentsmcp_context_briefing",
      "agentsmcp_declare_interest",
      "agentsmcp_forget",
      "agentsmcp_generate_training_data",
      "agentsmcp_get_chunk_neighbors",
      "agentsmcp_get_index",
      "agentsmcp_get_learned_rules",
      "agentsmcp_git_commit",
      "agentsmcp_git_diff",
      "agentsmcp_git_log",
      "agentsmcp_git_restore",
      "agentsmcp_health",
      "agentsmcp_impact_analysis",
      "agentsmcp_improve",
      "agentsmcp_learn_rules",
      "agentsmcp_list_data",
      "agentsmcp_mark_read",
      "agentsmcp_parse_cobol",
      "agentsmcp_parse_jcl",
      "agentsmcp_parse_pli",
      "agentsmcp_parse_rexx",
      "agentsmcp_participants",
      "agentsmcp_post_edit_annotate",
      "agentsmcp_prune",
      "agentsmcp_query_deepseek",
      "agentsmcp_query_graph",
      "agentsmcp_recall",
      "agentsmcp_receive",
      "agentsmcp_remember",
      "agentsmcp_reply_all",
      "agentsmcp_rollup_module",
      "agentsmcp_run_eval",
      "agentsmcp_run_optimize_loop",
      "agentsmcp_save_interaction",
      "agentsmcp_search_index",
      "agentsmcp_semantic_search",
      "agentsmcp_send",
      "agentsmcp_session_start",
      "agentsmcp_sync",
      "agentsmcp_task_status",
      "agentsmcp_threads",
      "agentsmcp_unread",
      "agentsmcp_upsert_index",
      "agentsmcp_upsert_node",
      "agentsmcp_usage_stats",
    ]);
  });
});

describe("MCP tools — runTool (integration)", () => {
  beforeEach(async () => {
    server = await startServer();
    agent = new AgentMailbox({ agentId: "alice@test", server: server.url });
    await agent.connect();
    // Register a second agent for messaging
    const bob = new AgentMailbox({ agentId: "bob@test", server: server.url });
    await bob.connect();
  });
  afterEach(async () => {
    await server.close();
  });

  it("throws on unknown tool name", async () => {
    await expect(runTool(agent, "nonexistent_tool", {})).rejects.toThrow(
      "unknown tool"
    );
  });

  it("agentsmcp_send + agentsmcp_receive round-trip", async () => {
    const sendResult = (await runTool(agent, "agentsmcp_send", {
      to: "bob@test",
      payload: { task: "test round-trip" },
    })) as { messageId: string; threadId: string; deliveredTo: string[] };

    expect(sendResult.messageId).toBeDefined();
    expect(sendResult.threadId).toBeDefined();
    expect(sendResult.deliveredTo).toContain("bob@test");

    // Receive from bob's perspective
    const bob = new AgentMailbox({ agentId: "bob@test", server: server.url });
    const receiveResult = (await runTool(bob, "agentsmcp_receive", {})) as {
      messages: Array<{ from: string; payload: unknown }>;
      context: unknown;
    };
    expect(receiveResult.messages.length).toBe(1);
    expect(receiveResult.messages[0].from).toBe("alice@test");
  });

  it("agentsmcp_threads returns thread list", async () => {
    // Send a message first to create a thread
    await runTool(agent, "agentsmcp_send", {
      to: "bob@test",
      payload: { data: 1 },
    });

    const threads = (await runTool(agent, "agentsmcp_threads", {})) as Array<{
      id: string;
    }>;
    expect(threads.length).toBe(1);
  });

  it("agentsmcp_sync returns context after messages", async () => {
    const { threadId } = (await runTool(agent, "agentsmcp_send", {
      to: "bob@test",
      payload: { data: "sync-test" },
      contextSnapshot: { step: "init" },
    })) as { threadId: string };

    const context = (await runTool(agent, "agentsmcp_sync", {
      threadId,
    })) as { recentMessages: unknown[]; snapshot: Record<string, unknown> };

    expect(context.recentMessages.length).toBe(1);
  });

  it("agentsmcp_unread returns frames without consuming", async () => {
    await runTool(agent, "agentsmcp_send", {
      to: "bob@test",
      payload: { data: "unread-test" },
    });

    const bob = new AgentMailbox({ agentId: "bob@test", server: server.url });
    const frames1 = (await runTool(bob, "agentsmcp_unread", {})) as unknown[];
    expect(frames1.length).toBe(1);

    // Unread should not consume — calling again returns same
    const frames2 = (await runTool(bob, "agentsmcp_unread", {})) as unknown[];
    expect(frames2.length).toBe(1);
  });

  it("agentsmcp_mark_read clears unread", async () => {
    const { threadId } = (await runTool(agent, "agentsmcp_send", {
      to: "bob@test",
      payload: { data: "mark-read-test" },
    })) as { threadId: string };

    const bob = new AgentMailbox({ agentId: "bob@test", server: server.url });
    const before = (await runTool(bob, "agentsmcp_unread", {})) as unknown[];
    expect(before.length).toBe(1);

    await runTool(bob, "agentsmcp_mark_read", { threadId });

    const after = (await runTool(bob, "agentsmcp_unread", {})) as unknown[];
    expect(after.length).toBe(0);
  });

  it("agentsmcp_reply_all delivers to all visible participants", async () => {
    const { threadId } = (await runTool(agent, "agentsmcp_send", {
      to: "bob@test",
      payload: { msg: "initial" },
    })) as { threadId: string };

    const bob = new AgentMailbox({ agentId: "bob@test", server: server.url });
    const replyResult = (await runTool(bob, "agentsmcp_reply_all", {
      threadId,
      payload: { msg: "reply" },
    })) as { deliveredTo: string[] };

    expect(replyResult.deliveredTo).toContain("alice@test");
  });

  it("agentsmcp_participants lists thread participants", async () => {
    const { threadId } = (await runTool(agent, "agentsmcp_send", {
      to: "bob@test",
      payload: { msg: "participants-test" },
      cc: ["carol@test"],
    })) as { threadId: string };

    // Register carol
    const carol = new AgentMailbox({ agentId: "carol@test", server: server.url });
    await carol.connect();

    const participants = (await runTool(agent, "agentsmcp_participants", {
      threadId,
    })) as Array<{ agentId: string; role: string }>;

    const ids = participants.map((p) => p.agentId).sort();
    expect(ids).toContain("alice@test");
    expect(ids).toContain("bob@test");
    expect(ids).toContain("carol@test");
  });
});

describe("MCP tools — context graph", () => {
  beforeEach(async () => {
    server = await startServer();
    agent = new AgentMailbox({ agentId: "alice@test", server: server.url });
    await agent.connect();
  });
  afterEach(async () => {
    await server.close();
  });

  it("agentsmcp_upsert_node + agentsmcp_query_graph round-trip", async () => {
    await runTool(agent, "agentsmcp_upsert_node", {
      id: "file:src/server.ts",
      type: "file",
      name: "server.ts",
      description: "Main HTTP server entry point",
    });

    const result = (await runTool(agent, "agentsmcp_query_graph", {
      query: "server",
    })) as { nodes: Array<{ id: string; name: string }>; edges: unknown[] };

    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.nodes.some((n) => n.id === "file:src/server.ts")).toBe(true);
  });

  it("agentsmcp_add_edge creates edges between nodes", async () => {
    await runTool(agent, "agentsmcp_upsert_node", {
      id: "file:a.ts",
      type: "file",
      name: "a.ts",
    });
    await runTool(agent, "agentsmcp_upsert_node", {
      id: "symbol:foo",
      type: "symbol",
      name: "foo",
    });

    const edgeResult = await runTool(agent, "agentsmcp_add_edge", {
      sourceId: "file:a.ts",
      targetId: "symbol:foo",
      type: "contains",
    });
    expect(edgeResult).toEqual({ ok: true });

    // Query should return both nodes + edge
    const graph = (await runTool(agent, "agentsmcp_query_graph", {
      query: "foo",
    })) as { nodes: unknown[]; edges: unknown[] };
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
  });
});

describe("MCP tools — codebase index", () => {
  beforeEach(async () => {
    server = await startServer();
    agent = new AgentMailbox({ agentId: "alice@test", server: server.url });
    await agent.connect();
  });
  afterEach(async () => {
    await server.close();
  });

  it("agentsmcp_upsert_index + agentsmcp_get_index round-trip", async () => {
    await runTool(agent, "agentsmcp_upsert_index", {
      key: "file:src/server.ts",
      category: "file",
      summary: "Express HTTP server with REST routes for agent messaging",
    });

    const entry = (await runTool(agent, "agentsmcp_get_index", {
      key: "file:src/server.ts",
    })) as { found: boolean; key: string; summary: string };

    expect(entry.found).toBe(true);
    expect(entry.key).toBe("file:src/server.ts");
    expect(entry.summary).toContain("Express");
  });

  it("agentsmcp_get_index returns found:false for missing key", async () => {
    const entry = (await runTool(agent, "agentsmcp_get_index", {
      key: "nonexistent",
    })) as { found: boolean };
    expect(entry.found).toBe(false);
  });

  it("agentsmcp_search_index finds entries by keyword", async () => {
    await runTool(agent, "agentsmcp_upsert_index", {
      key: "file:src/auth.ts",
      category: "file",
      summary: "JWT authentication middleware",
    });
    await runTool(agent, "agentsmcp_upsert_index", {
      key: "api:POST /login",
      category: "api",
      summary: "Login endpoint, returns JWT token",
    });

    const results = (await runTool(agent, "agentsmcp_search_index", {
      query: "JWT",
    })) as Array<{ key: string }>;
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("agentsmcp_search_index filters by category", async () => {
    await runTool(agent, "agentsmcp_upsert_index", {
      key: "file:src/auth.ts",
      category: "file",
      summary: "JWT authentication",
    });
    await runTool(agent, "agentsmcp_upsert_index", {
      key: "api:POST /login",
      category: "api",
      summary: "JWT login endpoint",
    });

    const apiOnly = (await runTool(agent, "agentsmcp_search_index", {
      query: "JWT",
      category: "api",
    })) as Array<{ key: string; category: string }>;

    for (const e of apiOnly) {
      expect(e.category).toBe("api");
    }
  });
});

describe("MCP tools — context briefing", () => {
  beforeEach(async () => {
    server = await startServer();
    agent = new AgentMailbox({ agentId: "alice@test", server: server.url });
    await agent.connect();
  });
  afterEach(async () => {
    await server.close();
  });

  it("agentsmcp_context_briefing returns structured briefing", async () => {
    // Seed some data
    await runTool(agent, "agentsmcp_upsert_node", {
      id: "file:auth.ts",
      type: "file",
      name: "auth.ts",
      description: "Authentication module with JWT",
    });
    await runTool(agent, "agentsmcp_upsert_index", {
      key: "file:auth.ts",
      category: "file",
      summary: "Handles JWT authentication",
    });

    const briefing = (await runTool(agent, "agentsmcp_context_briefing", {
      task: "Fix the authentication JWT token expiry bug",
    })) as {
      task: string;
      relevantNodes: unknown[];
      relationships: unknown[];
      indexEntries: unknown[];
    };

    expect(briefing.task).toBe("Fix the authentication JWT token expiry bug");
    expect(Array.isArray(briefing.relevantNodes)).toBe(true);
    expect(Array.isArray(briefing.indexEntries)).toBe(true);
  });
});

import { z, ZodTypeAny } from "zod";
// The recursive JsonValue schema explodes zod-to-json-schema's generic
// inference (TS2589). Erase the type at the import boundary; the returned
// shape is a JSON Schema object which we expose as Record<string, unknown>.
import { zodToJsonSchema as _raw } from "zod-to-json-schema";
const _zodToJsonSchema = _raw as (s: unknown, opts?: unknown) => unknown;
import type { AgentMailbox } from "../agentmailbox";

const toJsonSchema = (s: ZodTypeAny): Record<string, unknown> =>
  _zodToJsonSchema(s, { target: "openApi3" }) as Record<string, unknown>;

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(JsonValue),
  ])
);

const SendInput = z.object({
  to: z.string().min(1).describe("Recipient agent id"),
  payload: JsonValue.describe("Arbitrary JSON payload"),
  threadId: z.string().optional(),
  contextSnapshot: z.record(JsonValue).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  replyTo: z.string().optional(),
});

const ReceiveInput = z.object({
  from: z.string().optional().describe("Filter to messages from this sender"),
  recent: z.number().int().min(1).max(50).optional()
    .describe("Max recent messages to include in each context frame (default 3, max 50). Lower = fewer tokens."),
});

const EmptyInput = z.object({}).strict();

const ThreadIdInput = z.object({
  threadId: z.string().min(1),
});

const ReplyAllInput = z.object({
  threadId: z.string().min(1),
  payload: JsonValue,
  contextSnapshot: z.record(JsonValue).optional(),
});

const MarkReadInput = z.object({
  threadId: z.string().min(1),
});

const UpsertNodeInput = z.object({
  id: z.string().min(1).describe("Unique node id, e.g. 'file:src/auth.ts' or 'decision:use-jwt'"),
  type: z.enum(["message", "file", "symbol", "decision", "task"]).describe("Node type"),
  name: z.string().min(1).describe("Human-readable name"),
  description: z.string().optional().describe("Short summary of this node"),
  metadata: z.record(JsonValue).optional().describe("Arbitrary JSON metadata"),
});

const AddEdgeInput = z.object({
  sourceId: z.string().min(1).describe("Source node id"),
  targetId: z.string().min(1).describe("Target node id"),
  type: z.string().min(1).describe("Edge type: references, contains, resolves, depends_on, semantic"),
  weight: z.number().optional().describe("Edge weight (default 1.0)"),
});

const QueryGraphInput = z.object({
  query: z.string().min(1).describe("Search keywords to match against node names and descriptions"),
  limit: z.number().int().min(1).max(100).optional()
    .describe("Max nodes to return (default 30). Lower = fewer tokens."),
});

const UpsertIndexInput = z.object({
  key: z.string().min(1).describe("Unique key, e.g. 'file:src/server.ts' or 'api:POST /messages/send'"),
  category: z.enum(["file", "symbol", "api", "config", "architecture", "module", "overview"])
    .describe("Entry category"),
  summary: z.string().min(1).describe("200-token max summary of this entry"),
  metadata: z.record(JsonValue).optional().describe("Arbitrary JSON metadata (exports, imports, line count, etc.)"),
  contentHash: z.string().optional().describe("SHA-256 of the raw file content — enables staleness checks"),
  parentKey: z.string().optional().describe("Parent module key, e.g. 'module:auth'"),
  indexedBy: z.string().optional().describe("AgentId that created this entry"),
});

const GetIndexInput = z.object({
  key: z.string().min(1).describe("The exact key to look up"),
});

const SearchIndexInput = z.object({
  query: z.string().min(1).describe("Search keywords"),
  category: z.enum(["file", "symbol", "api", "config", "architecture", "module", "overview"])
    .optional().describe("Optional category filter"),
  limit: z.number().int().min(1).max(100).optional()
    .describe("Max results to return (default 20). Lower = fewer tokens."),
});

const ContextBriefingInput = z.object({
  task: z.string().min(1).describe("Description of the task you're about to work on"),
  include_threads: z.boolean().optional().describe("If true, include recent thread context in the briefing (default false)"),
});

type ToolHandler = (agent: AgentMailbox, args: unknown) => Promise<unknown>;

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: ToolHandler;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: "agentsmcp_send",
    description:
      "Send a message to another agent. Auto-creates a thread if none exists " +
      "between sender and recipient. Use cc for active participants, bcc for " +
      "silent ones. contextSnapshot captures your current state so the " +
      "recipient can pick up cold.",
    schema: SendInput,
    handler: async (agent, raw) => {
      const args = SendInput.parse(raw);
      return agent.send(args.to, args.payload, {
        threadId: args.threadId,
        contextSnapshot: args.contextSnapshot,
        cc: args.cc,
        bcc: args.bcc,
        replyTo: args.replyTo,
      });
    },
  },
  {
    name: "agentsmcp_receive",
    description:
      "Get unread messages addressed to this agent, with full thread context " +
      "attached to each. Use this at the start of a turn to pick up cold. " +
      "Pass recent=3 (default) to keep context compact; increase only when " +
      "you need deeper history.",
    schema: ReceiveInput,
    handler: async (agent, raw) => {
      const args = ReceiveInput.parse(raw);
      return agent.receive(args.from, { recent: args.recent ?? 3 });
    },
  },
  {
    name: "agentsmcp_unread",
    description: "List unread context frames without consuming them.",
    schema: EmptyInput,
    handler: async (agent, raw) => {
      EmptyInput.parse(raw ?? {});
      return agent.unread();
    },
  },
  {
    name: "agentsmcp_sync",
    description:
      "Rejoin a thread with full assembled context (snapshot + recent 10 " +
      "messages verbatim + summary of older ones). Use after a restart or " +
      "when picking up a stale thread.",
    schema: ThreadIdInput,
    handler: async (agent, raw) => {
      const { threadId } = ThreadIdInput.parse(raw);
      const { context } = await agent.sync(threadId);
      return context;
    },
  },
  {
    name: "agentsmcp_threads",
    description: "List all threads this agent is part of.",
    schema: EmptyInput,
    handler: async (agent, raw) => {
      EmptyInput.parse(raw ?? {});
      return agent.threads();
    },
  },
  {
    name: "agentsmcp_mark_read",
    description: "Mark a thread as read for this agent.",
    schema: MarkReadInput,
    handler: async (agent, raw) => {
      const { threadId } = MarkReadInput.parse(raw);
      await agent.markRead(threadId);
      return { ok: true };
    },
  },
  {
    name: "agentsmcp_reply_all",
    description:
      "Reply to every visible participant on a thread (excluding the sender " +
      "and BCC'd agents).",
    schema: ReplyAllInput,
    handler: async (agent, raw) => {
      const args = ReplyAllInput.parse(raw);
      return agent.replyAll(args.threadId, args.payload, {
        contextSnapshot: args.contextSnapshot,
      });
    },
  },
  {
    name: "agentsmcp_participants",
    description:
      "List visible participants on a thread with their roles (to/cc/bcc). " +
      "BCC participants are only shown if this agent bcc'd them.",
    schema: ThreadIdInput,
    handler: async (agent, raw) => {
      const { threadId } = ThreadIdInput.parse(raw);
      return agent.participants(threadId);
    },
  },

  // ---------- Context Graph ----------

  {
    name: "agentsmcp_upsert_node",
    description:
      "Register a context graph node (file, symbol, decision, task, or message). " +
      "Call this when you create/modify files, implement symbols, make design " +
      "decisions, or track tasks. The node persists across sessions so future " +
      "agents can query it instead of re-reading raw files.",
    schema: UpsertNodeInput,
    handler: async (agent, raw) => {
      const args = UpsertNodeInput.parse(raw);
      await agent.upsertNode({
        id: args.id,
        type: args.type,
        name: args.name,
        description: args.description,
        metadata: (args.metadata ?? {}) as Record<string, unknown>,
      });
      return { ok: true, nodeId: args.id };
    },
  },
  {
    name: "agentsmcp_add_edge",
    description:
      "Connect two graph nodes with a typed, directed edge. Edge types: " +
      "references (message→file), contains (file→symbol), resolves " +
      "(symbol→task), depends_on (symbol→symbol), semantic (any→any).",
    schema: AddEdgeInput,
    handler: async (agent, raw) => {
      const args = AddEdgeInput.parse(raw);
      await agent.addEdge({
        sourceId: args.sourceId,
        targetId: args.targetId,
        type: args.type,
        weight: args.weight ?? 1.0,
      });
      return { ok: true };
    },
  },
  {
    name: "agentsmcp_query_graph",
    description:
      "Search the context graph by keywords and return matching nodes plus " +
      "all nodes reachable within 2 hops. Use this INSTEAD of grepping and " +
      "reading files — it returns structured context (files, symbols, " +
      "decisions, tasks) with their relationships. Use limit to control " +
      "result size (default 30).",
    schema: QueryGraphInput,
    handler: async (agent, raw) => {
      const { query, limit } = QueryGraphInput.parse(raw);
      return agent.queryGraph(query, { limit });
    },
  },

  // ---------- Codebase Index ----------

  {
    name: "agentsmcp_upsert_index",
    description:
      "Register a codebase index entry (file summary, symbol summary, API " +
      "contract, config description, or architecture note). Call this when " +
      "you finish working on a file to persist a ~200-token summary so " +
      "future agents can look it up instead of reading the full file.",
    schema: UpsertIndexInput,
    handler: async (agent, raw) => {
      const args = UpsertIndexInput.parse(raw);
      await agent.upsertIndex({
        key: args.key,
        category: args.category,
        summary: args.summary,
        metadata: (args.metadata ?? {}) as Record<string, unknown>,
      });
      return { ok: true, key: args.key };
    },
  },
  {
    name: "agentsmcp_get_index",
    description:
      "Look up a specific codebase index entry by key. Use this INSTEAD of " +
      "reading an entire file when you just need to know what a file does, " +
      "what it exports, or its role in the architecture.",
    schema: GetIndexInput,
    handler: async (agent, raw) => {
      const { key } = GetIndexInput.parse(raw);
      const entry = await agent.getIndex(key);
      if (!entry) return { found: false };
      return { found: true, ...entry };
    },
  },
  {
    name: "agentsmcp_search_index",
    description:
      "Search the codebase index by keywords, optionally filtered by " +
      "category. Use this INSTEAD of grepping the codebase — it returns " +
      "concise summaries of matching files, symbols, and APIs. Use limit " +
      "to control result size (default 20).",
    schema: SearchIndexInput,
    handler: async (agent, raw) => {
      const args = SearchIndexInput.parse(raw);
      return agent.searchIndex(args.query, args.category, { limit: args.limit });
    },
  },
  {
    name: "agentsmcp_check_staleness",
    description:
      "Batch-check which index summaries are still fresh. Call this at " +
      "SESSION START with a list of { key, currentHash } pairs — one per " +
      "file you plan to work with. Returns three buckets: " +
      "fresh (use cached summary, skip reading the file), " +
      "stale (re-read file and update the summary), " +
      "missing (file not indexed yet — read and index it). " +
      "This is the primary mechanism for avoiding redundant file reads.",
    schema: z.object({
      entries: z.array(
        z.object({
          key: z.string().describe("Index key, e.g. 'file:src/auth/middleware.ts'"),
          currentHash: z.string().describe("SHA-256 of the current file content"),
        })
      ).min(1).describe("Files to check staleness for"),
    }),
    handler: async (agent, raw) => {
      const { entries } = z.object({
        entries: z.array(z.object({ key: z.string(), currentHash: z.string() })).min(1),
      }).parse(raw);
      return agent.checkStaleness(entries);
    },
  },
  {
    name: "agentsmcp_rollup_module",
    description:
      "Combine file-level index summaries into a single module-level entry. " +
      "Call this after indexing a group of related files (e.g. all files in " +
      "src/auth/). The module entry is stored under moduleKey and each file " +
      "entry gets its parentKey set. Future sessions can read the module " +
      "summary (~200 tokens) instead of loading each file individually.",
    schema: z.object({
      moduleKey: z.string().describe("Key for the module entry, e.g. 'module:auth'"),
      fileKeys: z.array(z.string()).min(1).describe("Keys of the file entries to roll up"),
    }),
    handler: async (agent, raw) => {
      const { moduleKey, fileKeys } = z.object({
        moduleKey: z.string(),
        fileKeys: z.array(z.string()).min(1),
      }).parse(raw);
      await agent.rollupModule(moduleKey, fileKeys);
      return { ok: true, key: moduleKey, fileCount: fileKeys.length };
    },
  },

  // ---------- Git / Version Control ----------

  {
    name: "agentsmcp_git_commit",
    description:
      "Snapshot the agent's current context graph and codebase index as an " +
      "immutable commit. Call this at NATURAL CHECKPOINTS — after finishing a " +
      "task, before a risky exploration, or at the end of a session. Each " +
      "commit records a parent so you can trace history with agentsmcp_git_log. " +
      "Use branch to isolate experimental work from 'main'.",
    schema: z.object({
      message: z.string().min(1).describe(
        "Short description of what the agent accomplished, e.g. 'finished auth module analysis'"
      ),
      branch: z.string().optional().describe("Branch name (default 'main')"),
      keepLast: z.number().int().min(1).max(200).optional().describe(
        "After committing, prune old commits on this branch keeping only the N most recent. " +
        "Omit to keep all commits."
      ),
    }),
    handler: async (agent, raw) => {
      const args = z.object({
        message: z.string().min(1),
        branch: z.string().optional(),
        keepLast: z.number().int().min(1).max(200).optional(),
      }).parse(raw);
      return agent.gitCommit(args.message, { branch: args.branch, keepLast: args.keepLast });
    },
  },

  {
    name: "agentsmcp_git_log",
    description:
      "List the most recent commits for this agent, newest first. Returns id, " +
      "message, branch, nodeCount, indexCount, snapshotHash, createdAt for " +
      "each commit. Use to understand session history, find a checkpoint to " +
      "restore, or verify that a commit landed.",
    schema: z.object({
      branch: z.string().optional().describe("Filter to one branch (default: all branches)"),
      limit: z.number().int().min(1).max(100).optional()
        .describe("Max commits to return (default 20)"),
    }),
    handler: async (agent, raw) => {
      const args = z.object({
        branch: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }).parse(raw);
      const commits = await agent.gitLog({ branch: args.branch, limit: args.limit });
      return { commits, count: commits.length };
    },
  },

  {
    name: "agentsmcp_git_restore",
    description:
      "Restore the agent's context graph and codebase index to the exact " +
      "state captured in a previous commit. DESTRUCTIVE — all current nodes, " +
      "edges, and index entries are replaced. Use after an exploration goes " +
      "wrong, or to load a known-good checkpoint at the start of a new session. " +
      "Get the commitId from agentsmcp_git_log first.",
    schema: z.object({
      commitId: z.string().min(1).describe("Commit id to restore to"),
    }),
    handler: async (agent, raw) => {
      const { commitId } = z.object({ commitId: z.string().min(1) }).parse(raw);
      return agent.gitRestore(commitId);
    },
  },

  {
    name: "agentsmcp_git_diff",
    description:
      "Show what changed between two commits, or between a commit and the " +
      "current live state. Returns three buckets for graph nodes (added, " +
      "removed, modified ids) and three for index entries. Useful for " +
      "understanding what a session accomplished or verifying a restore.",
    schema: z.object({
      fromId: z.string().min(1).describe("Commit id to diff FROM (older)"),
      toId: z.string().optional().describe(
        "Commit id to diff TO (newer). Omit to compare against current live state."
      ),
    }),
    handler: async (agent, raw) => {
      const args = z.object({
        fromId: z.string().min(1),
        toId: z.string().optional(),
      }).parse(raw);
      return agent.gitDiff(args.fromId, args.toId);
    },
  },

  // ---------- Annotations (context-as-comments) ----------

  {
    name: "agentsmcp_annotate_file",
    description:
      "Analyze a file and add structured @context JSDoc annotations to all " +
      "exported functions, classes, and constants. Call this AFTER editing a " +
      "file so future agents get instant context without reading other files. " +
      "The annotations embed what-it-does, why, dependencies, and known " +
      "gotchas directly in the source — pulled from this agent's graph + index.",
    schema: z.object({
      filePath: z.string().min(1).describe(
        "Repo-relative path, e.g. 'src/auth/middleware.ts'. Used as the index key."
      ),
      source: z.string().describe("Current file contents."),
    }),
    handler: async (agent, raw) => {
      const args = z.object({
        filePath: z.string().min(1),
        source: z.string(),
      }).parse(raw);
      const annotated = await agent.annotateFile(args.filePath, args.source);
      return {
        filePath: args.filePath,
        annotated,
        length: annotated.length,
        skipped: annotated === args.source,
      };
    },
  },

  {
    name: "agentsmcp_post_edit_annotate",
    description:
      "Update annotations after an edit. Refreshes @changed, @depends, @usedBy " +
      "tags. Call this after every file modification so the next agent session " +
      "doesn't burn tokens re-understanding your changes.",
    schema: z.object({
      filePath: z.string().min(1),
      source: z.string(),
      editSummary: z.string().min(1).describe(
        "One-line description of what changed and why, e.g. " +
        "'added retry logic to handle 429 responses'."
      ),
    }),
    handler: async (agent, raw) => {
      const args = z.object({
        filePath: z.string().min(1),
        source: z.string(),
        editSummary: z.string().min(1),
      }).parse(raw);
      const annotated = await agent.postEditAnnotate(
        args.filePath,
        args.source,
        args.editSummary
      );
      return {
        filePath: args.filePath,
        annotated,
        length: annotated.length,
        skipped: annotated === args.source,
      };
    },
  },

  // ---------- Context Briefing ----------

  {
    name: "agentsmcp_session_start",
    description:
      "Get a complete session briefing before starting work. Combines " +
      "architecture overview + relevant file summaries + graph decisions " +
      "into a single payload. Call this FIRST at the start of every session. " +
      "It tells you: what files are relevant, which summaries are stale " +
      "(need re-reading), what architectural decisions apply, and similar " +
      "past tasks. Costs ~5K-15K tokens instead of 200K+ from reading raw files. " +
      "For quick mid-task lookups use agentsmcp_context_briefing instead.",
    schema: z.object({
      task: z.string().min(1).describe(
        "What you are about to do, e.g. 'Add OAuth2 to the auth module'. " +
        "Used to search for relevant files, decisions, and past tasks."
      ),
      files_hint: z.array(z.string()).max(50).optional().describe(
        "Files you already know you will touch (from the user's open tabs, " +
        "PR diff, etc.). Accepts bare paths ('src/auth/middleware.ts') or " +
        "full keys ('file:src/auth/middleware.ts'). Duplicates are ignored."
      ),
      file_limit: z.number().int().min(1).max(50).optional().describe(
        "Max file summaries to return from keyword search (default 15). " +
        "Increase for broad explorations, decrease to save tokens."
      ),
      graph_limit: z.number().int().min(1).max(100).optional().describe(
        "Max graph nodes to fetch (default 20). Increase if architectural " +
        "context is sparse."
      ),
    }),
    handler: async (agent, raw) => {
      const args = z.object({
        task: z.string().min(1),
        files_hint: z.array(z.string()).max(50).optional(),
        file_limit: z.number().int().min(1).max(50).optional(),
        graph_limit: z.number().int().min(1).max(100).optional(),
      }).parse(raw);

      const fileLimit = args.file_limit ?? 15;
      const graphLimit = args.graph_limit ?? 20;

      // Build search query from task keywords.
      // Filter words with length > 3 to skip stop-words; fall back to first
      // 3 words of the raw task if everything is short (e.g. "Add DB").
      const significantWords = args.task
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 6);
      const searchQuery = significantWords.length > 0
        ? significantWords.join(" ")
        : args.task.toLowerCase().split(/\s+/).slice(0, 3).join(" ");

      // Deduplicate files_hint and normalise to "file:" keys
      const rawHints = args.files_hint ?? [];
      const normHints = [...new Set(
        rawHints
          .map((h) => h.trim())
          .filter(Boolean)
          .map((h) => h.startsWith("file:") ? h : `file:${h}`)
      )];

      // 1. Fetch in parallel: overview, search results, hint lookups, graph
      const architectureEntryPromise = agent
        .getIndex("overview:architecture")
        .catch(() => null);

      const [architectureEntry, searchResults, hintResults, graphResult] = await Promise.all([
        architectureEntryPromise,
        agent.searchIndex(searchQuery, undefined, { limit: fileLimit })
          .catch(() => [] as Awaited<ReturnType<typeof agent.searchIndex>>),
        Promise.all(normHints.map((k) => agent.getIndex(k).catch(() => null))),
        agent.queryGraph(searchQuery, { limit: graphLimit })
          .catch(() => ({
            nodes: [] as Awaited<ReturnType<typeof agent.queryGraph>>["nodes"],
            edges: [] as Awaited<ReturnType<typeof agent.queryGraph>>["edges"],
          })),
      ]);

      // 2. Merge hint lookups + search results, deduplicating by key.
      //    Hints come first (they're more specific than keyword search).
      const seen = new Set<string>();
      const relevantFiles: Array<{
        key: string;
        summary: string;
        stale?: boolean;
        parentModule?: string;
        contentHash?: string;
      }> = [];

      const validHints = hintResults.filter(
        (e): e is NonNullable<typeof e> => e !== null
      );

      for (const entry of [...validHints, ...searchResults]) {
        if (seen.has(entry.key)) continue;
        seen.add(entry.key);
        relevantFiles.push({
          key: entry.key,
          summary: entry.summary,
          stale: entry.stale,
          parentModule: entry.parentKey,
          contentHash: entry.contentHash,
        });
      }

      // 3. Decisions + relationships from graph
      const relevantDecisions = graphResult.nodes
        .filter((n: { type: string }) => n.type === "decision" || n.type === "task")
        .map((n: { id: string; name: string; description?: string }) => ({
          id: n.id,
          name: n.name,
          description: n.description,
        }));

      // Cap edges to avoid token bloat
      const relationships = graphResult.edges.slice(0, 30);

      // 4. Files the agent MUST actually read:
      //    - stale entries (hash has changed since last indexing)
      //    - hints that were not found in the index at all (not indexed yet)
      const suggestedReads: string[] = [
        ...relevantFiles.filter((f) => f.stale === true).map((f) => f.key),
      ];
      for (const key of normHints) {
        if (!seen.has(key) && !suggestedReads.includes(key)) {
          suggestedReads.push(key);
        }
      }

      // 5. Token savings estimate.
      //    Conservative avg: 3000 tokens/raw file (typical TS/Py file ~12KB).
      //    Each cached summary is ~40 tokens.
      //    Fresh files = ones we DON'T have to read raw.
      const AVG_RAW_TOKENS_PER_FILE = 3000;
      const AVG_SUMMARY_TOKENS_PER_FILE = 40;
      const freshCount = relevantFiles.length - suggestedReads.length;
      const tokensSaved = Math.max(0,
        freshCount * (AVG_RAW_TOKENS_PER_FILE - AVG_SUMMARY_TOKENS_PER_FILE)
      );

      return {
        architecture: architectureEntry?.summary ??
          "No architecture overview yet. Run: agentsmcp-index --mode full --dir ./src",
        relevantFiles,
        relevantDecisions,
        relationships,
        suggestedReads,
        tokensSaved,
        tip: suggestedReads.length === 0
          ? `All ${relevantFiles.length} relevant summaries are fresh — skip reading raw files.`
          : `${suggestedReads.length} file(s) stale or missing. Read before editing: ${suggestedReads.slice(0, 5).join(", ")}${suggestedReads.length > 5 ? ` (+${suggestedReads.length - 5} more)` : ""}.`,
      };
    },
  },

  {
    name: "agentsmcp_context_briefing",
    description:
      "Get a targeted context briefing for a task. Combines graph query + " +
      "index search into a single payload with relevant files, decisions, " +
      "tasks, and symbols. Call this at the START of any task instead of " +
      "manually reading files. Set include_threads=true to also include " +
      "recent thread context (increases payload size).",
    schema: ContextBriefingInput,
    handler: async (agent, raw) => {
      const args = ContextBriefingInput.parse(raw);
      const task = args.task;

      // Extract keywords — filter stop-words, fallback to raw first 3 words
      const significantWords = task
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 6);
      const searchQuery = significantWords.length > 0
        ? significantWords.join(" ")
        : task.toLowerCase().split(/\s+/).slice(0, 3).join(" ");

      // Query graph and index in parallel with explicit limits
      const [graphResult, indexEntries] = await Promise.all([
        agent.queryGraph(searchQuery, { limit: 30 }).catch(() => ({ nodes: [], edges: [] })),
        agent.searchIndex(searchQuery, undefined, { limit: 20 }).catch(() => []),
      ]);

      const briefing: Record<string, unknown> = {
        task,
        relevantNodes: graphResult.nodes,
        relationships: graphResult.edges,
        indexEntries,
      };

      // Optionally include thread context
      if (args.include_threads) {
        const { messages, context } = await agent.receive();
        briefing.threadContext = {
          unreadCount: messages.length,
          snapshot: context.snapshot,
          summary: context.threadSummary,
        };
      }

      return briefing;
    },
  },
];

export interface ToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listToolDefs(): ToolListing[] {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.schema),
  }));
}

export async function runTool(
  agent: AgentMailbox,
  name: string,
  args: unknown
): Promise<unknown> {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) {
    throw new Error(`unknown tool: ${name}`);
  }
  return def.handler(agent, args ?? {});
}

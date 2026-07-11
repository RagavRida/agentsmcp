import { z, ZodTypeAny } from "zod";
// The recursive JsonValue schema explodes zod-to-json-schema's generic
// inference (TS2589). Erase the type at the import boundary; the returned
// shape is a JSON Schema object which we expose as Record<string, unknown>.
import { zodToJsonSchema as _raw } from "zod-to-json-schema";
const _zodToJsonSchema = _raw as (s: unknown, opts?: unknown) => unknown;
import type { AgentMailbox } from "../agentmailbox";
import {
  declareInterestAndPersist,
  scopeReceiveResult,
  scopeSnapshotForReceiver,
  wrapContextForSend,
} from "../context-router-service";
import {
  getAgentStorage,
  getBackgroundTask,
  getChunkNeighbors,
  getMemory,
  getVectorStore,
  listBackgroundTasks,
  listProgramStats,
  resolveAgentId,
} from "../memory/service";
import {
  loadBriefingLoopMemory,
  loadBriefingPromptVersion,
} from "../briefing/helpers";
import { extractLearnedRules } from "../agent/rule-extractor";

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
  handoff: z.object({
    goal: z.string().min(1).optional(),
    nextAction: z.string().min(1).optional(),
    includeFields: z.array(z.string().min(1)).max(100).optional(),
    maxContextBytes: z.number().int().min(256).max(1_000_000).optional(),
  }).optional().describe("Build a compact task-specific context packet for the recipient"),
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
  handoff: z.object({
    goal: z.string().min(1).optional(),
    nextAction: z.string().min(1).optional(),
    includeFields: z.array(z.string().min(1)).max(100).optional(),
    maxContextBytes: z.number().int().min(256).max(1_000_000).optional(),
  }).optional(),
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

const LegacySourceInput = z.object({
  source: z.string().min(1).describe("Raw COBOL source code to parse"),
  filename: z.string().optional().describe("Optional filename for graph labeling"),
  copybooks: z.record(z.string()).optional()
    .describe("Map of copybook name → copybook source content for COPY resolution"),
});

const JclSourceInput = z.object({
  source: z.string().min(1).describe("Raw JCL source code to parse"),
  filename: z.string().optional().describe("Optional filename for graph labeling"),
});

const MainframeLanguageInput = z.enum(["auto", "cobol", "jcl", "pli", "rexx", "unknown"]);

const MainframeSourceInput = z.object({
  source: z.string().min(1).describe("Raw mainframe source code to parse"),
  filename: z.string().optional().describe("Optional filename for graph labeling and language detection"),
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

      let contextSnapshot = args.contextSnapshot;
      if (
        contextSnapshot &&
        typeof contextSnapshot === "object" &&
        !Array.isArray(contextSnapshot)
      ) {
        contextSnapshot = wrapContextForSend(
          agent.getAgentId(),
          contextSnapshot as Record<string, unknown>,
        );
      }

      return agent.send(args.to, args.payload, {
        threadId: args.threadId,
        contextSnapshot,
        cc: args.cc,
        bcc: args.bcc,
        replyTo: args.replyTo,
        handoff: args.handoff,
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
      const result = await agent.receive(args.from, { recent: args.recent ?? 3 });
      return scopeReceiveResult(agent.getAgentId(), result);
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
      const receiverId = agent.getAgentId();
      const { context } = await agent.sync(threadId);
      return {
        ...context,
        snapshot: scopeSnapshotForReceiver(receiverId, context.snapshot ?? {}),
        recentMessages: context.recentMessages.map((m) => ({
          ...m,
          contextSnapshot: scopeSnapshotForReceiver(receiverId, m.contextSnapshot ?? {}),
        })),
      };
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

      let contextSnapshot = args.contextSnapshot;
      if (
        contextSnapshot &&
        typeof contextSnapshot === "object" &&
        !Array.isArray(contextSnapshot)
      ) {
        contextSnapshot = wrapContextForSend(
          agent.getAgentId(),
          contextSnapshot as Record<string, unknown>,
        );
      }

      return agent.replyAll(args.threadId, args.payload, { contextSnapshot, handoff: args.handoff });
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
      const graph = await agent.queryGraph(query, { limit });
      const rules = await getAgentStorage().getLearnedRules(agent.getAgentId());

      return {
        ...graph,
        learnedRules: rules,
      };
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

      // Query graph, index, learned rules, and memory in parallel
      const agentId = agent.getAgentId();

      const [graphResult, indexEntries, learnedRules, memoryRecall, loopMemory, promptVersion] =
        await Promise.all([
        agent.queryGraph(searchQuery, { limit: 30 }).catch(() => ({ nodes: [], edges: [] })),
        agent.searchIndex(searchQuery, undefined, { limit: 20 }).catch(() => []),
        getAgentStorage().getLearnedRules(agentId).catch(() => []),
        (async () => {
          try {
            const memory = getMemory();
            return await memory.recall(task, { topK: 5 });
          } catch {
            return null;
          }
        })(),
        loadBriefingLoopMemory().catch(() => ({ path: "", recentLessons: [] })),
        loadBriefingPromptVersion().catch(() => null),
      ]);

      const briefing: Record<string, unknown> = {
        task,
        relevantNodes: graphResult.nodes,
        relationships: graphResult.edges,
        indexEntries,
        learnedRules: learnedRules.slice(0, 10),
        loopMemoryLessons: loopMemory.recentLessons.slice(0, 5),
      };

      if (promptVersion) {
        briefing.promptVersion = promptVersion;
      }

      if (memoryRecall && memoryRecall.results?.length > 0) {
        briefing.memoryRecall = {
          strategy: memoryRecall.strategy,
          routeConfidence: memoryRecall.routeConfidence,
          results: memoryRecall.results,
        };
      }

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

  // ── Mainframe Parser Tools ──────────────────────────────────
  // Zero LLM. Deterministic AST → Semantic Tree pipeline.

  {
    name: "agentsmcp_parse_cobol",
    description:
      "Parse a COBOL source file deterministically into an Abstract Semantic Tree. " +
      "Returns business rules, data access patterns, control flow, and a " +
      "knowledge graph — all without any LLM calls. The raw COBOL source " +
      "never leaves this server. Pass copybooks as a name→content map " +
      "for COPY statement resolution.",
    schema: LegacySourceInput,
    handler: async (_agent, raw) => {
      const args = LegacySourceInput.parse(raw);

      const { parseCobol } = require("../parser");
      return parseCobol(args.source, {
        filename: args.filename,
        copybooks: args.copybooks,
      });
    },
  },
  {
    name: "agentsmcp_parse_jcl",
    description:
      "Parse a JCL job stream deterministically into an Abstract Semantic Tree. " +
      "Returns job steps, dataset dependencies, execution graph, and a " +
      "knowledge graph — all without any LLM calls. The raw JCL source " +
      "never leaves this server.",
    schema: JclSourceInput,
    handler: async (_agent, raw) => {
      const args = JclSourceInput.parse(raw);

      const { parseJcl } = require("../parser");
      return parseJcl(args.source, {
        filename: args.filename,
      });
    },
  },
  {
    name: "agentsmcp_parse_pli",
    description:
      "Parse a PL/I source file deterministically into a semantic tree and " +
      "knowledge graph. Extracts PROC, DCL, CALL, IF/SELECT, and embedded " +
      "EXEC SQL blocks without sending source code to any LLM.",
    schema: MainframeSourceInput,
    handler: async (_agent, raw) => {
      const args = MainframeSourceInput.parse(raw);

      const { parsePli } = require("../parser");
      return parsePli(args.source, {
        filename: args.filename,
      });
    },
  },
  {
    name: "agentsmcp_parse_rexx",
    description:
      "Parse a REXX script deterministically into a semantic tree and " +
      "knowledge graph. Extracts SAY, CALL, DO/END, IF/THEN, and PARSE " +
      "constructs without any LLM calls.",
    schema: MainframeSourceInput,
    handler: async (_agent, raw) => {
      const args = MainframeSourceInput.parse(raw);

      const { parseRexx } = require("../parser");
      return parseRexx(args.source, {
        filename: args.filename,
      });
    },
  },
  {
    name: "agentsmcp_analyze_legacy_impact",
    description:
      "Analyze a COBOL program and store its business rules and dependencies " +
      "into the AgentMailbox knowledge graph. This enables other agents to " +
      "search for legacy code insights via agentsmcp_query_graph. Each " +
      "business rule, data access pattern, and external call becomes a " +
      "searchable graph node with domain classification.",
    schema: LegacySourceInput,
    handler: async (agent, raw) => {
      const args = LegacySourceInput.parse(raw);

      const { parseCobol } = require("../parser");
      const result = parseCobol(args.source, {
        filename: args.filename,
        copybooks: args.copybooks,
      });

      // Store each business rule as a graph node
      let nodesCreated = 0;
      for (const rule of result.businessRules) {
        await agent.upsertNode({
          id: `legacy:rule:${result.programName}:${rule.id}`,
          type: "decision",
          name: rule.description,
          description: `[${rule.domain}] ${rule.description}`,
          metadata: {
            program: result.programName,
            domain: rule.domain,
            inputs: rule.inputs,
            outputs: rule.outputs,
            sideEffects: rule.sideEffects,
          },
        });
        nodesCreated++;
      }

      // Store data access patterns
      for (const da of result.dataAccess) {
        await agent.upsertNode({
          id: `legacy:data:${result.programName}:${da.id}`,
          type: "symbol",
          name: da.description,
          description: `[${da.domain}] ${da.description}`,
          metadata: {
            program: result.programName,
            domain: da.domain,
          },
        });
        nodesCreated++;
      }

      // Store graph edges (program → paragraph dependencies)
      let edgesCreated = 0;
      for (const edge of result.graph.edges) {
        await agent.addEdge({
          sourceId: `legacy:${edge.source}`,
          targetId: `legacy:${edge.target}`,
          type: edge.type.toLowerCase(),
        });
        edgesCreated++;
      }

      // ── Vector + RAPTOR via unified Memory pipeline ──
      let vectorsStored = 0;
      let raptorTreeDepth = 0;
      let graphNodesSynced = 0;
      try {
        const memoryResult = await getMemory().remember(args.source);
        if (memoryResult.status === "completed") {
          vectorsStored = memoryResult.vectorsStored;
          raptorTreeDepth = memoryResult.raptorTreeDepth ?? 0;
          graphNodesSynced = memoryResult.graphNodesSynced ?? 0;
        }
      } catch {
        // Memory pipeline optional if source is malformed
      }

      return {
        programName: result.programName,
        nodesCreated,
        edgesCreated,
        vectorsStored,
        raptorTreeDepth,
        graphNodesSynced,
        stats: result.stats,
        message: vectorsStored > 0
          ? `Indexed ${nodesCreated} graph nodes, ${edgesCreated} edges, and ${vectorsStored} memory vectors for ${result.programName}. Search with agentsmcp_recall or agentsmcp_semantic_search.`
          : `Indexed ${nodesCreated} graph nodes and ${edgesCreated} edges for ${result.programName}. Memory pipeline did not store vectors.`,
      };
    },
  },
  {
    name: "agentsmcp_semantic_search",
    description:
      "Search for legacy code business rules using natural language. " +
      "This uses GPU-accelerated vector embeddings to find the most " +
      "semantically similar business rules, data access patterns, and " +
      "control flow nodes. Requires prior indexing via " +
      "agentsmcp_analyze_legacy_impact. Set AGENTSMCP_MODAL_EMBED_URL " +
      "environment variable to the Modal embedding endpoint URL.",
    schema: z.object({
      query: z.string().min(1).describe("Natural language search query, e.g. 'How does interest calculation work?'"),
      limit: z.number().optional().describe("Max results to return (default 10)"),
      domain: z.string().optional().describe("Filter by business domain, e.g. 'Payments', 'Taxation'"),
      program: z.string().optional().describe("Filter by program name"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        query: z.string().min(1),
        limit: z.number().optional(),
        domain: z.string().optional(),
        program: z.string().optional(),
      }).parse(raw);

      const store = getVectorStore();

      const results = await store.semanticSearch(args.query, {
        limit: args.limit,
        domain: args.domain,
        program: args.program,
      });

      return {
        query: args.query,
        resultCount: results.length,
        results: results.map((r: { id: string; program: string; nodeType: string; domain: string; description: string; score: number; metadata?: Record<string, unknown> }) => ({
          id: r.id,
          program: r.program,
          type: r.nodeType,
          domain: r.domain,
          description: r.description,
          similarity: Math.round(r.score * 1000) / 1000,
          metadata: r.metadata,
        })),
      };
    },
  },
  {
    name: "agentsmcp_query_deepseek",
    description:
      "Ask a question about legacy code using DeepSeek-V2 (MLA-native model) " +
      "deployed on Modal. The model uses Multi-Latent Attention for 93% KV cache " +
      "compression and RadixAttention for prefix caching. Optionally pre-warm " +
      "the KV cache for a program's semantic context. " +
      "Set AGENTSMCP_VLLM_URL environment variable.",
    schema: z.object({
      prompt: z.string().min(1).describe("Question about the legacy code"),
      systemContext: z.string().optional().describe("Semantic context (e.g. parsed business rules)"),
      programName: z.string().optional().describe("If set, uses pre-warmed KV cache for this program"),
      prewarm: z.boolean().optional().describe("If true, pre-warms the KV cache for the program"),
      maxTokens: z.number().optional().describe("Max tokens to generate (default 1024)"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        prompt: z.string().min(1),
        systemContext: z.string().optional(),
        programName: z.string().optional(),
        prewarm: z.boolean().optional(),
        maxTokens: z.number().optional(),
      }).parse(raw);

      const vllmUrl = process.env.AGENTSMCP_VLLM_URL;
      if (!vllmUrl) {
        return { error: "AGENTSMCP_VLLM_URL not set. Deploy infra/modal/modal_vllm.py first." };
      }

      const { KVCacheManager } = require("../kv-cache/manager");
      const manager = new KVCacheManager({ vllmUrl });

      // Pre-warm if requested
      if (args.prewarm && args.programName && args.systemContext) {
        const prewarmResult = await manager.prewarm(args.programName, args.systemContext);
        if (!args.prompt || args.prompt === "prewarm") {
          return prewarmResult;
        }
      }

      // Query
      const result = await manager.query(
        args.programName || "unknown",
        args.prompt,
        { maxTokens: args.maxTokens ?? 1024 },
      );

      return {
        answer: result.answer,
        tokensGenerated: result.tokensGenerated,
        promptTokens: result.promptTokens,
        latencyMs: result.latencyMs,
        cacheHit: result.cacheHit,
        mla: true,
      };
    },
  },
  {
    name: "agentsmcp_impact_analysis",
    description:
      "Run impact analysis on the Neo4j knowledge graph. Given a program, " +
      "variable, or dataset name, finds all directly and indirectly affected " +
      "nodes. Returns dependency chains like JCL → COBOL → DB2. " +
      "Requires Neo4j running (set AGENTSMCP_NEO4J_URI, AGENTSMCP_NEO4J_USER, " +
      "AGENTSMCP_NEO4J_PASS).",
    schema: z.object({
      target: z.string().min(1).describe("Name of program, variable, or dataset to analyze"),
      maxDepth: z.number().optional().describe("Max traversal depth (default 5)"),
      includeChains: z.boolean().optional().describe("Include full dependency chains (default true)"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        target: z.string().min(1),
        maxDepth: z.number().optional(),
        includeChains: z.boolean().optional(),
      }).parse(raw);

      const { Neo4jSync } = require("../graph/neo4j-sync");
      const neo4j = new Neo4jSync({
        uri: process.env.AGENTSMCP_NEO4J_URI || "bolt://localhost:7687",
        user: process.env.AGENTSMCP_NEO4J_USER || "neo4j",
        password: process.env.AGENTSMCP_NEO4J_PASS || "agentsmcp2026",
      });

      try {
        const impact = await neo4j.impactAnalysis(args.target, args.maxDepth ?? 5);

        let chains: unknown[] = [];
        if (args.includeChains !== false) {
          const rawChains = await neo4j.dependencyChain(args.target, args.maxDepth ?? 10);
          chains = rawChains.map((c: { path: Array<{ name: string; type: string }>; relationships: string[] }) => ({
            path: c.path.map((n: { name: string; type: string }) => `${n.name}(${n.type})`).join(" → "),
            relationships: c.relationships,
          }));
        }

        return {
          target: args.target,
          directImpact: impact.directImpact,
          indirectImpact: impact.indirectImpact,
          affectedDatasets: impact.affectedDatasets,
          affectedJobs: impact.affectedJobs,
          totalAffected: impact.totalAffected,
          dependencyChains: chains,
        };
      } finally {
        await neo4j.close();
      }
    },
  },
  {
    name: "agentsmcp_generate_training_data",
    description:
      "Generate synthetic Q&A training pairs from the Neo4j knowledge graph. " +
      "These pairs can be used for Supervised Fine-Tuning (SFT) to teach a " +
      "model how to reason across JCL and COBOL boundaries. " +
      "Requires Neo4j running with populated graph data.",
    schema: z.object({
      limit: z.number().optional().describe("Max training pairs to generate (default 100)"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        limit: z.number().optional(),
      }).parse(raw);

      const { Neo4jSync } = require("../graph/neo4j-sync");
      const neo4j = new Neo4jSync({
        uri: process.env.AGENTSMCP_NEO4J_URI || "bolt://localhost:7687",
        user: process.env.AGENTSMCP_NEO4J_USER || "neo4j",
        password: process.env.AGENTSMCP_NEO4J_PASS || "agentsmcp2026",
      });

      try {
        const pairs = await neo4j.generateTrainingPairs(args.limit ?? 100);
        return {
          pairsGenerated: pairs.length,
          pairs: pairs.slice(0, 20), // Return max 20 in response to avoid huge payloads
          message: `Generated ${pairs.length} Q&A pairs from the knowledge graph. Use these for SFT.`,
        };
      } finally {
        await neo4j.close();
      }
    },
  },

  // ── Memory API Tools (Cognee-inspired) ──────────────────────
  // Expose remember/recall/forget as MCP tools so agents can call them.

  {
    name: "agentsmcp_remember",
    description:
      "Store mainframe source code in the agent's permanent memory. Supports " +
      "COBOL, JCL, PL/I, REXX deterministically (zero LLM). For any other " +
      "mainframe language (Easytrieve, Natural, RPG, HLASM, SAS, etc.) the " +
      "source is sent to the on-prem LLM for semantic extraction. Runs the " +
      "full 7-pillar pipeline: parse → embed → vector store → RAPTOR tree → " +
      "Neo4j graph → BYOS upload → trajectory log.",
    schema: z.object({
      source: z.string().min(1).describe("Raw mainframe source code (any language — auto-detected)"),
      filename: z.string().optional().describe("Optional filename for parser language detection"),
      language: MainframeLanguageInput.optional()
        .describe("Parser language hint (default: auto-detect)"),
      dataset: z.string().optional().describe("Dataset namespace (default 'main')"),
      sessionId: z.string().optional().describe("Session ID for ephemeral context tracking"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        source: z.string().min(1),
        filename: z.string().optional(),
        language: MainframeLanguageInput.optional(),
        dataset: z.string().optional(),
        sessionId: z.string().optional(),
      }).parse(raw);

      const memory = getMemory();
      const result = await memory.remember(args.source, {
        dataset: args.dataset,
        sessionId: args.sessionId,
        filename: args.filename,
        language: args.language,
      });

      return {
        ...result,
        dataset: args.dataset ?? "main",
        message: result.status === "completed"
          ? `Stored ${result.program}: ${result.rulesExtracted} rules, ` +
            `${result.vectorsStored} vectors, RAPTOR depth ${result.raptorTreeDepth}.`
          : `Remember failed for ${result.program}: ${result.error ?? "unknown error"}`,
      };
    },
  },
  {
    name: "agentsmcp_recall",
    description:
      "Search the agent's memory using auto-routing. The query router " +
      "automatically picks the best strategy: VECTOR (semantic similarity), " +
      "RAPTOR (high-level summaries), GRAPH (relationship traversal), " +
      "FLARE (grounded reasoning), TRAJECTORY (audit log), or HYBRID. " +
      "Override with the strategy param if needed.",
    schema: z.object({
      query: z.string().min(1).describe("Natural language query"),
      strategy: z.enum(["VECTOR", "RAPTOR", "GRAPH", "FLARE", "TRAJECTORY", "HYBRID"])
        .optional().describe("Override auto-routing with a specific strategy"),
      topK: z.number().int().min(1).max(50).optional()
        .describe("Max results to return (default 5)"),
      program: z.string().optional().describe("Filter to a specific COBOL program"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        query: z.string().min(1),
        strategy: z.enum(["VECTOR", "RAPTOR", "GRAPH", "FLARE", "TRAJECTORY", "HYBRID"]).optional(),
        topK: z.number().int().min(1).max(50).optional(),
        program: z.string().optional(),
      }).parse(raw);

      const memory = getMemory();
      const result = await memory.recall(args.query, {
        strategy: args.strategy,
        topK: args.topK,
        program: args.program,
      });

      return {
        ...result,
        resultCount: result.results.length,
        message: result.results.length > 0
          ? `Found ${result.results.length} results via ${result.strategy} ` +
            `(confidence: ${result.routeConfidence}).`
          : `No results for "${args.query}" via ${result.strategy}. ` +
            `Try a broader query or run agentsmcp_remember first.`,
      };
    },
  },
  {
    name: "agentsmcp_forget",
    description:
      "Delete a COBOL program from ALL memory stores: vector store, RAPTOR tree, " +
      "Neo4j graph, and BYOS. This is a cascade delete — one call removes " +
      "everything. The trajectory log is preserved for audit compliance.",
    schema: z.object({
      program: z.string().min(1).describe("Program name to delete, e.g. 'LOAN-PROC'"),
      dataset: z.string().optional().describe("Dataset namespace (default 'main')"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        program: z.string().min(1),
        dataset: z.string().optional(),
      }).parse(raw);

      const memory = getMemory();
      const result = await memory.forget(args.program, { dataset: args.dataset });

      return {
        ...result,
        status: "completed",
        dataset: args.dataset ?? "main",
        message: `Deleted ${result.vectorsDeleted} vectors and ${result.graphNodesDeleted} ` +
          `graph nodes for '${args.program}'.`,
      };
    },
  },
  {
    name: "agentsmcp_improve",
    description:
      "Re-index a COBOL program: re-embed vectors, rebuild RAPTOR tree, and " +
      "re-sync the graph. Like Cognee's improve() — use after parser prompt " +
      "updates or when recall quality drops for a program.",
    schema: z.object({
      program: z.string().min(1).describe("Program name to re-index"),
      source: z.string().min(1).describe("Full COBOL source to re-process"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        program: z.string().min(1),
        source: z.string().min(1),
      }).parse(raw);

      const result = await getMemory().improve(args.program, args.source);

      return {
        ...result,
        message: result.status === "completed"
          ? `Re-indexed ${args.program}: ${result.vectorsStored} vectors, ` +
            `RAPTOR depth ${result.raptorTreeDepth}.`
          : `Improve failed for ${args.program}: ${result.error ?? "unknown error"}`,
      };
    },
  },

  {
    name: "agentsmcp_task_status",
    description:
      "Check the status of a background task launched by agentsmcp_remember " +
      "or agentsmcp_analyze_legacy_impact. Returns running/completed/failed " +
      "with result or error when finished.",
    schema: z.object({
      taskId: z.string().min(1).describe("Task ID returned when the background task was launched"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({ taskId: z.string().min(1) }).parse(raw);
      const task = getBackgroundTask(args.taskId);
      if (!task) {
        return {
          found: false,
          taskId: args.taskId,
          message: "Task not found. It may have expired or the ID is invalid.",
          recentTasks: listBackgroundTasks(5).map((t: { id: string; tool: string; status: string }) => ({
            id: t.id,
            tool: t.tool,
            status: t.status,
          })),
        };
      }
      return { found: true, ...task };
    },
  },

  {
    name: "agentsmcp_learn_rules",
    description:
      "Extract persistent coding rules from a chat transcript or correction " +
      "and store them for future sessions. Like Cognee's memify coding-agent " +
      "rule extraction. Rules are scoped to the calling agent.",
    schema: z.object({
      transcript: z.string().min(1).describe("Chat transcript or correction text to learn from"),
      astNodeId: z.string().optional().describe("Optional COBOL AST node to link rules to"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        transcript: z.string().min(1),
        astNodeId: z.string().optional(),
        agentId: z.string().optional(),
      }).parse(raw);

      const agentId = resolveAgentId(args.agentId);
      const storage = getAgentStorage();
      const rules = await extractLearnedRules(args.transcript, args.astNodeId);

      for (const rule of rules) {
        await storage.upsertLearnedRule(agentId, rule);
      }

      return {
        agentId,
        rulesExtracted: rules.length,
        rules: rules.map((r: { id: string; description: string; category: string }) => ({
          id: r.id,
          description: r.description,
          category: r.category,
        })),
        message: rules.length > 0
          ? `Learned ${rules.length} rule(s) for agent ${agentId}.`
          : "No reusable rules found in the transcript.",
      };
    },
  },

  {
    name: "agentsmcp_get_learned_rules",
    description:
      "Retrieve coding rules previously learned by this agent, optionally " +
      "filtered to a specific COBOL AST node.",
    schema: z.object({
      astNodeId: z.string().optional().describe("Filter rules linked to this AST node"),
      agentId: z.string().optional().describe("Agent ID (defaults to AGENTSMCP_AGENT_ID)"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        astNodeId: z.string().optional(),
        agentId: z.string().optional(),
      }).parse(raw);
      const agentId = resolveAgentId(args.agentId);
      const rules = await getAgentStorage().getLearnedRules(agentId, args.astNodeId);
      return {
        agentId,
        count: rules.length,
        rules,
        message: rules.length > 0
          ? `Found ${rules.length} learned rule(s).`
          : "No learned rules yet. Use agentsmcp_learn_rules after corrections.",
      };
    },
  },

  {
    name: "agentsmcp_declare_interest",
    description:
      "Declare which context fields this agent cares about when receiving " +
      "messages. The ContextRouter uses this to scope contextSnapshot payloads " +
      "on receive — each agent sees only what they need. Also set tokenBudget " +
      "to limit context size.",
    schema: z.object({
      fields: z.array(z.string()).min(1)
        .describe("Top-level field names to always include, e.g. ['businessRules', 'graph']"),
      tokenBudget: z.number().int().min(100).optional()
        .describe("Max token budget for scoped context (default unlimited)"),
      agentId: z.string().optional().describe("Agent ID (defaults to AGENTSMCP_AGENT_ID)"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        fields: z.array(z.string()).min(1),
        tokenBudget: z.number().int().min(100).optional(),
        agentId: z.string().optional(),
      }).parse(raw);

      const agentId = resolveAgentId(args.agentId);

      await declareInterestAndPersist(agentId, args.fields, args.tokenBudget);

      return {
        agentId,
        fields: args.fields,
        tokenBudget: args.tokenBudget ?? "unlimited",
        message: `Interest profile updated for ${agentId}.`,
      };
    },
  },

  {
    name: "agentsmcp_run_optimize_loop",
    description:
      "Run the generate-evaluate-repair loop: benchmark parser F1 → classify " +
      "failures → surgically patch LLM fallback prompt → re-evaluate until " +
      "target F1 or max iterations. Uses PromptOptimizerSkill and LoopVerifier.",
    schema: z.object({
      targetF1: z.number().min(0).max(1).optional()
        .describe("Target parser F1 score (default 0.85)"),
      maxIterations: z.number().int().min(1).max(10).optional()
        .describe("Max loop iterations (default 3)"),
      dataset: z.enum(["sample", "cobol-banking", "unseen-holdout"]).optional()
        .describe("Eval dataset (default sample)"),
      confidenceThreshold: z.number().min(0).max(1).optional()
        .describe("Starting LLM fallback confidence threshold (default 0.7)"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        targetF1: z.number().min(0).max(1).optional(),
        maxIterations: z.number().int().min(1).max(10).optional(),
        dataset: z.enum(["sample", "cobol-banking", "unseen-holdout"]).optional(),
        confidenceThreshold: z.number().min(0).max(1).optional(),
      }).parse(raw);

      const { runOptimizeLoop } = require("../loops/optimize-loop");
      return runOptimizeLoop({
        targetF1: args.targetF1,
        maxIterations: args.maxIterations,
        dataset: args.dataset,
        confidenceThreshold: args.confidenceThreshold,
      });
    },
  },

  // ── Chunk Neighbors (Cognee-inspired) ──────────────────────
  // Expand search context around a matching vector.

  {
    name: "agentsmcp_get_chunk_neighbors",
    description:
      "After a vector search finds a relevant match, use this to expand the " +
      "context window — get neighboring entries from the same program. " +
      "Returns entries before and after the target in insertion order. " +
      "Useful when a single business rule match is too narrow.",
    schema: z.object({
      targetId: z.string().min(1).describe("Vector entry ID from a search result"),
      neighborCount: z.number().int().min(1).max(10).optional()
        .describe("Number of neighbors on each side (default 2)"),
      includeTarget: z.boolean().optional()
        .describe("Include the target entry in results (default true)"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        targetId: z.string().min(1),
        neighborCount: z.number().int().min(1).max(10).optional(),
        includeTarget: z.boolean().optional(),
      }).parse(raw);

      const neighborCount = args.neighborCount ?? 2;
      const includeTarget = args.includeTarget !== false;

      // Extract program from target ID (format: "PROGRAM::NODE_ID")
      const program = args.targetId.split("::")[0];
      if (!program) {
        return { error: "Invalid targetId format. Expected 'PROGRAM::NODE_ID'." };
      }

      try {
        return await getChunkNeighbors(args.targetId, neighborCount, includeTarget);
      } catch (err) {
        return { error: `Failed to get neighbors: ${String(err)}` };
      }
    },
  },

  // ── Data Management (Cognee-inspired) ──────────────────────

  {
    name: "agentsmcp_list_data",
    description:
      "List all programs stored in the vector store with their entry counts. " +
      "Use this to see what's been indexed before running recall or forget.",
    schema: z.object({
      detailed: z.boolean().optional()
        .describe("If true, include sample entries per program (default false)"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        detailed: z.boolean().optional(),
      }).parse(raw);

      try {
        const stats = await listProgramStats(args.detailed ?? false);

        return {
          totalPrograms: stats.totalPrograms,
          totalVectors: stats.totalVectors,
          programs: stats.programs,
          message: stats.totalPrograms > 0
            ? `${stats.totalPrograms} program(s), ${stats.totalVectors} total vectors indexed.`
            : "No programs indexed yet. Use agentsmcp_remember to store mainframe source.",
        };
      } catch (err) {
        return { error: `Failed to list data: ${String(err)}` };
      }
    },
  },
  {
    name: "agentsmcp_prune",
    description:
      "Reset the vector store by deleting ALL vectors across ALL programs. " +
      "This is destructive and cannot be undone. Use forget() for targeted " +
      "deletion of a single program.",
    schema: z.object({
      confirm: z.literal(true).describe("Must be set to true to confirm destructive operation"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        confirm: z.literal(true),
      }).parse(raw);

      try {
        const store = getVectorStore();
        const deleted = await store.clear();

        return {
          status: "pruned",
          vectorsDeleted: deleted,
          message: `Pruned ${deleted} vectors from the store. All memory cleared.`,
        };
      } catch {
        return { status: "no_store", message: "No vector store to prune." };
      }
    },
  },

  {
    name: "agentsmcp_usage_stats",
    description:
      "Get MCP tool usage statistics: call counts, average latency per tool, " +
      "error rate, and recent failed background tasks. Useful for ops monitoring.",
    schema: EmptyInput,
    handler: async (_agent, raw) => {
      EmptyInput.parse(raw ?? {});
      const { getMcpUsageStats } = require("../mcp/usage");
      return getMcpUsageStats();
    },
  },

  // ── Health Check (Cognee-inspired) ──────────────────────────

  {
    name: "agentsmcp_health",
    description:
      "Check the health status of the AgentMailbox system. Reports on " +
      "storage, GPU endpoint, Neo4j, BYOS, vLLM, and memory usage. " +
      "Use this to diagnose issues before running remember/recall.",
    schema: EmptyInput,
    handler: async (_agent, raw) => {
      EmptyInput.parse(raw ?? {});

      const { checkHealth } = require("../health");
      const health = await checkHealth();
      return health;
    },
  },

  // ── Eval Benchmark (Cognee-inspired) ────────────────────────

  {
    name: "agentsmcp_run_eval",
    description:
      "Run the evaluation benchmark against COBOL test datasets. " +
      "Measures: parser F1, search MRR, semantic safety, grounding, " +
      "plus DeepEval-style correctness/EM/F1 metrics. " +
      "Produces a cross-system comparison vs Cognee/LightRAG/Mem0/Graphiti. " +
      "Datasets: 'cobol-banking' (5 programs, 25 Q&A) or 'sample' (2 programs, 5 Q&A).",
    schema: z.object({
      dataset: z.enum(["cobol-banking", "sample", "unseen-holdout"]).optional()
        .describe("Dataset to use (default: cobol-banking)"),
      corpusLimit: z.number().int().min(1).optional()
        .describe("Limit number of programs to evaluate"),
      qaLimit: z.number().int().min(1).optional()
        .describe("Limit number of QA pairs to evaluate"),
      verbose: z.boolean().optional()
        .describe("Print detailed output (default false)"),
    }),
    handler: async (_agent, raw) => {
      const args = z.object({
        dataset: z.enum(["cobol-banking", "sample", "unseen-holdout"]).optional(),
        corpusLimit: z.number().int().min(1).optional(),
        qaLimit: z.number().int().min(1).optional(),
        verbose: z.boolean().optional(),
      }).parse(raw);

      const { loadDataset, listDatasets } = require("../eval/registry");
      const { BenchmarkRunner } = require("../eval/runner");

      const datasetId = args.dataset ?? "cobol-banking";
      const ds = loadDataset(datasetId);

      const outputDir = process.env.AGENTSMCP_EVAL_DIR || "./eval-results";

      const runner = new BenchmarkRunner(
        ds.corpus,
        ds.qaPairs,
        {
          name: `eval-${datasetId}-${Date.now().toString(36)}`,
          outputDir,
          corpusLimit: args.corpusLimit,
          qaLimit: args.qaLimit,
          verbose: args.verbose ?? false,
        }
      );

      const result = await runner.run();

      return {
        dataset: ds.meta,
        overall: result.report.overall,
        pass: result.report.pass,
        metrics: result.report.metrics.map((m: any) => ({
          name: m.name,
          value: m.value,
        })),
        parserAvgF1: result.parserResults.reduce(
          (s: number, p: any) => s + p.f1, 0
        ) / Math.max(result.parserResults.length, 1),
        programsEvaluated: result.parserResults.length,
        questionsEvaluated: result.searchResults.length,
        timing: result.timing,
        availableDatasets: listDatasets().map((d: any) => d.id),
        outputDir,
        message: `Benchmark ${result.report.pass ? "PASSED ✅" : "FAILED ❌"} — ` +
          `dataset: ${datasetId}, overall: ${result.report.overall}, ` +
          `${result.parserResults.length} programs, ` +
          `${result.searchResults.length} questions.`,
      };
    },
  },

  // ── Active Learning ─────────────────────────────────────────

  {
    name: "agentsmcp_save_interaction",
    description:
      "Extract and persist persistent coding rules or conventions from a chat " +
      "transcript. Use this when the user corrects you, sets a style preference, " +
      "or provides domain knowledge they want you to remember across all future " +
      "sessions. Optionally tie the rule to a specific AST node.",
    schema: z.object({
      transcript: z.string().min(1).describe("The chat messages containing the new rule or correction"),
      astNodeId: z.string().optional().describe("Optional AST node ID to tie the rule to a specific code location"),
    }),
    handler: async (agent, raw) => {
      const args = z.object({
        transcript: z.string().min(1),
        astNodeId: z.string().optional(),
      }).parse(raw);

      const rules = await extractLearnedRules(args.transcript, args.astNodeId);

      const storage = getAgentStorage();

      let savedCount = 0;
      for (const rule of rules) {
        await storage.upsertLearnedRule(agent.getAgentId(), rule);
        savedCount++;
      }

      return {
        success: true,
        rulesExtracted: savedCount,
        rules,
      };
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

import { TrajectoryLogger, TrajectoryAction } from "../trajectory/logger";

// Map tool names to trajectory action types
const TOOL_ACTION_MAP: Record<string, TrajectoryAction> = {
  agentsmcp_analyze_legacy_impact: "PARSE",
  agentsmcp_parse_cobol: "PARSE",
  agentsmcp_parse_jcl: "PARSE",
  agentsmcp_parse_pli: "PARSE",
  agentsmcp_parse_rexx: "PARSE",
  agentsmcp_semantic_search: "VECTOR_SEARCH",
  agentsmcp_query_graph: "GRAPH_QUERY",
  agentsmcp_query_deepseek: "LLM_GENERATION",
  agentsmcp_impact_analysis: "IMPACT_ANALYSIS",
  agentsmcp_generate_training_data: "GRAPH_QUERY",
  agentsmcp_remember: "PARSE",
  agentsmcp_improve: "PARSE",
  agentsmcp_recall: "VECTOR_SEARCH",
  agentsmcp_forget: "PARSE",
  agentsmcp_task_status: "USER_QUERY",
  agentsmcp_learn_rules: "USER_QUERY",
  agentsmcp_get_learned_rules: "USER_QUERY",
  agentsmcp_declare_interest: "USER_QUERY",
  agentsmcp_run_optimize_loop: "USER_QUERY",
  agentsmcp_get_chunk_neighbors: "VECTOR_SEARCH",
  agentsmcp_list_data: "USER_QUERY",
  agentsmcp_prune: "PARSE",
  agentsmcp_health: "USER_QUERY",
  agentsmcp_run_eval: "USER_QUERY",
};

let _trajectoryLogger: TrajectoryLogger | null = null;

export function getTrajectoryLogger(): TrajectoryLogger {
  if (!_trajectoryLogger) {
    _trajectoryLogger = new TrajectoryLogger({
      logDir: process.env.AGENTSMCP_LOG_DIR || "./logs",
      sessionId: process.env.AGENTSMCP_SESSION_ID,
    });
  }
  return _trajectoryLogger;
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

  const startTime = Date.now();
  const result = await def.handler(agent, args ?? {});
  const latencyMs = Date.now() - startTime;

  // Log to trajectory (audit trail)
  const action = TOOL_ACTION_MAP[name] || "USER_QUERY";
  try {
    const logger = getTrajectoryLogger();
    logger.log({
      action,
      input: JSON.stringify({ tool: name, args }).substring(0, 500),
      output: JSON.stringify(result).substring(0, 500),
      sources: [name],
      latencyMs,
    });
  } catch {
    // Don't fail tool execution if logging fails
  }

  return result;
}

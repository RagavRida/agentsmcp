import {
  Agent,
  AgentAddress,
  Mailbox,
  Message,
  ParticipantRole,
  Thread,
  ThreadSummary,
} from "../types";

/**
 * Options accepted by {@link createStorage}. Today only `url` is consumed;
 * the object form is reserved so adapter-specific knobs (pool size, logger,
 * timeouts) can be added later without another breaking change.
 */
export interface StorageOptions {
  url: string;
}

/**
 * Persistence backend for AgentMailbox.
 *
 * All methods are async so adapters that talk to a network-bound database
 * (Postgres, Redis, ...) can share the same surface as SQLite without
 * forcing a second breaking change later.
 *
 * Error model:
 *   - Getters that look up a single record return `null` when missing.
 *   - All other failures reject (invalid input, I/O error, constraint).
 *
 * Adapter authors: every method should be safe to invoke concurrently from
 * different async tasks. `appendMessage` must be atomic — partial fan-out
 * across messages / threads / mailboxes is a bug.
 */
export interface Storage {
  /**
   * Create tables, indexes, and any other one-time schema. Safe to call
   * multiple times — adapters MUST make this idempotent.
   */
  init(): Promise<void>;

  /** Release underlying connections / file handles. */
  close(): Promise<void>;

  // ---------- Agents ----------

  /** Insert if absent. Returns the existing agent if one is already registered. */
  registerAgent(agentId: AgentAddress): Promise<Agent>;

  /** Returns `null` when no agent with this id exists. */
  getAgent(agentId: AgentAddress): Promise<Agent | null>;

  // ---------- Threads ----------

  createThread(
    participants: AgentAddress[],
    silentParticipants?: AgentAddress[]
  ): Promise<Thread>;

  /** Returns `null` when the thread does not exist. */
  getThread(threadId: string): Promise<Thread | null>;

  /** Convenience for the 2-agent case; returns `null` if no such thread. */
  getThreadByParticipants(
    a: AgentAddress,
    b: AgentAddress
  ): Promise<Thread | null>;

  /** Order-independent participant lookup; returns `null` when not found. */
  getThreadByParticipantSet(
    participants: AgentAddress[]
  ): Promise<Thread | null>;

  /**
   * Roles inferred from message history (to > cc > bcc priority).
   * Returns `[]` when the thread does not exist.
   */
  getThreadParticipants(threadId: string): Promise<ParticipantRole[]>;

  // ---------- Messages ----------

  /**
   * Append a message, update the thread's participant sets, and fan out
   * unread counts to every recipient (TO + CC + BCC, excluding sender).
   * Atomic — either every side effect lands or none does.
   */
  appendMessage(threadId: string, message: Message): Promise<void>;

  /** All messages on a thread, in timestamp ascending order. */
  getMessages(threadId: string): Promise<Message[]>;

  // ---------- Mailbox ----------

  /**
   * Returns an empty mailbox shape when the agent has no threads yet.
   * @param opts.limit   Max threads to return (default 100).
   * @param opts.offset  Offset for pagination (default 0).
   */
  getMailbox(
    agentId: AgentAddress,
    opts?: { limit?: number; offset?: number }
  ): Promise<Mailbox & { total: number }>;

  /** Idempotent. No-op when the agent has no row for the thread. */
  markRead(agentId: AgentAddress, threadId: string): Promise<void>;

  /** Unread messages where the agent is TO, CC, or BCC (and not the sender). */
  getUnread(agentId: AgentAddress): Promise<Message[]>;

  // ---------- Compression cache ----------

  /**
   * Latest stored summary for a thread, or `null` when no compressor has
   * ever run on it. Callers compare `coversMessageIds` against the current
   * message list to decide whether the cache is stale.
   */
  getSummary(threadId: string): Promise<ThreadSummary | null>;

  /**
   * Persist (or overwrite) the latest summary for a thread. Idempotent —
   * always replaces the previous row for the same thread.
   */
  saveSummary(threadId: string, summary: ThreadSummary): Promise<void>;

  // ---------- Context Graph ----------

  /**
   * Insert or update a graph node. The node id is the primary key scoped
   * to agentId. `updatedAt` is set automatically by the adapter.
   */
  upsertNode(
    agentId: AgentAddress,
    node: Omit<GraphNode, "updatedAt">
  ): Promise<void>;

  /** Delete a graph node and all its connected edges (CASCADE). */
  deleteNode(agentId: AgentAddress, nodeId: string): Promise<void>;

  /** Insert or update a directed edge between two existing nodes. */
  addEdge(edge: GraphEdge): Promise<void>;

  /** Remove a specific edge. */
  deleteEdge(
    sourceId: string,
    targetId: string,
    type: string
  ): Promise<void>;

  /**
   * Keyword search on node name/description, then N-hop graph traversal
   * to pull connected entities. Returns the matched nodes and all edges
   * within the traversal radius.
   *
   * @param opts.limit  Cap total returned nodes (default 30, max 100).
   * @param opts.depth  Traversal hop depth (default 2, max 5).
   */
  queryGraph(
    agentId: AgentAddress,
    query: string,
    opts?: { limit?: number; depth?: number }
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;

  // ---------- Codebase Index ----------

  /**
   * Insert or update an index entry. `updatedAt` is set automatically.
   * Agents call this incrementally as they touch files, discover symbols,
   * or make architectural decisions.
   */
  upsertIndex(
    agentId: AgentAddress,
    entry: Omit<CodebaseIndexEntry, "updatedAt">
  ): Promise<void>;

  /** Look up a specific index entry by key. Returns `null` when not found. */
  getIndex(
    agentId: AgentAddress,
    key: string
  ): Promise<CodebaseIndexEntry | null>;

  /**
   * Keyword search across all index entries for an agent. Optionally
   * filter by category. Returns entries whose key or summary contain
   * the query terms.
   *
   * @param opts.limit  Max entries to return (default 50, max 200).
   */
  searchIndex(
    agentId: AgentAddress,
    query: string,
    category?: string,
    opts?: { limit?: number }
  ): Promise<CodebaseIndexEntry[]>;

  /** Remove a single index entry. */
  deleteIndex(agentId: AgentAddress, key: string): Promise<void>;

  /**
   * Batch staleness check. For each { key, currentHash } entry, compares
   * the provided hash against the stored contentHash. Returns three buckets:
   *   - fresh: hash matches → caller may skip re-reading the file
   *   - stale: hash differs → caller should re-read and re-index
   *   - missing: no entry exists → caller must index from scratch
   */
  checkStaleness(
    agentId: AgentAddress,
    entries: Array<{ key: string; currentHash: string }>
  ): Promise<StalenessResult>;

  /**
   * Aggregate file-level index entries into a module-level summary.
   * Concatenates the summaries of all fileKeys into a single "module"
   * category entry stored under moduleKey, and back-fills parentKey on
   * every file entry.
   */
  rollupModule(
    agentId: AgentAddress,
    moduleKey: string,
    fileKeys: string[]
  ): Promise<void>;

  // ---------- Git / Version Control ----------

  /**
   * Snapshot the agent's current graph (nodes + edges) and codebase index
   * into an immutable commit. Each commit records its parent so the full
   * history is a linked list. Adapters set `parentId` to the most recent
   * commit on the same branch, or null if this is the first commit.
   *
   * @param opts.keepLast  After committing, prune old commits on this branch
   *                       retaining only the N most recent. 0 = keep all.
   */
  createCommit(
    agentId: AgentAddress,
    message: string,
    opts?: { branch?: string; keepLast?: number }
  ): Promise<AgentCommit>;

  /** Delete a single commit. The snapshot data is removed permanently. */
  deleteCommit(agentId: AgentAddress, commitId: string): Promise<boolean>;

  /**
   * List commits for an agent, most recent first.
   * @param opts.branch  Filter to a specific branch (default: all branches).
   * @param opts.limit   Cap returned commits (default 20, max 100).
   */
  listCommits(
    agentId: AgentAddress,
    opts?: { branch?: string; limit?: number }
  ): Promise<AgentCommit[]>;

  /**
   * Get a specific commit including its full snapshot payload.
   * Returns null when the commit does not exist or belongs to a different agent.
   */
  getCommit(
    agentId: AgentAddress,
    commitId: string
  ): Promise<(AgentCommit & { snapshot: CommitSnapshot }) | null>;

  /**
   * Destructively overwrite the agent's current graph + index with the
   * state captured in the named commit. All current nodes, edges, and
   * index entries are removed first. Atomic — either the full state lands
   * or the original is preserved.
   */
  restoreCommit(agentId: AgentAddress, commitId: string): Promise<void>;

  /**
   * Diff two commits. Pass `null` for `toId` to diff against the agent's
   * current live state. Returns three buckets for each domain (nodes,
   * index): added, removed, and modified keys/ids.
   */
  diffCommits(
    agentId: AgentAddress,
    fromId: string,
    toId: string | null
  ): Promise<CommitDiff>;

  /**
   * Three-way merge: take the HEAD commit of `fromBranch` and combine it
   * with the HEAD commit of `toBranch`, producing a new commit on `toBranch`.
   *
   * Strategies:
   *   - "union"  (default): last-write-wins by updatedAt/content hash.
   *              Nodes/entries present in either branch are included; on
   *              conflict the one with the higher contentHash sort order wins.
   *   - "ours":  `toBranch` wins all conflicts.
   *   - "theirs": `fromBranch` wins all conflicts.
   *
   * Throws when either branch has no commits.
   */
  mergeCommits(
    agentId: AgentAddress,
    fromBranch: string,
    toBranch: string,
    opts?: { strategy?: "union" | "ours" | "theirs"; message?: string }
  ): Promise<AgentCommit>;
}

// ---------- Context Graph types ----------

export type GraphNodeType =
  | "message"
  | "file"
  | "symbol"
  | "decision"
  | "task";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  description?: string;
  /** Arbitrary extra data. Optional — not every node needs it. */
  metadata?: Record<string, unknown>;
  updatedAt: number;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: string;
  /** Traversal weight. Defaults to 1.0 when omitted. */
  weight?: number;
}

// ---------- Codebase Index types ----------

export type IndexCategory =
  | "file"
  | "symbol"
  | "api"
  | "config"
  | "architecture"
  | "module"
  | "overview";

export interface CodebaseIndexEntry {
  key: string;
  category: IndexCategory;
  summary: string;
  /** Arbitrary extra data. Optional — not every entry needs it. */
  metadata?: Record<string, unknown>;
  updatedAt: number;
  /** Parent module key, e.g. "module:auth" for a file entry. */
  parentKey?: string;
  /** SHA-256 of the raw file content at index time. Used for staleness checks. */
  contentHash?: string;
  /** AgentId that last created/updated this entry. */
  indexedBy?: string;
  /** True when the stored contentHash differs from the current file hash. */
  stale?: boolean;
}

// ---------- Staleness types ----------

export interface StalenessResult {
  /** Keys whose stored contentHash matches the provided hash — safe to use cached summary. */
  fresh: string[];
  /** Keys whose hash differs — re-read the file and update the summary. */
  stale: string[];
  /** Keys that have no entry in the index at all — must be indexed from scratch. */
  missing: string[];
}

// ---------- Git / Version Control ----------

/** Hard caps on snapshot size to prevent runaway commit payloads. */
export const MAX_COMMIT_NODES = 5000;
export const MAX_COMMIT_INDEX_ENTRIES = 5000;

/** Immutable snapshot of an agent's graph + index at a point in time. */
export interface AgentCommit {
  id: string;
  agentId: string;
  /** Parent commit id, or null for the root commit on a branch. */
  parentId: string | null;
  branch: string;
  message: string;
  nodeCount: number;
  indexCount: number;
  /** Short SHA-256 of the snapshot content — useful for quick equality checks. */
  snapshotHash: string;
  createdAt: number;
}

/** Full snapshot payload stored inside a commit. */
export interface CommitSnapshot {
  nodes: Array<Omit<GraphNode, "updatedAt">>;
  edges: GraphEdge[];
  indexEntries: Array<Omit<CodebaseIndexEntry, "updatedAt" | "stale">>;
}

/** What changed between two commits (or a commit and current live state). */
export interface CommitDiff {
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesModified: string[];
  indexAdded: string[];
  indexRemoved: string[];
  indexModified: string[];
}

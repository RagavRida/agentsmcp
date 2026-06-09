import {
  AgentAddress,
  ContextFrame,
  Message,
  ParticipantRole,
  ReceiveResult,
  SendOptions,
  Thread,
  ThreadSummary,
} from "./types";
import type {
  AgentCommit,
  CodebaseIndexEntry,
  CommitDiff,
  CommitSnapshot,
  GraphEdge,
  GraphNode,
  StalenessResult,
} from "./storage/interface";

export interface AgentMailboxConfig {
  agentId: AgentAddress;
  server?: string;
  apiKey?: string;
}

export interface SendResult {
  messageId: string;
  threadId: string;
  deliveredTo: AgentAddress[];
}

export class AgentMailbox {
  private agentId: AgentAddress;
  private server: string;
  private apiKey?: string;

  constructor(config: AgentMailboxConfig) {
    if (!config.agentId) throw new Error("agentId is required");
    this.agentId = config.agentId;
    this.server = (config.server ?? "http://localhost:3000").replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.server}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AgentMailbox ${method} ${path} failed: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  async connect(): Promise<void> {
    await this.request<{ agentId: string; created: boolean }>(
      "POST",
      "/agents/register",
      { agentId: this.agentId }
    );
  }

  async send(
    to: AgentAddress,
    payload: unknown,
    options: SendOptions = {}
  ): Promise<SendResult> {
    return this.request<SendResult>("POST", "/messages/send", {
      from: this.agentId,
      to,
      payload,
      contextSnapshot: options.contextSnapshot,
      threadId: options.threadId,
      cc: options.cc,
      bcc: options.bcc,
      replyTo: options.replyTo,
    });
  }

  async replyAll(
    threadId: string,
    payload: unknown,
    options: { contextSnapshot?: Record<string, unknown> } = {}
  ): Promise<SendResult> {
    return this.request<SendResult>("POST", "/messages/reply-all", {
      from: this.agentId,
      threadId,
      payload,
      contextSnapshot: options.contextSnapshot,
    });
  }

  async receive(
    from?: AgentAddress,
    opts: { recent?: number } = {}
  ): Promise<ReceiveResult> {
    const recentParam = opts.recent != null ? `?recent=${opts.recent}` : "";
    const { messages } = await this.request<{ messages: ContextFrame[] }>(
      "GET",
      `/mailbox/${encodeURIComponent(this.agentId)}/unread${recentParam}`
    );
    const filtered = from ? messages.filter((m) => m.from === from) : messages;

    const last = filtered[filtered.length - 1];
    // Spread (not field-list) so any new optional field added to
    // ThreadContext flows through without another SDK fix. The same
    // pattern bit us three times in 0.3.0–0.3.2.
    const context: ReceiveResult["context"] = last
      ? { ...last.context }
      : {
          snapshot: {},
          threadSummary: "",
          recentMessages: [] as Message[],
        };

    return { messages: filtered, context };
  }

  async unread(): Promise<ContextFrame[]> {
    const { messages } = await this.request<{ messages: ContextFrame[] }>(
      "GET",
      `/mailbox/${encodeURIComponent(this.agentId)}/unread`
    );
    return messages;
  }

  async sync(
    threadId: string,
    opts: { recent?: number } = {}
  ): Promise<{
    context: {
      snapshot: Record<string, unknown>;
      threadSummary: string;
      threadSummaryStructured?: ThreadSummary;
      recentMessages: Message[];
      tokenCount?: number;
    };
  }> {
    const recentParam = opts.recent != null ? `&recent=${opts.recent}` : "";
    return this.request<{
      context: {
        snapshot: Record<string, unknown>;
        threadSummary: string;
        threadSummaryStructured?: ThreadSummary;
        recentMessages: Message[];
        tokenCount?: number;
      };
    }>(
      "GET",
      `/threads/${encodeURIComponent(threadId)}/sync?as=${encodeURIComponent(
        this.agentId
      )}${recentParam}`
    );
  }

  async threads(): Promise<Thread[]> {
    const { threads } = await this.request<{
      threads: Thread[];
      unreadCount: number;
    }>("GET", `/mailbox/${encodeURIComponent(this.agentId)}`);
    return threads;
  }

  async participants(threadId: string): Promise<ParticipantRole[]> {
    const { participants } = await this.request<{
      participants: ParticipantRole[];
    }>(
      "GET",
      `/threads/${encodeURIComponent(threadId)}/participants?as=${encodeURIComponent(
        this.agentId
      )}`
    );
    return participants;
  }

  async markRead(threadId: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/read`,
      { threadId }
    );
  }

  // ---------- Context Graph ----------

  async upsertNode(
    node: Omit<GraphNode, "updatedAt">
  ): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/graph/nodes`,
      node
    );
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/graph/edges`,
      edge
    );
  }

  async queryGraph(
    query: string,
    opts: { limit?: number; depth?: number } = {}
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    let path = `/mailbox/${encodeURIComponent(this.agentId)}/graph/query?q=${encodeURIComponent(query)}`;
    if (opts.limit != null) path += `&limit=${opts.limit}`;
    if (opts.depth != null) path += `&depth=${opts.depth}`;
    return this.request<{ nodes: GraphNode[]; edges: GraphEdge[] }>("GET", path);
  }

  // ---------- Codebase Index ----------

  async upsertIndex(
    entry: Omit<CodebaseIndexEntry, "updatedAt">
  ): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/index`,
      entry
    );
  }

  async getIndex(key: string): Promise<CodebaseIndexEntry | null> {
    try {
      return await this.request<CodebaseIndexEntry>(
        "GET",
        `/mailbox/${encodeURIComponent(this.agentId)}/index/${encodeURIComponent(key)}`
      );
    } catch {
      return null;
    }
  }

  async searchIndex(
    query: string,
    category?: string,
    opts: { limit?: number } = {}
  ): Promise<CodebaseIndexEntry[]> {
    let path = `/mailbox/${encodeURIComponent(this.agentId)}/index?q=${encodeURIComponent(query)}`;
    if (category) path += `&category=${encodeURIComponent(category)}`;
    if (opts.limit != null) path += `&limit=${opts.limit}`;
    const res = await this.request<{ entries: CodebaseIndexEntry[] }>("GET", path);
    return res.entries;
  }

  async checkStaleness(
    entries: Array<{ key: string; currentHash: string }>
  ): Promise<StalenessResult> {
    return this.request<StalenessResult>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/index/check-staleness`,
      { entries }
    );
  }

  async rollupModule(
    moduleKey: string,
    fileKeys: string[]
  ): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/index/rollup`,
      { moduleKey, fileKeys }
    );
  }

  // ---------- Git / Version Control ----------

  async gitCommit(
    message: string,
    opts?: { branch?: string; keepLast?: number }
  ): Promise<AgentCommit> {
    return this.request<AgentCommit>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/git/commit`,
      { message, branch: opts?.branch, keepLast: opts?.keepLast }
    );
  }

  async gitLog(opts?: { branch?: string; limit?: number }): Promise<AgentCommit[]> {
    let path = `/mailbox/${encodeURIComponent(this.agentId)}/git/log`;
    const params = new URLSearchParams();
    if (opts?.branch) params.set("branch", opts.branch);
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if ([...params].length) path += `?${params.toString()}`;
    const { commits } = await this.request<{ commits: AgentCommit[] }>("GET", path);
    return commits;
  }

  async getCommit(
    commitId: string
  ): Promise<(AgentCommit & { snapshot: CommitSnapshot }) | null> {
    try {
      return await this.request<AgentCommit & { snapshot: CommitSnapshot }>(
        "GET",
        `/mailbox/${encodeURIComponent(this.agentId)}/git/commits/${encodeURIComponent(commitId)}`
      );
    } catch {
      return null;
    }
  }

  async gitRestore(commitId: string): Promise<{ ok: boolean; restoredTo: string }> {
    return this.request<{ ok: boolean; restoredTo: string }>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/git/restore/${encodeURIComponent(commitId)}`
    );
  }

  async gitDiff(
    fromId: string,
    toId?: string
  ): Promise<CommitDiff> {
    let path = `/mailbox/${encodeURIComponent(this.agentId)}/git/diff?from=${encodeURIComponent(fromId)}`;
    if (toId) path += `&to=${encodeURIComponent(toId)}`;
    return this.request<CommitDiff>("GET", path);
  }

  async gitMerge(
    fromBranch: string,
    toBranch: string,
    opts?: { strategy?: "union" | "ours" | "theirs" }
  ): Promise<AgentCommit> {
    return this.request<AgentCommit>(
      "POST",
      `/mailbox/${encodeURIComponent(this.agentId)}/git/merge`,
      { fromBranch, toBranch, strategy: opts?.strategy ?? "union" }
    );
  }

  // ---------- Annotations (client-side) ----------

  /**
   * Analyze a source file using this agent's graph + index, then return the
   * file with @context JSDoc annotations inserted/updated. Pure client-side —
   * no new server routes hit beyond the existing getIndex / queryGraph.
   */
  async annotateFile(filePath: string, source: string): Promise<string> {
    const { Annotator } = await import("./annotator");
    return new Annotator(this).annotateFile(filePath, source);
  }

  /** Annotate + stamp every block's @changed with the supplied edit summary. */
  async postEditAnnotate(
    filePath: string,
    source: string,
    editSummary: string
  ): Promise<string> {
    const { Annotator } = await import("./annotator");
    return new Annotator(this).postEditAnnotate(filePath, source, editSummary);
  }
}

export * from "./types";
export { assembleContext } from "./context";
export type {
  AgentCommit,
  CommitDiff,
  CommitSnapshot,
  GraphNode,
  GraphEdge,
  GraphNodeType,
  CodebaseIndexEntry,
  IndexCategory,
  StalenessResult,
} from "./storage/interface";
export type {
  CodeAnnotation,
  FileAnnotation,
  AnnotateOptions,
  AnnotatableBlock,
} from "./annotations";
export { Annotator } from "./annotator";

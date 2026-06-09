import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  Agent,
  AgentAddress,
  Mailbox,
  Message,
  ParticipantRole,
  Thread,
  ThreadSummary,
} from "../types";
import {
  AgentCommit,
  CodebaseIndexEntry,
  CommitDiff,
  CommitSnapshot,
  GraphEdge,
  GraphNode,
  MAX_COMMIT_INDEX_ENTRIES,
  MAX_COMMIT_NODES,
  StalenessResult,
  Storage,
  StorageOptions,
} from "./interface";

// Minimal structural type we need from `pg`. Avoids a hard compile-time
// dependency for callers who only use the SQLite adapter — mirrors the
// optional-peer pattern used by ClaudeCompressor / OpenAICompressor.
interface PgQueryResult<R = unknown> {
  rows: R[];
  rowCount: number | null;
}
interface PgClient {
  query<R = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<R>>;
  release(): void;
}
interface PgPool {
  connect(): Promise<PgClient>;
  query<R = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<R>>;
  end(): Promise<void>;
}
type PgPoolCtor = new (cfg: {
  connectionString: string;
  max?: number;
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
}) => PgPool;

interface MessageRow {
  id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string | null;
  payload: unknown;
  context_snapshot: Record<string, unknown> | null;
  timestamp: string | number;
}

interface ThreadRow {
  id: string;
  created_at: Date;
  updated_at: Date;
}

function toMs(v: string | number | Date): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return Number(v);
}

export interface PostgresStorageOptions extends StorageOptions {
  /** Override pool max size. Falls back to POSTGRES_POOL_MAX env var, then 10. */
  poolMax?: number;
}

export class PostgresStorage implements Storage {
  private readonly url: string;
  private readonly poolMax: number;
  private pool: PgPool | null = null;
  private poolPromise: Promise<PgPool> | null = null;

  constructor(opts: string | PostgresStorageOptions) {
    const o = typeof opts === "string" ? { url: opts } : opts;
    this.url = o.url;
    const envMax = process.env.POSTGRES_POOL_MAX ?? process.env.PG_POOL_MAX;
    this.poolMax = o.poolMax ?? (envMax ? Number(envMax) : 10);
  }

  /**
   * Expose the underlying `pg.Pool` to in-process collaborators (e.g. the
   * cloud-tier `ScopedStorage` wrapper) that need to share connection state
   * without round-tripping every query through this class.
   *
   * External callers should not depend on the concrete `pg` types — treat
   * the returned value as opaque.
   */
  public async getRawPool(): Promise<PgPool> {
    return this.getPool();
  }

  private async getPool(): Promise<PgPool> {
    if (this.pool) return this.pool;
    if (this.poolPromise) return this.poolPromise;
    this.poolPromise = (async () => {
      let mod: { Pool?: PgPoolCtor; default?: { Pool?: PgPoolCtor } };
      try {
        mod = (await import("pg")) as typeof mod;
      } catch {
        throw new Error(
          "PostgresStorage requires the `pg` package. " +
            "Install it with: npm install pg"
        );
      }
      const Pool = mod.Pool ?? mod.default?.Pool;
      if (!Pool) throw new Error("pg did not export a Pool constructor");
      // node-pg does NOT enable SSL just because the URL has `?sslmode=...`.
      // RDS Postgres ships pg_hba configured for SSL-only by default. Detect
      // the user's intent from the URL or env and pass an `ssl` option that
      // actually triggers TLS negotiation.
      const wantsSsl =
        /[?&]sslmode=(require|verify-ca|verify-full)/i.test(this.url) ||
        process.env.PGSSLMODE === "require" ||
        process.env.AGENTSMCP_DB_SSL === "true";
      const ssl = wantsSsl ? { rejectUnauthorized: false } : undefined;
      this.pool = new Pool({
        connectionString: this.url,
        max: this.poolMax,
        ...(ssl ? { ssl } : {}),
      });
      return this.pool;
    })();
    return this.poolPromise;
  }

  async init(): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS threads (
          id UUID PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS thread_participants (
          thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('visible','silent')),
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (thread_id, agent_id)
        );

        CREATE INDEX IF NOT EXISTS idx_thread_participants_agent
          ON thread_participants(agent_id);

        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY,
          thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          cc TEXT[] NOT NULL DEFAULT '{}',
          bcc TEXT[] NOT NULL DEFAULT '{}',
          reply_to TEXT,
          payload JSONB NOT NULL,
          context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
          timestamp BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_messages_thread_ts
          ON messages(thread_id, timestamp);

        CREATE TABLE IF NOT EXISTS mailbox_state (
          agent_id TEXT NOT NULL,
          thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          unread_count INTEGER NOT NULL DEFAULT 0,
          last_read_at TIMESTAMPTZ NOT NULL DEFAULT to_timestamp(0),
          PRIMARY KEY (agent_id, thread_id)
        );

        CREATE INDEX IF NOT EXISTS idx_mailbox_state_agent_unread
          ON mailbox_state(agent_id, unread_count);

        CREATE TABLE IF NOT EXISTS thread_summaries (
          thread_id UUID PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
          summary JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS graph_nodes (
          id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('message', 'file', 'symbol', 'decision', 'task')),
          name TEXT NOT NULL,
          description TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (id, agent_id)
        );

        CREATE TABLE IF NOT EXISTS graph_edges (
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          type TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0,
          PRIMARY KEY (source_id, target_id, type)
        );

        CREATE INDEX IF NOT EXISTS idx_graph_nodes_agent ON graph_nodes(agent_id);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);

        CREATE TABLE IF NOT EXISTS codebase_index (
          key TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('file', 'symbol', 'api', 'config', 'architecture', 'module', 'overview')),
          summary TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          parent_key TEXT,
          content_hash TEXT,
          indexed_by TEXT,
          stale BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (key, agent_id)
        );

        CREATE INDEX IF NOT EXISTS idx_codebase_index_agent ON codebase_index(agent_id);
        CREATE INDEX IF NOT EXISTS idx_codebase_index_category ON codebase_index(agent_id, category);
      `);

      // Migration 003: GitHub OAuth fields on users
      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id BIGINT UNIQUE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
        CREATE INDEX IF NOT EXISTS idx_users_github_id
          ON users(github_id) WHERE github_id IS NOT NULL;
      `);

      // Migration 004: index hierarchy + staleness columns (v0.5.0)
      await client.query(`
        ALTER TABLE codebase_index ADD COLUMN IF NOT EXISTS parent_key TEXT;
        ALTER TABLE codebase_index ADD COLUMN IF NOT EXISTS content_hash TEXT;
        ALTER TABLE codebase_index ADD COLUMN IF NOT EXISTS indexed_by TEXT;
        ALTER TABLE codebase_index ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT FALSE;
      `);

      // Migration 005: agent git / version control — agent_commits table
      // Migration 006: thread participants_hash for TOCTOU prevention
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_commits (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          parent_id TEXT REFERENCES agent_commits(id),
          branch TEXT NOT NULL DEFAULT 'main',
          message TEXT NOT NULL DEFAULT '',
          snapshot JSONB NOT NULL,
          snapshot_hash TEXT NOT NULL,
          node_count INTEGER NOT NULL DEFAULT 0,
          index_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_agent_commits_agent
          ON agent_commits(agent_id, created_at DESC);
      `);

      await client.query(`
        ALTER TABLE threads ADD COLUMN IF NOT EXISTS participants_hash TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_participants_hash
          ON threads(participants_hash, user_id)
          WHERE participants_hash IS NOT NULL;
      `);

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.poolPromise = null;
    }
  }

  // ---------- Agents ----------

  async registerAgent(agentId: AgentAddress): Promise<Agent> {
    const pool = await this.getPool();
    const res = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO agents (id) VALUES ($1)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, created_at`,
      [agentId]
    );
    if (res.rows.length > 0) {
      return { id: res.rows[0].id, createdAt: toMs(res.rows[0].created_at) };
    }
    const existing = await this.getAgent(agentId);
    if (!existing) throw new Error(`failed to register agent ${agentId}`);
    return existing;
  }

  async getAgent(agentId: AgentAddress): Promise<Agent | null> {
    const pool = await this.getPool();
    const res = await pool.query<{ id: string; created_at: Date }>(
      "SELECT id, created_at FROM agents WHERE id = $1",
      [agentId]
    );
    if (res.rows.length === 0) return null;
    return { id: res.rows[0].id, createdAt: toMs(res.rows[0].created_at) };
  }

  // ---------- Threads ----------

  private uniqueSorted(xs: AgentAddress[]): AgentAddress[] {
    return Array.from(new Set(xs)).sort();
  }

  private async loadThreadParticipants(
    client: PgClient | PgPool,
    threadId: string
  ): Promise<{ visible: AgentAddress[]; silent: AgentAddress[] }> {
    const res = await client.query<{ agent_id: string; role: string }>(
      `SELECT agent_id, role FROM thread_participants WHERE thread_id = $1`,
      [threadId]
    );
    const visible: AgentAddress[] = [];
    const silent: AgentAddress[] = [];
    for (const r of res.rows) {
      if (r.role === "visible") visible.push(r.agent_id);
      else silent.push(r.agent_id);
    }
    return { visible: visible.sort(), silent: silent.sort() };
  }

  private async hydrateThread(
    client: PgClient | PgPool,
    row: ThreadRow
  ): Promise<Thread> {
    const { visible, silent } = await this.loadThreadParticipants(client, row.id);
    const messages = await this.getMessagesWith(client, row.id);
    return {
      id: row.id,
      participants: visible,
      silentParticipants: silent,
      messages,
      createdAt: toMs(row.created_at),
      updatedAt: toMs(row.updated_at),
    };
  }

  async createThread(
    participants: AgentAddress[],
    silentParticipants: AgentAddress[] = []
  ): Promise<Thread> {
    const pool = await this.getPool();
    const id = uuidv4();
    const visible = this.uniqueSorted(participants);
    const silentSet = new Set(this.uniqueSorted(silentParticipants));
    for (const v of visible) silentSet.delete(v);
    const silent = Array.from(silentSet).sort();
    // Deterministic hash for the visible participant set — guards against
    // concurrent duplicate thread creation (TOCTOU race in the send route).
    const participantsHash = visible.join(",");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // ON CONFLICT DO NOTHING: if a concurrent transaction already inserted
      // a thread with the same participants_hash, skip and fall through to the
      // SELECT below so we return the existing thread instead of failing.
      const tRes = await client.query<ThreadRow>(
        `INSERT INTO threads (id, participants_hash)
         VALUES ($1, $2)
         ON CONFLICT (participants_hash, user_id) DO NOTHING
         RETURNING id, created_at, updated_at`,
        [id, participantsHash]
      );

      let actualId: string;
      let created_at: Date;
      let updated_at: Date;

      if (tRes.rows.length === 0) {
        // Lost the race — find the winning thread
        const existing = await client.query<ThreadRow>(
          `SELECT id, created_at, updated_at FROM threads
           WHERE participants_hash = $1 AND user_id IS NULL`,
          [participantsHash]
        );
        if (existing.rows.length === 0) throw new Error("thread creation race: no winner found");
        actualId = existing.rows[0].id;
        created_at = existing.rows[0].created_at;
        updated_at = existing.rows[0].updated_at;
      } else {
        actualId = tRes.rows[0].id;
        created_at = tRes.rows[0].created_at;
        updated_at = tRes.rows[0].updated_at;
        for (const a of visible) {
          await client.query(
            `INSERT INTO agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [a]
          );
          await client.query(
            `INSERT INTO thread_participants (thread_id, agent_id, role)
             VALUES ($1, $2, 'visible') ON CONFLICT (thread_id, agent_id) DO NOTHING`,
            [actualId, a]
          );
        }
        for (const a of silent) {
          await client.query(
            `INSERT INTO agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [a]
          );
          await client.query(
            `INSERT INTO thread_participants (thread_id, agent_id, role)
             VALUES ($1, $2, 'silent') ON CONFLICT (thread_id, agent_id) DO NOTHING`,
            [actualId, a]
          );
        }
      }
      await client.query("COMMIT");
      return {
        id: actualId,
        participants: visible,
        silentParticipants: silent,
        messages: [],
        createdAt: toMs(created_at),
        updatedAt: toMs(updated_at),
      };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async getThread(threadId: string): Promise<Thread | null> {
    const pool = await this.getPool();
    const res = await pool.query<ThreadRow>(
      `SELECT id, created_at, updated_at FROM threads WHERE id = $1`,
      [threadId]
    );
    if (res.rows.length === 0) return null;
    return this.hydrateThread(pool, res.rows[0]);
  }

  async getThreadByParticipants(
    a: AgentAddress,
    b: AgentAddress
  ): Promise<Thread | null> {
    return this.getThreadByParticipantSet([a, b]);
  }

  async getThreadByParticipantSet(
    participants: AgentAddress[]
  ): Promise<Thread | null> {
    const pool = await this.getPool();
    const target = this.uniqueSorted(participants);
    const res = await pool.query<ThreadRow>(
      `SELECT t.id, t.created_at, t.updated_at
       FROM threads t
       WHERE (
         SELECT array_agg(tp.agent_id ORDER BY tp.agent_id)
         FROM thread_participants tp
         WHERE tp.thread_id = t.id AND tp.role = 'visible'
       ) = $1::text[]
       LIMIT 1`,
      [target]
    );
    if (res.rows.length === 0) return null;
    return this.hydrateThread(pool, res.rows[0]);
  }

  // ---------- Messages ----------

  async appendMessage(threadId: string, message: Message): Promise<void> {
    const pool = await this.getPool();
    const cc = this.uniqueSorted(message.cc ?? []);
    const bcc = this.uniqueSorted(message.bcc ?? []);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the thread row so concurrent appends serialise on participant /
      // mailbox updates.
      const tRes = await client.query<{ id: string }>(
        `SELECT id FROM threads WHERE id = $1 FOR UPDATE`,
        [threadId]
      );
      if (tRes.rows.length === 0) {
        throw new Error(`thread ${threadId} not found`);
      }

      await client.query(
        `INSERT INTO messages
         (id, thread_id, from_agent, to_agent, cc, bcc, reply_to,
          payload, context_snapshot, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
        [
          message.id,
          threadId,
          message.from,
          message.to,
          cc,
          bcc,
          message.replyTo ?? null,
          JSON.stringify(message.payload ?? null),
          JSON.stringify(message.contextSnapshot ?? {}),
          message.timestamp,
        ]
      );

      await client.query(
        `UPDATE threads SET updated_at = to_timestamp($2::double precision / 1000.0)
         WHERE id = $1`,
        [threadId, message.timestamp]
      );

      // Register any newly-seen agents and add them to thread_participants.
      // Visible (from/to/cc) trumps silent (bcc).
      const visibleNew = this.uniqueSorted([message.from, message.to, ...cc]);
      for (const a of visibleNew) {
        await client.query(
          `INSERT INTO agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
          [a]
        );
        await client.query(
          `INSERT INTO thread_participants (thread_id, agent_id, role)
           VALUES ($1, $2, 'visible')
           ON CONFLICT (thread_id, agent_id) DO UPDATE SET role = 'visible'`,
          [threadId, a]
        );
      }
      for (const a of bcc) {
        await client.query(
          `INSERT INTO agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
          [a]
        );
        // Only insert as silent if not already visible — don't downgrade.
        await client.query(
          `INSERT INTO thread_participants (thread_id, agent_id, role)
           VALUES ($1, $2, 'silent')
           ON CONFLICT (thread_id, agent_id) DO NOTHING`,
          [threadId, a]
        );
      }

      // Fan-out mailbox_state: ensure row exists for every participant,
      // increment unread_count for recipients (to/cc/bcc) excluding sender.
      const allParticipants = await this.loadThreadParticipants(client, threadId);
      const everyone = new Set<AgentAddress>([
        ...allParticipants.visible,
        ...allParticipants.silent,
      ]);
      const recipients = new Set<AgentAddress>(
        [message.to, ...cc, ...bcc].filter((a) => a !== message.from)
      );

      for (const agentId of everyone) {
        const isRecipient = recipients.has(agentId);
        await client.query(
          `INSERT INTO mailbox_state (agent_id, thread_id, unread_count)
           VALUES ($1, $2, $3)
           ON CONFLICT (agent_id, thread_id)
           DO UPDATE SET unread_count = mailbox_state.unread_count + $3`,
          [agentId, threadId, isRecipient ? 1 : 0]
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private rowToMessage(r: MessageRow): Message {
    const out: Message = {
      id: r.id,
      threadId: r.thread_id,
      from: r.from_agent,
      to: r.to_agent,
      payload: r.payload,
      contextSnapshot: r.context_snapshot ?? {},
      timestamp: toMs(r.timestamp),
    };
    const cc = r.cc ?? [];
    const bcc = r.bcc ?? [];
    if (cc.length > 0) out.cc = cc;
    if (bcc.length > 0) out.bcc = bcc;
    if (r.reply_to) out.replyTo = r.reply_to;
    return out;
  }

  private async getMessagesWith(
    client: PgClient | PgPool,
    threadId: string
  ): Promise<Message[]> {
    const res = await client.query<MessageRow>(
      `SELECT id, thread_id, from_agent, to_agent, cc, bcc, reply_to,
              payload, context_snapshot, timestamp
       FROM messages WHERE thread_id = $1 ORDER BY timestamp ASC`,
      [threadId]
    );
    return res.rows.map((r) => this.rowToMessage(r));
  }

  async getMessages(threadId: string): Promise<Message[]> {
    const pool = await this.getPool();
    return this.getMessagesWith(pool, threadId);
  }

  async getThreadParticipants(threadId: string): Promise<ParticipantRole[]> {
    const pool = await this.getPool();
    const messages = await this.getMessagesWith(pool, threadId);
    if (messages.length === 0) {
      const thread = await this.getThread(threadId);
      if (!thread) return [];
      return thread.participants.map((agentId) => ({
        agentId,
        role: "to" as const,
        joinedAt: thread.createdAt,
      }));
    }

    const roles = new Map<AgentAddress, ParticipantRole>();
    const priority = { to: 3, cc: 2, bcc: 1 } as const;
    const upgrade = (
      agentId: AgentAddress,
      role: ParticipantRole["role"],
      at: number
    ) => {
      const cur = roles.get(agentId);
      if (!cur) {
        roles.set(agentId, { agentId, role, joinedAt: at });
        return;
      }
      const better = priority[role] > priority[cur.role];
      roles.set(agentId, {
        agentId,
        role: better ? role : cur.role,
        joinedAt: Math.min(cur.joinedAt, at),
      });
    };

    for (const m of messages) {
      upgrade(m.from, "to", m.timestamp);
      upgrade(m.to, "to", m.timestamp);
      for (const a of m.cc ?? []) upgrade(a, "cc", m.timestamp);
      for (const a of m.bcc ?? []) upgrade(a, "bcc", m.timestamp);
    }
    return Array.from(roles.values()).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  // ---------- Mailbox ----------

  async getMailbox(
    agentId: AgentAddress,
    opts?: { limit?: number; offset?: number }
  ): Promise<Mailbox & { total: number }> {
    const pool = await this.getPool();
    const limit = Math.min(opts?.limit ?? 100, 1000);
    const offset = Math.max(opts?.offset ?? 0, 0);

    const [pageRes, totalRes] = await Promise.all([
      pool.query<{ thread_id: string; unread_count: number }>(
        `SELECT thread_id, unread_count FROM mailbox_state
         WHERE agent_id = $1
         ORDER BY thread_id
         LIMIT $2 OFFSET $3`,
        [agentId, limit, offset]
      ),
      pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM mailbox_state WHERE agent_id = $1`,
        [agentId]
      ),
    ]);
    const threads = pageRes.rows.map((r) => r.thread_id);
    const unreadCount = pageRes.rows.reduce((acc, r) => acc + Number(r.unread_count), 0);
    return { agentId, threads, unreadCount, total: Number(totalRes.rows[0]?.c ?? 0) };
  }

  async markRead(agentId: AgentAddress, threadId: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `UPDATE mailbox_state
       SET unread_count = 0, last_read_at = NOW()
       WHERE agent_id = $1 AND thread_id = $2`,
      [agentId, threadId]
    );
  }

  async getUnread(agentId: AgentAddress): Promise<Message[]> {
    const pool = await this.getPool();
    const res = await pool.query<MessageRow>(
      `SELECT m.id, m.thread_id, m.from_agent, m.to_agent, m.cc, m.bcc, m.reply_to,
              m.payload, m.context_snapshot, m.timestamp
       FROM messages m
       JOIN mailbox_state mb
         ON mb.thread_id = m.thread_id AND mb.agent_id = $1
       WHERE m.from_agent <> $1
         AND to_timestamp(m.timestamp::double precision / 1000.0) > mb.last_read_at
         AND ($1 = m.to_agent OR $1 = ANY(m.cc) OR $1 = ANY(m.bcc))
       ORDER BY m.timestamp ASC`,
      [agentId]
    );
    return res.rows.map((r) => this.rowToMessage(r));
  }

  // ---------- Compression cache ----------

  async getSummary(threadId: string): Promise<ThreadSummary | null> {
    const pool = await this.getPool();
    const res = await pool.query<{ summary: ThreadSummary }>(
      `SELECT summary FROM thread_summaries WHERE thread_id = $1`,
      [threadId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].summary;
  }

  async saveSummary(threadId: string, summary: ThreadSummary): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO thread_summaries (thread_id, summary)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (thread_id) DO UPDATE SET
         summary = excluded.summary,
         created_at = NOW()`,
      [threadId, JSON.stringify(summary)]
    );
  }

  // ---------- Context Graph ----------

  async upsertNode(
    agentId: AgentAddress,
    node: Omit<GraphNode, "updatedAt">
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO graph_nodes (id, agent_id, type, name, description, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT (id, agent_id) DO UPDATE SET
         type = EXCLUDED.type,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        node.id,
        agentId,
        node.type,
        node.name,
        node.description ?? null,
        JSON.stringify(node.metadata ?? {}),
      ]
    );
  }

  async deleteNode(agentId: AgentAddress, nodeId: string): Promise<void> {
    const pool = await this.getPool();
    // Delete edges first
    await pool.query(
      "DELETE FROM graph_edges WHERE source_id = $1 OR target_id = $1",
      [nodeId]
    );
    await pool.query(
      "DELETE FROM graph_nodes WHERE id = $1 AND agent_id = $2",
      [nodeId, agentId]
    );
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO graph_edges (source_id, target_id, type, weight)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_id, target_id, type) DO UPDATE SET
         weight = EXCLUDED.weight`,
      [edge.sourceId, edge.targetId, edge.type, edge.weight]
    );
  }

  async deleteEdge(
    sourceId: string,
    targetId: string,
    type: string
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      "DELETE FROM graph_edges WHERE source_id = $1 AND target_id = $2 AND type = $3",
      [sourceId, targetId, type]
    );
  }

  async queryGraph(
    agentId: AgentAddress,
    query: string,
    opts?: { limit?: number; depth?: number }
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const pool = await this.getPool();
    const pattern = `%${query}%`;
    const maxDepth = Math.min(Math.max(1, opts?.depth ?? 2), 5);
    const nodeLimit = Math.min(Math.max(1, opts?.limit ?? 30), 200);

    // Step 1: Seed nodes matching query
    const seedRes = await pool.query<{ id: string }>(
      `SELECT id FROM graph_nodes
       WHERE agent_id = $1 AND (name ILIKE $2 OR description ILIKE $2)`,
      [agentId, pattern]
    );

    if (seedRes.rows.length === 0) {
      return { nodes: [], edges: [] };
    }

    const seedIds = seedRes.rows.map((r) => r.id);

    // Step 2: N-hop traversal via recursive CTE
    const traversalRes = await pool.query<{ node_id: string }>(
      `WITH RECURSIVE hops(node_id, depth) AS (
         SELECT id, 0 FROM graph_nodes
         WHERE id = ANY($1::text[]) AND agent_id = $2
         UNION
         SELECT CASE
           WHEN e.source_id = h.node_id THEN e.target_id
           ELSE e.source_id
         END, h.depth + 1
         FROM hops h
         JOIN graph_edges e ON (e.source_id = h.node_id OR e.target_id = h.node_id)
         WHERE h.depth < $3
       )
       SELECT DISTINCT node_id FROM hops
       LIMIT $4`,
      [seedIds, agentId, maxDepth, nodeLimit]
    );

    const allIds = traversalRes.rows.map((r) => r.node_id);
    if (allIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Step 3: Fetch full nodes
    const nodeRes = await pool.query<{
      id: string;
      type: string;
      name: string;
      description: string | null;
      metadata: Record<string, unknown>;
      updated_at: Date;
    }>(
      `SELECT id, type, name, description, metadata, updated_at
       FROM graph_nodes
       WHERE id = ANY($1::text[]) AND agent_id = $2`,
      [allIds, agentId]
    );

    const nodes: GraphNode[] = nodeRes.rows.map((r) => ({
      id: r.id,
      type: r.type as GraphNode["type"],
      name: r.name,
      description: r.description ?? undefined,
      metadata: r.metadata,
      updatedAt: toMs(r.updated_at),
    }));

    // Step 4: Fetch edges between returned nodes
    const edgeRes = await pool.query<{
      source_id: string;
      target_id: string;
      type: string;
      weight: number;
    }>(
      `SELECT source_id, target_id, type, weight
       FROM graph_edges
       WHERE source_id = ANY($1::text[]) AND target_id = ANY($1::text[])`,
      [allIds]
    );

    const edges: GraphEdge[] = edgeRes.rows.map((r) => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      type: r.type,
      weight: r.weight,
    }));

    return { nodes, edges };
  }

  // ---------- Codebase Index ----------

  async upsertIndex(
    agentId: AgentAddress,
    entry: Omit<CodebaseIndexEntry, "updatedAt">
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO codebase_index
         (key, agent_id, category, summary, metadata,
          parent_key, content_hash, indexed_by, stale, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, FALSE, NOW())
       ON CONFLICT (key, agent_id) DO UPDATE SET
         category     = EXCLUDED.category,
         summary      = EXCLUDED.summary,
         metadata     = EXCLUDED.metadata,
         parent_key   = EXCLUDED.parent_key,
         content_hash = EXCLUDED.content_hash,
         indexed_by   = EXCLUDED.indexed_by,
         stale        = FALSE,
         updated_at   = NOW()`,
      [
        entry.key,
        agentId,
        entry.category,
        entry.summary,
        JSON.stringify(entry.metadata ?? {}),
        entry.parentKey ?? null,
        entry.contentHash ?? null,
        entry.indexedBy ?? null,
      ]
    );
  }

  private rowToIndexEntry(r: {
    key: string;
    category: string;
    summary: string;
    metadata: Record<string, unknown>;
    parent_key?: string | null;
    content_hash?: string | null;
    indexed_by?: string | null;
    stale?: boolean;
    updated_at: Date;
  }): CodebaseIndexEntry {
    const entry: CodebaseIndexEntry = {
      key: r.key,
      category: r.category as CodebaseIndexEntry["category"],
      summary: r.summary,
      metadata: r.metadata,
      updatedAt: toMs(r.updated_at),
    };
    if (r.parent_key) entry.parentKey = r.parent_key;
    if (r.content_hash) entry.contentHash = r.content_hash;
    if (r.indexed_by) entry.indexedBy = r.indexed_by;
    if (r.stale) entry.stale = r.stale;
    return entry;
  }

  async getIndex(
    agentId: AgentAddress,
    key: string
  ): Promise<CodebaseIndexEntry | null> {
    const pool = await this.getPool();
    const res = await pool.query<{
      key: string;
      category: string;
      summary: string;
      metadata: Record<string, unknown>;
      parent_key: string | null;
      content_hash: string | null;
      indexed_by: string | null;
      stale: boolean;
      updated_at: Date;
    }>(
      `SELECT key, category, summary, metadata,
              parent_key, content_hash, indexed_by, stale, updated_at
       FROM codebase_index WHERE key = $1 AND agent_id = $2`,
      [key, agentId]
    );
    if (res.rows.length === 0) return null;
    return this.rowToIndexEntry(res.rows[0]);
  }

  async searchIndex(
    agentId: AgentAddress,
    query: string,
    category?: string,
    opts?: { limit?: number }
  ): Promise<CodebaseIndexEntry[]> {
    const pool = await this.getPool();
    const resultLimit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
    const pattern = `%${query}%`;
    const params: unknown[] = [agentId, pattern];
    let sql = `SELECT key, category, summary, metadata,
                      parent_key, content_hash, indexed_by, stale, updated_at
               FROM codebase_index
               WHERE agent_id = $1 AND (key ILIKE $2 OR summary ILIKE $2)`;
    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }
    params.push(resultLimit);
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`;

    const res = await pool.query<{
      key: string;
      category: string;
      summary: string;
      metadata: Record<string, unknown>;
      parent_key: string | null;
      content_hash: string | null;
      indexed_by: string | null;
      stale: boolean;
      updated_at: Date;
    }>(sql, params);

    return res.rows.map((r) => this.rowToIndexEntry(r));
  }

  async deleteIndex(agentId: AgentAddress, key: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      "DELETE FROM codebase_index WHERE key = $1 AND agent_id = $2",
      [key, agentId]
    );
  }

  async checkStaleness(
    agentId: AgentAddress,
    entries: Array<{ key: string; currentHash: string }>
  ): Promise<StalenessResult> {
    if (entries.length === 0) return { fresh: [], stale: [], missing: [] };
    const pool = await this.getPool();
    const keys = entries.map((e) => e.key);
    const hashMap = new Map(entries.map((e) => [e.key, e.currentHash]));

    const res = await pool.query<{ key: string; content_hash: string | null }>(
      `SELECT key, content_hash FROM codebase_index
       WHERE agent_id = $1 AND key = ANY($2::text[])`,
      [agentId, keys]
    );

    const found = new Map(res.rows.map((r) => [r.key, r.content_hash]));
    const fresh: string[] = [];
    const stale: string[] = [];
    const missing: string[] = [];
    const staleKeys: string[] = [];

    for (const { key, currentHash } of entries) {
      if (!found.has(key)) {
        missing.push(key);
      } else if (found.get(key) === currentHash) {
        fresh.push(key);
      } else {
        stale.push(key);
        staleKeys.push(key);
      }
    }

    if (staleKeys.length > 0) {
      await pool.query(
        `UPDATE codebase_index SET stale = TRUE
         WHERE agent_id = $1 AND key = ANY($2::text[])`,
        [agentId, staleKeys]
      );
    }

    return { fresh, stale, missing };
  }

  async rollupModule(
    agentId: AgentAddress,
    moduleKey: string,
    fileKeys: string[]
  ): Promise<void> {
    if (fileKeys.length === 0) return;
    const pool = await this.getPool();

    const res = await pool.query<{ key: string; summary: string }>(
      `SELECT key, summary FROM codebase_index
       WHERE agent_id = $1 AND key = ANY($2::text[])`,
      [agentId, fileKeys]
    );

    // Preserve the order of fileKeys in the rollup
    const summaryMap = new Map(res.rows.map((r) => [r.key, r.summary]));
    const combined = fileKeys
      .filter((k) => summaryMap.has(k))
      .map((k) => `[${k}] ${summaryMap.get(k)!}`)
      .join("\n");

    await pool.query(
      `INSERT INTO codebase_index
         (key, agent_id, category, summary, metadata,
          parent_key, content_hash, indexed_by, stale, updated_at)
       VALUES ($1, $2, 'module', $3, '{}'::jsonb, NULL, NULL, NULL, FALSE, NOW())
       ON CONFLICT (key, agent_id) DO UPDATE SET
         summary    = EXCLUDED.summary,
         stale      = FALSE,
         updated_at = NOW()`,
      [moduleKey, agentId, combined]
    );

    // Back-fill parentKey on each file entry
    await pool.query(
      `UPDATE codebase_index SET parent_key = $1, updated_at = NOW()
       WHERE agent_id = $2 AND key = ANY($3::text[])`,
      [moduleKey, agentId, fileKeys]
    );
  }

  // ---------- Git / Version Control ----------

  private async captureSnapshot(agentId: AgentAddress): Promise<CommitSnapshot> {
    const pool = await this.getPool();
    const nodeRes = await pool.query<{
      id: string; type: string; name: string;
      description: string | null; metadata: Record<string, unknown>;
    }>(
      `SELECT id, type, name, description, metadata FROM graph_nodes WHERE agent_id = $1`,
      [agentId]
    );
    const nodeIds = nodeRes.rows.map((r) => r.id);
    let edgeRows: Array<{ source_id: string; target_id: string; type: string; weight: number }> = [];
    if (nodeIds.length > 0) {
      const edgeRes = await pool.query<{
        source_id: string; target_id: string; type: string; weight: number;
      }>(
        `SELECT source_id, target_id, type, weight FROM graph_edges
         WHERE source_id = ANY($1::text[]) AND target_id = ANY($1::text[])`,
        [nodeIds]
      );
      edgeRows = edgeRes.rows;
    }
    const indexRes = await pool.query<{
      key: string; category: string; summary: string;
      metadata: Record<string, unknown>; parent_key: string | null; content_hash: string | null;
    }>(
      `SELECT key, category, summary, metadata, parent_key, content_hash
       FROM codebase_index WHERE agent_id = $1`,
      [agentId]
    );
    return {
      nodes: nodeRes.rows.map((r) => ({
        id: r.id,
        type: r.type as GraphNode["type"],
        name: r.name,
        description: r.description ?? undefined,
        metadata: r.metadata,
      })),
      edges: edgeRows.map((r) => ({
        sourceId: r.source_id,
        targetId: r.target_id,
        type: r.type,
        weight: r.weight,
      })),
      indexEntries: indexRes.rows.map((r) => {
        const entry: CommitSnapshot["indexEntries"][0] = {
          key: r.key,
          category: r.category as CodebaseIndexEntry["category"],
          summary: r.summary,
          metadata: r.metadata,
        };
        if (r.parent_key) entry.parentKey = r.parent_key;
        if (r.content_hash) entry.contentHash = r.content_hash;
        return entry;
      }),
    };
  }

  async createCommit(
    agentId: AgentAddress,
    message: string,
    opts?: { branch?: string; keepLast?: number }
  ): Promise<AgentCommit> {
    const pool = await this.getPool();
    const id = uuidv4();
    const branch = opts?.branch ?? "main";
    const snapshot = await this.captureSnapshot(agentId);

    if (snapshot.nodes.length > MAX_COMMIT_NODES) {
      throw Object.assign(
        new Error(`snapshot too large: ${snapshot.nodes.length} nodes exceeds limit of ${MAX_COMMIT_NODES}`),
        { status: 413 }
      );
    }
    if (snapshot.indexEntries.length > MAX_COMMIT_INDEX_ENTRIES) {
      throw Object.assign(
        new Error(`snapshot too large: ${snapshot.indexEntries.length} index entries exceeds limit of ${MAX_COMMIT_INDEX_ENTRIES}`),
        { status: 413 }
      );
    }

    const hashInput = JSON.stringify({
      nodes: snapshot.nodes.map((n) => n.id).sort(),
      index: snapshot.indexEntries.map((e) => e.key).sort(),
    });
    const snapshotHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);

    const parentRes = await pool.query<{ id: string }>(
      `SELECT id FROM agent_commits WHERE agent_id = $1 AND branch = $2
       ORDER BY created_at DESC LIMIT 1`,
      [agentId, branch]
    );
    const parentId = parentRes.rows[0]?.id ?? null;

    const res = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO agent_commits
         (id, agent_id, parent_id, branch, message, snapshot, snapshot_hash,
          node_count, index_count)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING id, created_at`,
      [
        id, agentId, parentId, branch, message,
        JSON.stringify(snapshot), snapshotHash,
        snapshot.nodes.length, snapshot.indexEntries.length,
      ]
    );

    if (opts?.keepLast && opts.keepLast > 0) {
      const cutoff = await pool.query<{ created_at: Date }>(
        `SELECT created_at FROM agent_commits
         WHERE agent_id = $1 AND branch = $2
         ORDER BY created_at DESC
         LIMIT 1 OFFSET $3`,
        [agentId, branch, opts.keepLast - 1]
      );
      if (cutoff.rows.length > 0) {
        await pool.query(
          `DELETE FROM agent_commits
           WHERE agent_id = $1 AND branch = $2 AND created_at < $3`,
          [agentId, branch, cutoff.rows[0].created_at]
        );
      }
    }

    return {
      id, agentId, parentId, branch, message, snapshotHash,
      nodeCount: snapshot.nodes.length,
      indexCount: snapshot.indexEntries.length,
      createdAt: toMs(res.rows[0].created_at),
    };
  }

  async deleteCommit(agentId: AgentAddress, commitId: string): Promise<boolean> {
    const pool = await this.getPool();
    const res = await pool.query(
      "DELETE FROM agent_commits WHERE id = $1 AND agent_id = $2",
      [commitId, agentId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listCommits(
    agentId: AgentAddress,
    opts?: { branch?: string; limit?: number }
  ): Promise<AgentCommit[]> {
    const pool = await this.getPool();
    const limit = Math.min(opts?.limit ?? 20, 100);
    const params: unknown[] = [agentId];
    let sql = `SELECT id, agent_id, parent_id, branch, message, snapshot_hash,
                      node_count, index_count, created_at
               FROM agent_commits WHERE agent_id = $1`;
    if (opts?.branch) {
      params.push(opts.branch);
      sql += ` AND branch = $${params.length}`;
    }
    params.push(limit);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const res = await pool.query<{
      id: string; agent_id: string; parent_id: string | null; branch: string;
      message: string; snapshot_hash: string; node_count: number;
      index_count: number; created_at: Date;
    }>(sql, params);

    return res.rows.map((r) => ({
      id: r.id, agentId: r.agent_id, parentId: r.parent_id, branch: r.branch,
      message: r.message, snapshotHash: r.snapshot_hash,
      nodeCount: r.node_count, indexCount: r.index_count,
      createdAt: toMs(r.created_at),
    }));
  }

  async getCommit(
    agentId: AgentAddress,
    commitId: string
  ): Promise<(AgentCommit & { snapshot: CommitSnapshot }) | null> {
    const pool = await this.getPool();
    const res = await pool.query<{
      id: string; agent_id: string; parent_id: string | null; branch: string;
      message: string; snapshot: CommitSnapshot; snapshot_hash: string;
      node_count: number; index_count: number; created_at: Date;
    }>(
      `SELECT id, agent_id, parent_id, branch, message, snapshot, snapshot_hash,
              node_count, index_count, created_at
       FROM agent_commits WHERE id = $1 AND agent_id = $2`,
      [commitId, agentId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id, agentId: r.agent_id, parentId: r.parent_id, branch: r.branch,
      message: r.message, snapshotHash: r.snapshot_hash,
      nodeCount: r.node_count, indexCount: r.index_count,
      createdAt: toMs(r.created_at),
      snapshot: r.snapshot,
    };
  }

  async restoreCommit(agentId: AgentAddress, commitId: string): Promise<void> {
    const pool = await this.getPool();
    const res = await pool.query<{ snapshot: CommitSnapshot }>(
      `SELECT snapshot FROM agent_commits WHERE id = $1 AND agent_id = $2`,
      [commitId, agentId]
    );
    if (res.rows.length === 0) throw new Error(`commit ${commitId} not found`);
    const snapshot = res.rows[0].snapshot;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Delete existing graph edges whose endpoints belong to this agent
      const nodeIdsRes = await client.query<{ id: string }>(
        `SELECT id FROM graph_nodes WHERE agent_id = $1`,
        [agentId]
      );
      const existingIds = nodeIdsRes.rows.map((r) => r.id);
      if (existingIds.length > 0) {
        await client.query(
          `DELETE FROM graph_edges
           WHERE source_id = ANY($1::text[]) OR target_id = ANY($1::text[])`,
          [existingIds]
        );
      }
      await client.query(`DELETE FROM graph_nodes WHERE agent_id = $1`, [agentId]);
      await client.query(`DELETE FROM codebase_index WHERE agent_id = $1`, [agentId]);

      for (const n of snapshot.nodes) {
        await client.query(
          `INSERT INTO graph_nodes (id, agent_id, type, name, description, metadata, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
           ON CONFLICT (id, agent_id) DO UPDATE SET
             type = EXCLUDED.type, name = EXCLUDED.name,
             description = EXCLUDED.description, metadata = EXCLUDED.metadata,
             updated_at = NOW()`,
          [n.id, agentId, n.type, n.name, n.description ?? null,
            JSON.stringify(n.metadata ?? {})]
        );
      }
      for (const e of snapshot.edges) {
        await client.query(
          `INSERT INTO graph_edges (source_id, target_id, type, weight)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_id, target_id, type) DO UPDATE SET weight = EXCLUDED.weight`,
          [e.sourceId, e.targetId, e.type, e.weight ?? 1.0]
        );
      }
      for (const entry of snapshot.indexEntries) {
        await client.query(
          `INSERT INTO codebase_index
             (key, agent_id, category, summary, metadata,
              parent_key, content_hash, indexed_by, stale, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NULL, FALSE, NOW())
           ON CONFLICT (key, agent_id) DO UPDATE SET
             category = EXCLUDED.category, summary = EXCLUDED.summary,
             metadata = EXCLUDED.metadata, parent_key = EXCLUDED.parent_key,
             content_hash = EXCLUDED.content_hash, stale = FALSE, updated_at = NOW()`,
          [
            entry.key, agentId, entry.category, entry.summary,
            JSON.stringify(entry.metadata ?? {}),
            entry.parentKey ?? null, entry.contentHash ?? null,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async diffCommits(
    agentId: AgentAddress,
    fromId: string,
    toId: string | null
  ): Promise<CommitDiff> {
    const pool = await this.getPool();
    const fromRes = await pool.query<{ snapshot: CommitSnapshot }>(
      `SELECT snapshot FROM agent_commits WHERE id = $1 AND agent_id = $2`,
      [fromId, agentId]
    );
    if (fromRes.rows.length === 0) throw new Error(`commit ${fromId} not found`);
    const fromSnap = fromRes.rows[0].snapshot;

    let toSnap: CommitSnapshot;
    if (toId) {
      const toRes = await pool.query<{ snapshot: CommitSnapshot }>(
        `SELECT snapshot FROM agent_commits WHERE id = $1 AND agent_id = $2`,
        [toId, agentId]
      );
      if (toRes.rows.length === 0) throw new Error(`commit ${toId} not found`);
      toSnap = toRes.rows[0].snapshot;
    } else {
      toSnap = await this.captureSnapshot(agentId);
    }

    return pgComputeCommitDiff(fromSnap, toSnap);
  }

  async mergeCommits(
    agentId: AgentAddress,
    fromBranch: string,
    toBranch: string,
    opts?: { strategy?: "union" | "ours" | "theirs"; message?: string }
  ): Promise<AgentCommit> {
    const pool = await this.getPool();
    const strategy = opts?.strategy ?? "union";

    const [fromRes, toRes] = await Promise.all([
      pool.query<{ snapshot: CommitSnapshot }>(
        `SELECT snapshot FROM agent_commits WHERE agent_id = $1 AND branch = $2
         ORDER BY created_at DESC LIMIT 1`,
        [agentId, fromBranch]
      ),
      pool.query<{ snapshot: CommitSnapshot }>(
        `SELECT snapshot FROM agent_commits WHERE agent_id = $1 AND branch = $2
         ORDER BY created_at DESC LIMIT 1`,
        [agentId, toBranch]
      ),
    ]);
    if (fromRes.rows.length === 0) throw new Error(`branch '${fromBranch}' has no commits`);
    if (toRes.rows.length === 0) throw new Error(`branch '${toBranch}' has no commits`);

    const merged = pgMergeSnapshots(toRes.rows[0].snapshot, fromRes.rows[0].snapshot, strategy);

    // Apply merged state, then commit it
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const nodeIdsRes = await client.query<{ id: string }>(`SELECT id FROM graph_nodes WHERE agent_id = $1`, [agentId]);
      const existingIds = nodeIdsRes.rows.map((r) => r.id);
      if (existingIds.length > 0) {
        await client.query(`DELETE FROM graph_edges WHERE source_id = ANY($1::text[]) OR target_id = ANY($1::text[])`, [existingIds]);
      }
      await client.query(`DELETE FROM graph_nodes WHERE agent_id = $1`, [agentId]);
      await client.query(`DELETE FROM codebase_index WHERE agent_id = $1`, [agentId]);
      for (const n of merged.nodes) {
        await client.query(
          `INSERT INTO graph_nodes (id, agent_id, type, name, description, metadata, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
           ON CONFLICT (id, agent_id) DO UPDATE SET type=EXCLUDED.type, name=EXCLUDED.name, description=EXCLUDED.description, metadata=EXCLUDED.metadata, updated_at=NOW()`,
          [n.id, agentId, n.type, n.name, n.description ?? null, JSON.stringify(n.metadata ?? {})]
        );
      }
      for (const e of merged.edges) {
        await client.query(
          `INSERT INTO graph_edges (source_id, target_id, type, weight) VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_id, target_id, type) DO UPDATE SET weight=EXCLUDED.weight`,
          [e.sourceId, e.targetId, e.type, e.weight ?? 1.0]
        );
      }
      for (const entry of merged.indexEntries) {
        await client.query(
          `INSERT INTO codebase_index (key, agent_id, category, summary, metadata, parent_key, content_hash, indexed_by, stale, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NULL, FALSE, NOW())
           ON CONFLICT (key, agent_id) DO UPDATE SET category=EXCLUDED.category, summary=EXCLUDED.summary, metadata=EXCLUDED.metadata, parent_key=EXCLUDED.parent_key, content_hash=EXCLUDED.content_hash, stale=FALSE, updated_at=NOW()`,
          [entry.key, agentId, entry.category, entry.summary, JSON.stringify(entry.metadata ?? {}), entry.parentKey ?? null, entry.contentHash ?? null]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }

    const mergeMsg = opts?.message ?? `Merge '${fromBranch}' into '${toBranch}' (${strategy})`;
    return this.createCommit(agentId, mergeMsg, { branch: toBranch });
  }
}

function pgMergeSnapshots(
  ours: CommitSnapshot,
  theirs: CommitSnapshot,
  strategy: "union" | "ours" | "theirs"
): CommitSnapshot {
  if (strategy === "ours") return ours;
  if (strategy === "theirs") return theirs;

  const nodeMap = new Map<string, CommitSnapshot["nodes"][0]>();
  for (const n of ours.nodes) nodeMap.set(n.id, n);
  for (const n of theirs.nodes) {
    if (!nodeMap.has(n.id)) {
      nodeMap.set(n.id, n);
    } else {
      const cur = nodeMap.get(n.id)!;
      if (JSON.stringify(n) > JSON.stringify(cur)) nodeMap.set(n.id, n);
    }
  }

  const edgeKey = (e: GraphEdge) => `${e.sourceId}|${e.targetId}|${e.type}`;
  const edgeMap = new Map<string, GraphEdge>();
  for (const e of [...ours.edges, ...theirs.edges]) edgeMap.set(edgeKey(e), e);
  const validNodeIds = new Set(nodeMap.keys());
  const edges = [...edgeMap.values()].filter(
    (e) => validNodeIds.has(e.sourceId) && validNodeIds.has(e.targetId)
  );

  const indexMap = new Map<string, CommitSnapshot["indexEntries"][0]>();
  for (const e of ours.indexEntries) indexMap.set(e.key, e);
  for (const e of theirs.indexEntries) {
    if (!indexMap.has(e.key)) {
      indexMap.set(e.key, e);
    } else {
      const cur = indexMap.get(e.key)!;
      if (JSON.stringify(e) > JSON.stringify(cur)) indexMap.set(e.key, e);
    }
  }

  return { nodes: [...nodeMap.values()], edges, indexEntries: [...indexMap.values()] };
}

function pgComputeCommitDiff(from: CommitSnapshot, to: CommitSnapshot): CommitDiff {
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]));
  const fromIndex = new Map(from.indexEntries.map((e) => [e.key, e]));
  const toIndex = new Map(to.indexEntries.map((e) => [e.key, e]));

  const nodesAdded = [...toNodes.keys()].filter((k) => !fromNodes.has(k));
  const nodesRemoved = [...fromNodes.keys()].filter((k) => !toNodes.has(k));
  const nodesModified = [...fromNodes.keys()].filter((k) => {
    const a = fromNodes.get(k)!;
    const b = toNodes.get(k);
    if (!b) return false;
    return (
      a.name !== b.name ||
      a.description !== b.description ||
      JSON.stringify(a.metadata) !== JSON.stringify(b.metadata)
    );
  });

  const indexAdded = [...toIndex.keys()].filter((k) => !fromIndex.has(k));
  const indexRemoved = [...fromIndex.keys()].filter((k) => !toIndex.has(k));
  const indexModified = [...fromIndex.keys()].filter((k) => {
    const a = fromIndex.get(k)!;
    const b = toIndex.get(k);
    if (!b) return false;
    return (
      a.summary !== b.summary ||
      JSON.stringify(a.metadata) !== JSON.stringify(b.metadata)
    );
  });

  return { nodesAdded, nodesRemoved, nodesModified, indexAdded, indexRemoved, indexModified };
}

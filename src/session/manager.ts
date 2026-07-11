/**
 * Session Manager — manages agent session lifecycle.
 *
 * Inspired by Cognee's SessionManager and session_lifecycle module.
 * Handles:
 *   - Session CRUD with auto-expiry (TTL)
 *   - Session records (metadata tracking)
 *   - Auto-cleanup of expired sessions
 */

import type { SessionEntry, SessionRecord } from "./models";

export interface SessionManagerConfig {
  /** Default TTL for session entries (ms). Default: 30 min */
  defaultTtlMs?: number;
  /** Max entries per session. Default: 500 */
  maxEntriesPerSession?: number;
  /** Cleanup interval (ms). Default: 5 min */
  cleanupIntervalMs?: number;
}

export class SessionManager {
  private entries = new Map<string, SessionEntry[]>();
  private records = new Map<string, SessionRecord>();
  private config: Required<SessionManagerConfig>;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config?: SessionManagerConfig) {
    this.config = {
      defaultTtlMs: config?.defaultTtlMs ?? 30 * 60 * 1000,
      maxEntriesPerSession: config?.maxEntriesPerSession ?? 500,
      cleanupIntervalMs: config?.cleanupIntervalMs ?? 5 * 60 * 1000,
    };

    // Auto-cleanup expired sessions
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
    // Don't block process exit
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  // ── Session Entry CRUD ─────────────────────────────────

  set(
    sessionId: string,
    agentId: string,
    key: string,
    value: unknown,
    opts?: { ttlMs?: number; source?: "agent" | "system" | "pipeline" }
  ): void {
    this.ensureRecord(sessionId, agentId);
    const session = this.getOrCreateEntries(sessionId);

    const entry: SessionEntry = {
      key,
      value,
      timestamp: Date.now(),
      ttlMs: opts?.ttlMs ?? this.config.defaultTtlMs,
      source: opts?.source ?? "agent",
    };

    // Upsert
    const idx = session.findIndex(e => e.key === key);
    if (idx >= 0) {
      session[idx] = entry;
    } else {
      // Enforce max entries
      if (session.length >= this.config.maxEntriesPerSession) {
        session.shift(); // evict oldest
      }
      session.push(entry);
    }

    this.touchRecord(sessionId);
  }

  get(sessionId: string, key: string): unknown | null {
    const session = this.entries.get(sessionId);
    if (!session) return null;

    const entry = session.find(e => e.key === key);
    if (!entry) return null;

    // Check expiry
    if (Date.now() > entry.timestamp + entry.ttlMs) {
      session.splice(session.indexOf(entry), 1);
      return null;
    }

    this.touchRecord(sessionId);
    return entry.value;
  }

  getAll(sessionId: string): Record<string, unknown> {
    const session = this.entries.get(sessionId);
    if (!session) return {};

    const now = Date.now();
    const result: Record<string, unknown> = {};
    for (const entry of session) {
      if (now <= entry.timestamp + entry.ttlMs) {
        result[entry.key] = entry.value;
      }
    }
    return result;
  }

  delete(sessionId: string, key: string): boolean {
    const session = this.entries.get(sessionId);
    if (!session) return false;

    const idx = session.findIndex(e => e.key === key);
    if (idx >= 0) {
      session.splice(idx, 1);
      return true;
    }
    return false;
  }

  // ── Session Lifecycle ──────────────────────────────────

  clear(sessionId: string): void {
    this.entries.delete(sessionId);
    const record = this.records.get(sessionId);
    if (record) {
      record.status = "expired";
      record.entryCount = 0;
    }
  }

  getRecord(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  listActiveSessions(): SessionRecord[] {
    return [...this.records.values()].filter(r => r.status === "active" || r.status === "idle");
  }

  /** Get session stats for observability */
  getStats(): {
    activeSessions: number;
    totalEntries: number;
    oldestSession: number | null;
  } {
    const active = this.listActiveSessions();
    let totalEntries = 0;
    for (const [, entries] of this.entries) {
      totalEntries += entries.length;
    }
    const oldest = active.length > 0
      ? Math.min(...active.map(r => r.createdAt))
      : null;

    return { activeSessions: active.length, totalEntries, oldestSession: oldest };
  }

  // ── Cleanup ────────────────────────────────────────────

  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.entries) {
      // Remove expired entries
      const before = session.length;
      const valid = session.filter(e => now <= e.timestamp + e.ttlMs);

      if (valid.length === 0) {
        this.entries.delete(sessionId);
        const record = this.records.get(sessionId);
        if (record) record.status = "expired";
        cleaned += before;
      } else if (valid.length < before) {
        this.entries.set(sessionId, valid);
        cleaned += before - valid.length;
      }
    }

    return cleaned;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.entries.clear();
    this.records.clear();
  }

  // ── Internals ──────────────────────────────────────────

  private getOrCreateEntries(sessionId: string): SessionEntry[] {
    if (!this.entries.has(sessionId)) {
      this.entries.set(sessionId, []);
    }
    return this.entries.get(sessionId)!;
  }

  private ensureRecord(sessionId: string, agentId: string) {
    if (!this.records.has(sessionId)) {
      this.records.set(sessionId, {
        sessionId,
        agentId,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        entryCount: 0,
        status: "active",
      });
    }
  }

  private touchRecord(sessionId: string) {
    const record = this.records.get(sessionId);
    if (record) {
      record.lastAccessedAt = Date.now();
      record.entryCount = this.entries.get(sessionId)?.length ?? 0;
      record.status = "active";
    }
  }
}

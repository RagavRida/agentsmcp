/**
 * Unit tests for SessionManager — TTL, cleanup, lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionManager } from "../../src/session/manager";

describe("SessionManager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager({ defaultTtlMs: 100, cleanupIntervalMs: 60000 });
  });

  afterEach(() => {
    sm.destroy();
  });

  it("set and get", () => {
    sm.set("s1", "agent-a", "key1", "value1");
    expect(sm.get("s1", "key1")).toBe("value1");
  });

  it("returns null for missing session", () => {
    expect(sm.get("nonexistent", "key")).toBeNull();
  });

  it("returns null for missing key", () => {
    sm.set("s1", "agent-a", "key1", "value1");
    expect(sm.get("s1", "missing")).toBeNull();
  });

  it("getAll returns all entries", () => {
    sm.set("s1", "agent-a", "k1", "v1");
    sm.set("s1", "agent-a", "k2", "v2");
    expect(sm.getAll("s1")).toEqual({ k1: "v1", k2: "v2" });
  });

  it("getAll returns empty for missing session", () => {
    expect(sm.getAll("ghost")).toEqual({});
  });

  it("upserts existing key", () => {
    sm.set("s1", "agent-a", "k1", "old");
    sm.set("s1", "agent-a", "k1", "new");
    expect(sm.get("s1", "k1")).toBe("new");
  });

  it("delete removes a key", () => {
    sm.set("s1", "agent-a", "k1", "v1");
    expect(sm.delete("s1", "k1")).toBe(true);
    expect(sm.get("s1", "k1")).toBeNull();
  });

  it("delete returns false for missing key", () => {
    expect(sm.delete("s1", "ghost")).toBe(false);
  });

  it("clear removes all entries for a session", () => {
    sm.set("s1", "agent-a", "k1", "v1");
    sm.set("s1", "agent-a", "k2", "v2");
    sm.clear("s1");
    expect(sm.getAll("s1")).toEqual({});
  });

  // ── TTL Expiry ──────────────────────────────────

  it("entries expire after TTL", async () => {
    sm.set("s1", "agent-a", "k1", "v1", { ttlMs: 50 });
    expect(sm.get("s1", "k1")).toBe("v1");

    // Wait for expiry
    await new Promise(r => setTimeout(r, 60));
    expect(sm.get("s1", "k1")).toBeNull();
  });

  it("custom TTL per entry", async () => {
    sm.set("s1", "agent-a", "short", "val", { ttlMs: 30 });
    sm.set("s1", "agent-a", "long", "val", { ttlMs: 500 });

    await new Promise(r => setTimeout(r, 50));
    expect(sm.get("s1", "short")).toBeNull();
    expect(sm.get("s1", "long")).toBe("val");
  });

  // ── Session Records ─────────────────────────────

  it("tracks session records", () => {
    sm.set("s1", "agent-a", "k1", "v1");
    const record = sm.getRecord("s1");
    expect(record).toBeDefined();
    expect(record!.agentId).toBe("agent-a");
    expect(record!.status).toBe("active");
    expect(record!.entryCount).toBe(1);
  });

  it("listActiveSessions", () => {
    sm.set("s1", "agent-a", "k1", "v1");
    sm.set("s2", "agent-b", "k1", "v1");
    const active = sm.listActiveSessions();
    expect(active).toHaveLength(2);
  });

  // ── Cleanup ─────────────────────────────────────

  it("cleanup removes expired entries", async () => {
    sm.set("s1", "agent-a", "k1", "v1", { ttlMs: 30 });
    sm.set("s1", "agent-a", "k2", "v2", { ttlMs: 30 });

    await new Promise(r => setTimeout(r, 50));
    const cleaned = sm.cleanup();
    expect(cleaned).toBe(2);
  });

  // ── Max entries eviction ────────────────────────

  it("evicts oldest when maxEntriesPerSession exceeded", () => {
    const limited = new SessionManager({ maxEntriesPerSession: 3, cleanupIntervalMs: 60000 });

    limited.set("s1", "a", "k1", "first");
    limited.set("s1", "a", "k2", "second");
    limited.set("s1", "a", "k3", "third");
    limited.set("s1", "a", "k4", "fourth"); // should evict k1

    expect(limited.get("s1", "k1")).toBeNull();
    expect(limited.get("s1", "k4")).toBe("fourth");

    limited.destroy();
  });

  // ── Stats ───────────────────────────────────────

  it("getStats returns correct counts", () => {
    sm.set("s1", "a", "k1", "v1");
    sm.set("s2", "b", "k1", "v1");
    sm.set("s2", "b", "k2", "v2");

    const stats = sm.getStats();
    expect(stats.activeSessions).toBe(2);
    expect(stats.totalEntries).toBe(3);
    expect(stats.oldestSession).toBeDefined();
  });
});

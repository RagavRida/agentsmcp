import { describe, it, expect, beforeEach } from "vitest";
import { SqliteStorage } from "../src/storage/sqlite";

const AGENT = "test-agent@index-hierarchy";

function makeStorage() {
  const s = new SqliteStorage(":memory:");
  return s;
}

describe("index-hierarchy: staleness detection", () => {
  let s: SqliteStorage;

  beforeEach(async () => {
    s = makeStorage();
    await s.init();
    await s.registerAgent(AGENT);

    // Seed 3 file entries with distinct content hashes
    await s.upsertIndex(AGENT, {
      key: "file:src/auth/middleware.ts",
      category: "file",
      summary: "JWT validation middleware. Exports requireAuth().",
      contentHash: "hash-aaa",
      indexedBy: AGENT,
    });
    await s.upsertIndex(AGENT, {
      key: "file:src/auth/keys.ts",
      category: "file",
      summary: "Key rotation logic. Rotates every 6 hours.",
      contentHash: "hash-bbb",
      indexedBy: AGENT,
    });
    await s.upsertIndex(AGENT, {
      key: "file:src/auth/types.ts",
      category: "file",
      summary: "Shared auth types: AuthOptions, AuthTransport.",
      contentHash: "hash-ccc",
      indexedBy: AGENT,
    });
  });

  it("returns all three as fresh when hashes match", async () => {
    const result = await s.checkStaleness(AGENT, [
      { key: "file:src/auth/middleware.ts", currentHash: "hash-aaa" },
      { key: "file:src/auth/keys.ts",       currentHash: "hash-bbb" },
      { key: "file:src/auth/types.ts",      currentHash: "hash-ccc" },
    ]);

    expect(result.fresh).toHaveLength(3);
    expect(result.stale).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
    expect(result.fresh).toContain("file:src/auth/middleware.ts");
    expect(result.fresh).toContain("file:src/auth/keys.ts");
    expect(result.fresh).toContain("file:src/auth/types.ts");
  });

  it("returns 1 stale + 2 fresh when one hash differs", async () => {
    const result = await s.checkStaleness(AGENT, [
      { key: "file:src/auth/middleware.ts", currentHash: "hash-CHANGED" }, // stale
      { key: "file:src/auth/keys.ts",       currentHash: "hash-bbb" },     // fresh
      { key: "file:src/auth/types.ts",      currentHash: "hash-ccc" },     // fresh
    ]);

    expect(result.stale).toHaveLength(1);
    expect(result.stale).toContain("file:src/auth/middleware.ts");
    expect(result.fresh).toHaveLength(2);
    expect(result.missing).toHaveLength(0);
  });

  it("marks the entry as stale=true in getIndex after checkStaleness detects mismatch", async () => {
    await s.checkStaleness(AGENT, [
      { key: "file:src/auth/middleware.ts", currentHash: "hash-CHANGED" },
    ]);

    const entry = await s.getIndex(AGENT, "file:src/auth/middleware.ts");
    expect(entry).not.toBeNull();
    expect(entry!.stale).toBe(true);
  });

  it("clears stale=false when the entry is re-upserted with the new hash", async () => {
    // First mark stale
    await s.checkStaleness(AGENT, [
      { key: "file:src/auth/middleware.ts", currentHash: "hash-CHANGED" },
    ]);

    // Re-index with the new hash
    await s.upsertIndex(AGENT, {
      key: "file:src/auth/middleware.ts",
      category: "file",
      summary: "Updated summary.",
      contentHash: "hash-CHANGED",
    });

    const entry = await s.getIndex(AGENT, "file:src/auth/middleware.ts");
    expect(entry!.stale).toBeFalsy();
    expect(entry!.contentHash).toBe("hash-CHANGED");
  });

  it("returns missing keys correctly", async () => {
    const result = await s.checkStaleness(AGENT, [
      { key: "file:src/auth/middleware.ts", currentHash: "hash-aaa" },   // fresh
      { key: "file:src/DOES_NOT_EXIST.ts", currentHash: "hash-xyz" },    // missing
    ]);

    expect(result.fresh).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
    expect(result.missing).toContain("file:src/DOES_NOT_EXIST.ts");
    expect(result.stale).toHaveLength(0);
  });

  it("handles empty entries array", async () => {
    // Postgres short-circuits, SQLite loops — both should return empty buckets
    const result = await s.checkStaleness(AGENT, []);
    expect(result.fresh).toHaveLength(0);
    expect(result.stale).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });
});

describe("index-hierarchy: module rollup", () => {
  let s: SqliteStorage;

  beforeEach(async () => {
    s = makeStorage();
    await s.init();
    await s.registerAgent(AGENT);

    await s.upsertIndex(AGENT, {
      key: "file:src/auth/middleware.ts",
      category: "file",
      summary: "JWT validation middleware. Exports requireAuth().",
      contentHash: "hash-aaa",
    });
    await s.upsertIndex(AGENT, {
      key: "file:src/auth/keys.ts",
      category: "file",
      summary: "Key rotation logic. Rotates every 6 hours.",
      contentHash: "hash-bbb",
    });
    await s.upsertIndex(AGENT, {
      key: "file:src/auth/types.ts",
      category: "file",
      summary: "Shared auth types: AuthOptions, AuthTransport.",
      contentHash: "hash-ccc",
    });
  });

  it("creates a module entry with concatenated summaries", async () => {
    await s.rollupModule(AGENT, "module:auth", [
      "file:src/auth/middleware.ts",
      "file:src/auth/keys.ts",
      "file:src/auth/types.ts",
    ]);

    const module = await s.getIndex(AGENT, "module:auth");
    expect(module).not.toBeNull();
    expect(module!.category).toBe("module");
    expect(module!.summary).toContain("JWT validation middleware");
    expect(module!.summary).toContain("Key rotation logic");
    expect(module!.summary).toContain("Shared auth types");
    expect(module!.summary).toContain("[file:src/auth/middleware.ts]");
    expect(module!.summary).toContain("[file:src/auth/keys.ts]");
    expect(module!.summary).toContain("[file:src/auth/types.ts]");
  });

  it("sets parentKey on each file entry", async () => {
    await s.rollupModule(AGENT, "module:auth", [
      "file:src/auth/middleware.ts",
      "file:src/auth/keys.ts",
      "file:src/auth/types.ts",
    ]);

    const mw = await s.getIndex(AGENT, "file:src/auth/middleware.ts");
    const keys = await s.getIndex(AGENT, "file:src/auth/keys.ts");
    const types = await s.getIndex(AGENT, "file:src/auth/types.ts");

    expect(mw!.parentKey).toBe("module:auth");
    expect(keys!.parentKey).toBe("module:auth");
    expect(types!.parentKey).toBe("module:auth");
  });

  it("re-rollup updates the module summary without duplicating", async () => {
    await s.rollupModule(AGENT, "module:auth", [
      "file:src/auth/middleware.ts",
      "file:src/auth/keys.ts",
    ]);

    // Add a new file and re-rollup with all three
    await s.upsertIndex(AGENT, {
      key: "file:src/auth/types.ts",
      category: "file",
      summary: "Shared auth types: AuthOptions, AuthTransport.",
    });
    await s.rollupModule(AGENT, "module:auth", [
      "file:src/auth/middleware.ts",
      "file:src/auth/keys.ts",
      "file:src/auth/types.ts",
    ]);

    const module = await s.getIndex(AGENT, "module:auth");
    // Should contain all three (exactly one occurrence each)
    const count = (module!.summary.match(/\[file:src\/auth\/middleware\.ts\]/g) ?? []).length;
    expect(count).toBe(1);
    expect(module!.summary).toContain("Shared auth types");
  });

  it("gracefully skips keys not in the index", async () => {
    await s.rollupModule(AGENT, "module:auth", [
      "file:src/auth/middleware.ts",
      "file:src/auth/DOES_NOT_EXIST.ts",  // not indexed
    ]);

    const module = await s.getIndex(AGENT, "module:auth");
    expect(module).not.toBeNull();
    expect(module!.summary).toContain("JWT validation middleware");
    expect(module!.summary).not.toContain("DOES_NOT_EXIST");
  });
});

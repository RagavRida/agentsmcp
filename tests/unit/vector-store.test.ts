/**
 * Unit tests for VectorStore — upsert, search, delete, programs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VectorStore } from "../../src/vector/store";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_DB = path.join(os.tmpdir(), ".agentsmcp-test-vectors.db");

describe("VectorStore", () => {
  let store: VectorStore;

  beforeEach(() => {
    // Clean up any previous test DB
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    store = new VectorStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("starts empty", () => {
    expect(store.count()).toBe(0);
    expect(store.programs()).toEqual([]);
  });

  it("upsert and count", () => {
    store.upsert({
      id: "LOAN-PROC::CALC-INTEREST",
      program: "LOAN-PROC",
      nodeType: "COMPUTE",
      domain: "Risk",
      description: "Calculate monthly interest",
      embedding: [0.1, 0.2, 0.3, 0.4],
    });

    expect(store.count()).toBe(1);
    expect(store.programs()).toEqual(["LOAN-PROC"]);
  });

  it("upsertMany in batch", () => {
    store.upsertMany([
      { id: "A::1", program: "A", nodeType: "T", domain: "D", description: "one", embedding: [1, 0, 0] },
      { id: "A::2", program: "A", nodeType: "T", domain: "D", description: "two", embedding: [0, 1, 0] },
      { id: "B::1", program: "B", nodeType: "T", domain: "D", description: "three", embedding: [0, 0, 1] },
    ]);

    expect(store.count()).toBe(3);
    expect(store.programs()).toEqual(["A", "B"]);
  });

  it("search returns sorted by cosine similarity", () => {
    store.upsertMany([
      { id: "exact", program: "P", nodeType: "T", domain: "D", description: "exact match", embedding: [1, 0, 0, 0] },
      { id: "close", program: "P", nodeType: "T", domain: "D", description: "close match", embedding: [0.9, 0.1, 0, 0] },
      { id: "far", program: "P", nodeType: "T", domain: "D", description: "far match", embedding: [0, 0, 1, 0] },
    ]);

    const results = store.search([1, 0, 0, 0], { limit: 3 });

    expect(results).toHaveLength(3);
    expect(results[0].id).toBe("exact");
    expect(results[0].score).toBeCloseTo(1.0, 4);
    expect(results[1].id).toBe("close");
    expect(results[2].id).toBe("far");
    expect(results[2].score).toBeCloseTo(0, 1);
  });

  it("search respects limit", () => {
    store.upsertMany([
      { id: "1", program: "P", nodeType: "T", domain: "D", description: "a", embedding: [1, 0] },
      { id: "2", program: "P", nodeType: "T", domain: "D", description: "b", embedding: [0, 1] },
      { id: "3", program: "P", nodeType: "T", domain: "D", description: "c", embedding: [1, 1] },
    ]);

    const results = store.search([1, 0], { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
  });

  it("search filters by program", () => {
    store.upsertMany([
      { id: "A::1", program: "A", nodeType: "T", domain: "D", description: "a", embedding: [1, 0] },
      { id: "B::1", program: "B", nodeType: "T", domain: "D", description: "b", embedding: [1, 0] },
    ]);

    const results = store.search([1, 0], { program: "A" });
    expect(results).toHaveLength(1);
    expect(results[0].program).toBe("A");
  });

  it("search filters by domain", () => {
    store.upsertMany([
      { id: "1", program: "P", nodeType: "T", domain: "Risk", description: "a", embedding: [1, 0] },
      { id: "2", program: "P", nodeType: "T", domain: "Payments", description: "b", embedding: [1, 0] },
    ]);

    const results = store.search([1, 0], { domain: "Risk" });
    expect(results).toHaveLength(1);
    expect(results[0].domain).toBe("Risk");
  });

  it("upsert replaces existing entry", () => {
    store.upsert({ id: "X", program: "P", nodeType: "T", domain: "D", description: "old", embedding: [1, 0] });
    store.upsert({ id: "X", program: "P", nodeType: "T", domain: "D", description: "new", embedding: [0, 1] });

    expect(store.count()).toBe(1);
    const results = store.search([0, 1]);
    expect(results[0].description).toBe("new");
  });

  it("search throws on embedding dimension mismatch instead of silently scoring 0", () => {
    // Regression: a query embedded with a different model (different dim) than
    // the stored vectors must fail loudly rather than return all-zero scores.
    store.upsert({
      id: "X", program: "P", nodeType: "T", domain: "D", description: "a",
      embedding: [1, 0, 0, 0], // 4-dim (e.g. Modal)
    });

    expect(() => store.search([1, 0, 0])).toThrow(/dimension mismatch/i);
  });

  // ── Delete operations ──────────────────────────────

  it("deleteByProgram removes all vectors for a program", () => {
    store.upsertMany([
      { id: "A::1", program: "A", nodeType: "T", domain: "D", description: "a", embedding: [1, 0] },
      { id: "A::2", program: "A", nodeType: "T", domain: "D", description: "b", embedding: [0, 1] },
      { id: "B::1", program: "B", nodeType: "T", domain: "D", description: "c", embedding: [1, 1] },
    ]);

    const deleted = store.deleteByProgram("A");

    expect(deleted).toBe(2);
    expect(store.count()).toBe(1);
    expect(store.programs()).toEqual(["B"]);
  });

  it("deleteByProgram returns 0 for non-existent program", () => {
    expect(store.deleteByProgram("GHOST")).toBe(0);
  });

  it("deleteById removes a specific vector", () => {
    store.upsertMany([
      { id: "keep", program: "P", nodeType: "T", domain: "D", description: "keep", embedding: [1, 0] },
      { id: "remove", program: "P", nodeType: "T", domain: "D", description: "remove", embedding: [0, 1] },
    ]);

    const removed = store.deleteById("remove");
    expect(removed).toBe(true);
    expect(store.count()).toBe(1);

    const notFound = store.deleteById("nonexistent");
    expect(notFound).toBe(false);
  });

  it("clear removes everything", () => {
    store.upsertMany([
      { id: "1", program: "A", nodeType: "T", domain: "D", description: "a", embedding: [1] },
      { id: "2", program: "B", nodeType: "T", domain: "D", description: "b", embedding: [1] },
    ]);

    const cleared = store.clear();
    expect(cleared).toBe(2);
    expect(store.count()).toBe(0);
  });
});

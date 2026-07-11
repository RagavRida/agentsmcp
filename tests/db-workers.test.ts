import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VectorDatabase } from "../src/vector/database";
import {
  handleResult,
  type PendingRequests,
} from "../src/db-workers/harness";

const TEST_DB = join(tmpdir(), ".agentsmcp-worker-vectors.db");

describe("db worker harness", () => {
  it("routes worker results back to the pending request", async () => {
    vi.useFakeTimers();
    const pending: PendingRequests = new Map();
    const timer = setTimeout(() => undefined, 1000);
    const resolve = vi.fn();
    const reject = vi.fn();
    pending.set("req-1", { resolve, reject, timer });

    const handled = handleResult(
      { id: "req-1", ok: true, result: { value: 42 } },
      pending,
    );

    expect(handled).toBe(true);
    expect(pending.size).toBe(0);
    expect(resolve).toHaveBeenCalledWith({ value: 42 });
    expect(reject).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("VectorDatabase worker adapter", () => {
  let db: VectorDatabase | null = null;

  afterEach(async () => {
    await db?.close();
    db = null;
    if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
  });

  it("forwards vector operations to an isolated worker process", async () => {
    db = new VectorDatabase({ dbPath: TEST_DB, requestTimeoutMs: 10_000 });
    await db.connect();

    expect(db.workerPid).toBeDefined();
    expect(await db.count()).toBe(0);

    await db.upsertMany([
      {
        id: "exact",
        program: "LOAN-PROC",
        nodeType: "COMPUTE",
        domain: "Risk",
        description: "Calculate monthly interest",
        embedding: [1, 0, 0],
      },
      {
        id: "far",
        program: "PAY-BATCH",
        nodeType: "IF",
        domain: "Payments",
        description: "Check settlement imbalance",
        embedding: [0, 1, 0],
      },
    ]);

    expect(await db.count()).toBe(2);
    expect(await db.programs()).toEqual(["LOAN-PROC", "PAY-BATCH"]);

    const results = await db.search([1, 0, 0], { limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("exact");
    expect(results[0].score).toBeCloseTo(1);

    expect(await db.deleteByProgram("PAY-BATCH")).toBe(1);
    expect(await db.count()).toBe(1);
    expect(await db.deleteById("exact")).toBe(true);
    expect(await db.count()).toBe(0);
  });
});

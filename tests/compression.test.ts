import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { rmSync } from "node:fs";

import { SqliteStorage } from "../src/storage";
import { NoopCompressor } from "../src/compression";
import { assembleContext } from "../src/context";
import { Compressor } from "../src/compression";
import { Message, ThreadSummary } from "../src/types";
import { freshDb } from "./setup";

let storage: SqliteStorage;
let dbDir: string;

function makeMessage(threadId: string, n: number): Message {
  return {
    id: uuidv4(),
    threadId,
    from: "a@x",
    to: "b@x",
    payload: { n },
    contextSnapshot: { step: `s${n}` },
    timestamp: n,
  };
}

beforeEach(async () => {
  const db = freshDb();
  dbDir = db.dir;
  storage = new SqliteStorage(db.path);
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("Storage summary cache", () => {
  it("getSummary returns null when no summary stored", async () => {
    const t = await storage.createThread(["a@x", "b@x"]);
    expect(await storage.getSummary(t.id)).toBeNull();
  });

  it("saveSummary round-trips and overwrites", async () => {
    const t = await storage.createThread(["a@x", "b@x"]);
    const s1: ThreadSummary = {
      text: "first",
      decisions: ["d1"],
      openQuestions: [],
      artifacts: {},
      coversMessageIds: ["m1"],
      generatedAt: 1,
    };
    await storage.saveSummary(t.id, s1);
    expect(await storage.getSummary(t.id)).toEqual(s1);

    const s2: ThreadSummary = { ...s1, text: "second", generatedAt: 2 };
    await storage.saveSummary(t.id, s2);
    const read = await storage.getSummary(t.id);
    expect(read?.text).toBe("second");
    expect(read?.generatedAt).toBe(2);
  });
});

describe("assembleContext", () => {
  it("returns empty summary when no older messages exist", async () => {
    const t = await storage.createThread(["a@x", "b@x"]);
    const msgs = [makeMessage(t.id, 1), makeMessage(t.id, 2)];
    const ctx = await assembleContext(msgs);
    expect(ctx.threadSummary).toBe("");
    expect(ctx.threadSummaryStructured).toBeUndefined();
    expect(ctx.recentMessages).toHaveLength(2);
  });

  it("falls back to legacy concatenation when no compressor is configured", async () => {
    const t = await storage.createThread(["a@x", "b@x"]);
    // 12 messages → 10 recent, 2 older
    const msgs = Array.from({ length: 12 }, (_, i) => makeMessage(t.id, i + 1));
    const ctx = await assembleContext(msgs);
    expect(ctx.threadSummaryStructured).toBeUndefined();
    expect(ctx.threadSummary).toContain("a@x → b@x");
    expect(ctx.recentMessages).toHaveLength(10);
  });

  it("NoopCompressor populates structured summary with empty body and caches it", async () => {
    const t = await storage.createThread(["a@x", "b@x"]);
    // 30 messages → 10 recent, 20 older → crosses default threshold of 20
    const msgs = Array.from({ length: 30 }, (_, i) => makeMessage(t.id, i + 1));
    const ctx = await assembleContext(msgs, {
      threadId: t.id,
      storage,
      compressor: new NoopCompressor(),
    });
    expect(ctx.threadSummaryStructured).toBeDefined();
    expect(ctx.threadSummaryStructured?.text).toBe("");
    expect(ctx.threadSummaryStructured?.coversMessageIds).toHaveLength(20);

    const cached = await storage.getSummary(t.id);
    expect(cached?.coversMessageIds).toHaveLength(20);
  });

  it("does not invoke compressor when uncovered older messages < threshold", async () => {
    const t = await storage.createThread(["a@x", "b@x"]);
    let calls = 0;
    const tracking: Compressor = {
      compress: async (messages) => {
        calls += 1;
        return {
          text: "",
          decisions: [],
          openQuestions: [],
          artifacts: {},
          coversMessageIds: messages.map((m) => m.id),
          generatedAt: Date.now(),
        };
      },
    };
    // 25 messages → 15 older. With threshold 20, no compression.
    const msgs = Array.from({ length: 25 }, (_, i) => makeMessage(t.id, i + 1));
    const ctx = await assembleContext(msgs, {
      threadId: t.id,
      storage,
      compressor: tracking,
    });
    expect(calls).toBe(0);
    expect(ctx.threadSummaryStructured).toBeUndefined();
  });

  it("NoopCompressor unions coversMessageIds across successive compressions", async () => {
    // Regression: a previous version of NoopCompressor returned only the
    // new batch in coversMessageIds, so the next read saw the original
    // messages as "uncovered" again and re-triggered compression.
    const t = await storage.createThread(["a@x", "b@x"]);
    const noop = new NoopCompressor();

    // 30 messages -> 20 older crosses threshold. Compress once.
    const round1 = Array.from({ length: 30 }, (_, i) => makeMessage(t.id, i + 1));
    await assembleContext(round1, {
      threadId: t.id,
      storage,
      compressor: noop,
    });
    const after1 = await storage.getSummary(t.id);
    expect(after1?.coversMessageIds.length).toBe(20);

    // Add 20 more messages -> uncovered=20 again. Compress should run
    // once and the resulting cache should cover 40, not 20.
    const round2 = [
      ...round1,
      ...Array.from({ length: 20 }, (_, i) => makeMessage(t.id, 31 + i)),
    ];
    await assembleContext(round2, {
      threadId: t.id,
      storage,
      compressor: noop,
    });
    const after2 = await storage.getSummary(t.id);
    expect(after2?.coversMessageIds.length).toBe(40);

    // Add one more message; uncovered=1 < threshold; compress must NOT
    // run. Cache should still cover 40, not be regenerated.
    const round3 = [...round2, makeMessage(t.id, 51)];
    await assembleContext(round3, {
      threadId: t.id,
      storage,
      compressor: noop,
    });
    const after3 = await storage.getSummary(t.id);
    expect(after3?.coversMessageIds.length).toBe(40);
    expect(after3?.generatedAt).toBe(after2?.generatedAt); // unchanged
  });

  it("reuses cached summary and only compresses uncovered messages", async () => {
    const t = await storage.createThread(["a@x", "b@x"]);
    const seen: string[][] = [];
    const tracking: Compressor = {
      compress: async (messages, prev) => {
        seen.push(messages.map((m) => m.id));
        return {
          text: "fake",
          decisions: [],
          openQuestions: [],
          artifacts: {},
          coversMessageIds: [
            ...(prev?.coversMessageIds ?? []),
            ...messages.map((m) => m.id),
          ],
          generatedAt: Date.now(),
        };
      },
    };

    // Round 1: 30 messages → 20 older crosses threshold
    const round1 = Array.from({ length: 30 }, (_, i) => makeMessage(t.id, i + 1));
    await assembleContext(round1, {
      threadId: t.id,
      storage,
      compressor: tracking,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(20);

    // Round 2: add 20 more messages so 20 new uncovered older accumulate
    // (50 total → 40 older; 20 already covered → 20 uncovered)
    const round2 = [
      ...round1,
      ...Array.from({ length: 20 }, (_, i) => makeMessage(t.id, 31 + i)),
    ];
    await assembleContext(round2, {
      threadId: t.id,
      storage,
      compressor: tracking,
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toHaveLength(20); // only the new uncovered batch
  });
});

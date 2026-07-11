import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { RaptorTreeStore } from "../../src/raptor/tree-store";
import type { RaptorTree } from "../../src/raptor/tree-builder";

describe("RaptorTreeStore", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("persists and reloads trees across restarts", async () => {
    dir = await mkdtemp(join(tmpdir(), "raptor-store-"));
    const store = new RaptorTreeStore(dir);

    const tree: RaptorTree = {
      root: {
        id: "raptor:root",
        level: 1,
        description: "Program summary",
        domain: "Risk",
        program: "LOAN-TEST",
        childIds: ["LOAN-TEST::rule-1"],
        embedding: [1, 0, 0],
      },
      levels: new Map([
        [0, [{
          id: "LOAN-TEST::rule-1",
          level: 0,
          description: "Compute interest",
          domain: "Risk",
          program: "LOAN-TEST",
          childIds: [],
          embedding: [1, 0, 0],
        }]],
      ]),
      totalNodes: 2,
      depth: 2,
    };

    await store.save("LOAN-TEST", tree);
    const loaded = await store.load("LOAN-TEST");
    expect(loaded?.root.description).toBe("Program summary");
    expect(loaded?.levels.get(0)?.[0].id).toBe("LOAN-TEST::rule-1");

    const all = await store.loadAll();
    expect(all.has("LOAN-TEST")).toBe(true);

    await store.delete("LOAN-TEST");
    expect(await store.load("LOAN-TEST")).toBeNull();
  });
});

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../src/cache/manager";
import { LocalStorageAdapter } from "../src/storage/interfaces";

describe("StorageAdapter and CacheManager", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentmailbox-storage-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads, writes, and checks local storage keys", async () => {
    const storage = new LocalStorageAdapter(dir);

    expect(await storage.exists("nested/value.txt")).toBe(false);
    expect(await storage.read("nested/value.txt")).toBeNull();

    await storage.write("nested/value.txt", "hello");

    expect(await storage.exists("nested/value.txt")).toBe(true);
    expect((await storage.read("nested/value.txt"))?.toString("utf-8")).toBe("hello");
  });

  it("prevents local storage path traversal", async () => {
    const storage = new LocalStorageAdapter(dir);

    await expect(storage.write("../escape.txt", "nope")).rejects.toThrow(
      "Invalid storage key"
    );
  });

  it("getOrCompute persists the computed value and reuses it", async () => {
    const storage = new LocalStorageAdapter(dir);
    const cache = new CacheManager(storage, { namespace: "unit" });
    const compute = vi.fn(async () => ({ rules: ["A", "B"] }));

    await expect(cache.exists("same-fragment")).resolves.toBe(false);

    const first = await cache.getOrCompute("same-fragment", compute);
    const second = await cache.getOrCompute("same-fragment", compute);

    expect(first).toEqual({ rules: ["A", "B"] });
    expect(second).toEqual(first);
    expect(compute).toHaveBeenCalledTimes(1);
    await expect(cache.exists("same-fragment")).resolves.toBe(true);
  });
});

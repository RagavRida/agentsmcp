import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import { runOptimizeLoop } from "../../src/loops/optimize-loop";

describe("runOptimizeLoop", () => {
  const outputDir = join(tmpdir(), `agentsmcp-opt-loop-${Date.now()}`);

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("runs verify iterations and returns structured result", async () => {
    await mkdir(outputDir, { recursive: true });

    const result = await runOptimizeLoop({
      targetF1: 0.99,
      maxIterations: 1,
      dataset: "sample",
      outputDir,
      registryPath: join(outputDir, "prompt-registry.json"),
      confidenceThreshold: 0.7,
    });

    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].iteration).toBe(1);
    expect(typeof result.finalF1).toBe("number");
    expect(result.promptVersion).toMatch(/^v\d+/);
    expect(result.loopMemoryPath).toContain("loop_memory.md");
    expect(result.message).toBeTruthy();
  }, 60_000);
});

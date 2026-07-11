/**
 * Unit tests for health checks.
 */
import { describe, it, expect } from "vitest";
import { checkHealth } from "../../src/health";

describe("Health Checks", () => {
  it("returns healthy status with no config", async () => {
    const health = await checkHealth();
    expect(health.status).toBeDefined();
    expect(["healthy", "degraded", "unhealthy"]).toContain(health.status);
    expect(health.timestamp).toBeDefined();
    expect(health.uptime).toBeGreaterThanOrEqual(0);
    expect(health.checks.length).toBeGreaterThanOrEqual(1);
  });

  it("always includes memory, vector store, and background task checks", async () => {
    process.env.AGENTSMCP_USE_VECTOR_WORKER = "false";
    const health = await checkHealth();
    const names = health.checks.map((c) => c.name);
    expect(names).toContain("memory");
    expect(names).toContain("vector_store");
    expect(names).toContain("background_tasks");
  });

  it("storage check passes for non-existent DB (no URL)", async () => {
    const health = await checkHealth();
    const storageCheck = health.checks.find(c => c.name === "storage");
    expect(storageCheck).toBeDefined();
    expect(storageCheck!.status).toBe("pass");
  });

  it("reports latency for all checks", async () => {
    const health = await checkHealth();
    for (const check of health.checks) {
      expect(check.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("aggregate status reflects individual checks", async () => {
    const health = await checkHealth();
    const hasFail = health.checks.some(c => c.status === "fail");
    const hasWarn = health.checks.some(c => c.status === "warn");

    if (hasFail) expect(health.status).toBe("unhealthy");
    else if (hasWarn) expect(health.status).toBe("degraded");
    else expect(health.status).toBe("healthy");
  });
});

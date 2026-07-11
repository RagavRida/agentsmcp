import { describe, expect, it } from "vitest";
import { listToolDefs } from "../src/mcp/tools";

/**
 * MCP Memory Tool Tests
 *
 * Tests that memory-related tools are properly registered with correct
 * schemas. The actual handler behavior is tested in:
 *   - tests/integration/memory.test.ts  (remember → recall → forget E2E)
 *   - tests/rule-extractor.test.ts      (rule extraction logic)
 *
 * The tools.ts handlers use CJS require() for lazy-loading, which makes
 * unit-level mocking impractical with vitest. The integration tests
 * provide the real coverage.
 */
describe("MCP Memory Tool Registration", () => {
  const defs = listToolDefs();
  const defMap = new Map(defs.map((d) => [d.name, d]));

  it("registers agentsmcp_remember", () => {
    const tool = defMap.get("agentsmcp_remember");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("Store");
    // Schema must require 'source'
    const props = (tool!.inputSchema as any).properties;
    expect(props).toHaveProperty("source");
  });

  it("registers agentsmcp_recall", () => {
    const tool = defMap.get("agentsmcp_recall");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("Search");
    const props = (tool!.inputSchema as any).properties;
    expect(props).toHaveProperty("query");
  });

  it("registers agentsmcp_forget", () => {
    const tool = defMap.get("agentsmcp_forget");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("Delete");
    const props = (tool!.inputSchema as any).properties;
    expect(props).toHaveProperty("program");
  });

  it("registers agentsmcp_save_interaction", () => {
    const tool = defMap.get("agentsmcp_save_interaction");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("rule");
    const props = (tool!.inputSchema as any).properties;
    expect(props).toHaveProperty("transcript");
    expect(props).toHaveProperty("astNodeId");
  });

  it("runTool rejects unknown tool names", async () => {
    const { runTool } = await import("../src/mcp/tools");
    const fakeAgent: any = {};
    await expect(
      runTool(fakeAgent, "agentsmcp_nonexistent", {}),
    ).rejects.toThrow("unknown tool: agentsmcp_nonexistent");
  });

  it("all tool definitions have name, description, and inputSchema", () => {
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeTruthy();
    }
  });

  it("no duplicate tool names", () => {
    const names = defs.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

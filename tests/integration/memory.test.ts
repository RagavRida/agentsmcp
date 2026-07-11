import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "path";
import { existsSync, rmSync } from "fs";
import { getMemory, resetMemoryService } from "../../src/memory/service";

const TEST_DB = resolve(__dirname, ".memory-test.db");
const TEST_VECTOR_DB = resolve(__dirname, ".memory-vector.db");

describe("Memory API - E2E Integration", () => {
  beforeEach(() => {
    process.env.AGENTSMCP_DB = TEST_DB;
    process.env.AGENTSMCP_VECTOR_DB = TEST_VECTOR_DB;
    process.env.AGENTSMCP_AGENT_ID = "test-agent";
    resetMemoryService();
  });

  afterEach(() => {
    resetMemoryService();
    if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
    if (existsSync(TEST_VECTOR_DB)) rmSync(TEST_VECTOR_DB, { force: true });
  });

  it("completes a full remember -> recall -> forget lifecycle", async () => {
    const memory = getMemory();

    // 1. Remember
    const cobolCode = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. HELLO.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-GREETING PIC X(10) VALUE 'HELLO'.
       PROCEDURE DIVISION.
           DISPLAY WS-GREETING.
           STOP RUN.
    `;
    
    const rememberRes = await memory.remember(cobolCode, {
      dataset: "test",
    });

    expect(rememberRes.status).toBe("completed");
    expect(rememberRes.vectorsStored).toBeGreaterThan(0);
    expect(rememberRes.graphNodesSynced).toBeGreaterThanOrEqual(0);

    // 2. Recall
    const recallRes = await memory.recall("greeting");
    expect(recallRes.results.length).toBeGreaterThan(0);
    expect(recallRes.results[0].program).toBe("HELLO");

    // 3. Forget
    const forgetRes = await memory.forget("HELLO");
    expect(forgetRes.vectorsDeleted).toBeGreaterThan(0);

    // 4. Verify Forget
    const recallEmpty = await memory.recall("greeting");
    expect(recallEmpty.results.length).toBe(0);
  });
});

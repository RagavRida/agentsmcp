/**
 * MCP-level integration tests for remember/recall/forget behavior.
 *
 * The MCP tool handlers use CJS require() for lazy-loading, which
 * doesn't work directly in vitest. So these tests go through the
 * Memory service directly — the same code path the tools use.
 *
 * Zero mocking — real parsers, real vector store, real embedding.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "path";
import { existsSync, rmSync } from "fs";
import {
  getMemory,
  resetMemoryService,
  listProgramStats,
} from "../../src/memory/service";

const TEST_DB = resolve(__dirname, ".mcp-remember-test.db");
const TEST_VECTOR_DB = resolve(__dirname, ".mcp-remember-vectors.db");

describe("MCP remember/recall behavior (via service)", () => {
  beforeEach(() => {
    process.env.AGENTSMCP_DB = TEST_DB;
    process.env.AGENTSMCP_VECTOR_DB = TEST_VECTOR_DB;
    process.env.AGENTSMCP_AGENT_ID = "test-agent";
    resetMemoryService();
  });

  afterEach(() => {
    resetMemoryService();
    if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
    if (existsSync(TEST_VECTOR_DB)) rmSync(TEST_VECTOR_DB, { force: true, recursive: true });
  });

  it("remember stores COBOL and returns valid stats", async () => {
    const memory = getMemory();
    const result = await memory.remember(`
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAYCALC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-SALARY PIC 9(7)V99.
       01 WS-TAX PIC 9(7)V99.
       PROCEDURE DIVISION.
           COMPUTE WS-TAX = WS-SALARY * 0.2.
           DISPLAY 'Tax: ' WS-TAX.
           STOP RUN.
    `, { dataset: "test" });

    expect(result.status).toBe("completed");
    expect(result.program).toBe("PAYCALC");
    expect(result.rulesExtracted).toBeGreaterThan(0);
    expect(result.vectorsStored).toBeGreaterThan(0);
  });

  it("recall returns results after remember", async () => {
    const memory = getMemory();
    await memory.remember(`
       IDENTIFICATION DIVISION.
       PROGRAM-ID. INTEREST.
       PROCEDURE DIVISION.
           DISPLAY 'Calculate compound interest'.
           STOP RUN.
    `, { dataset: "test" });

    const result = await memory.recall("interest calculation");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.strategy).toBeDefined();
  });

  it("forget removes vectors and they are no longer recallable", async () => {
    const memory = getMemory();
    await memory.remember(`
       IDENTIFICATION DIVISION.
       PROGRAM-ID. TEMP.
       PROCEDURE DIVISION.
           DISPLAY 'Temporary program'.
           STOP RUN.
    `, { dataset: "test" });

    const before = await memory.recall("temporary program");
    expect(before.results.length).toBeGreaterThan(0);

    const forgetRes = await memory.forget("TEMP");
    expect(forgetRes.vectorsDeleted).toBeGreaterThan(0);

    const after = await memory.recall("temporary program");
    expect(after.results.length).toBe(0);
  });

  it("remember handles PL/I with language hint", async () => {
    const memory = getMemory();
    const result = await memory.remember(`
VALPROC: PROC OPTIONS(MAIN);
  DCL AMOUNT FIXED DEC(9,2);
  DCL STATUS CHAR(1);
  IF AMOUNT > 10000 THEN
    STATUS = 'H';
  CALL AUDIT_LOG(AMOUNT, STATUS);
END VALPROC;
    `, { language: "pli", dataset: "test" });

    expect(result.status).toBe("completed");
    expect(result.program).toBe("VALPROC");
    expect(result.vectorsStored).toBeGreaterThan(0);
  });

  it("remember auto-detects language from filename", async () => {
    const memory = getMemory();
    const result = await memory.remember(`
/* REXX automation script */
PARSE ARG target
SAY 'Deploying to' target
CALL DEPLOY target
SAY 'Done.'
    `, { filename: "DEPLOY.REXX", dataset: "test" });

    expect(result.status).toBe("completed");
    expect(result.vectorsStored).toBeGreaterThan(0);
  });

  it("listProgramStats reports accurate counts after remember", async () => {
    const memory = getMemory();
    await memory.remember(`
       IDENTIFICATION DIVISION.
       PROGRAM-ID. COUNTME.
       PROCEDURE DIVISION.
           DISPLAY 'Count test'.
           STOP RUN.
    `, { dataset: "test" });

    const data = await listProgramStats(true);
    expect(data.totalPrograms).toBeGreaterThanOrEqual(1);
    expect(data.totalVectors).toBeGreaterThan(0);

    const program = data.programs.find((p) => p.program === "COUNTME");
    expect(program).toBeDefined();
    expect(program!.entryCount).toBeGreaterThan(0);
    // Detailed mode includes samples
    expect(program!.samples).toBeDefined();
    expect(program!.samples!.length).toBeGreaterThan(0);
  });
});

/**
 * Integration tests for the Memory API's remember/recall/forget lifecycle
 * across all supported languages — COBOL, JCL, PL/I, REXX.
 *
 * These tests use real parsers, real embedding (hash-based), and
 * real vector store (in-process). Zero mocking.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "path";
import { existsSync, rmSync } from "fs";
import { getMemory, resetMemoryService } from "../../src/memory/service";

const TEST_DB = resolve(__dirname, ".multi-lang-test.db");
const TEST_VECTOR_DB = resolve(__dirname, ".multi-lang-vectors.db");

describe("Multi-language Memory Integration", () => {
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

  it("remember → recall → forget for COBOL", async () => {
    const memory = getMemory();
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CUSTCHECK.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-CUSTOMER-ID PIC 9(8).
       01 WS-STATUS PIC X VALUE 'A'.
       PROCEDURE DIVISION.
           IF WS-STATUS = 'A'
               DISPLAY 'ACTIVE CUSTOMER: ' WS-CUSTOMER-ID
           END-IF.
           STOP RUN.
    `;
    const result = await memory.remember(source, { dataset: "test" });
    expect(result.status).toBe("completed");
    expect(result.program).toBe("CUSTCHECK");
    expect(result.rulesExtracted).toBeGreaterThan(0);
    expect(result.vectorsStored).toBeGreaterThan(0);

    const recall = await memory.recall("customer status check");
    expect(recall.results.length).toBeGreaterThan(0);
    expect(recall.results[0].program).toBe("CUSTCHECK");

    const forget = await memory.forget("CUSTCHECK");
    expect(forget.vectorsDeleted).toBeGreaterThan(0);

    const emptyRecall = await memory.recall("customer status check");
    expect(emptyRecall.results.length).toBe(0);
  });

  it("remember → recall → forget for JCL", async () => {
    const memory = getMemory();
    const source = `
//PAYBATCH JOB (ACCT),'PAYROLL',CLASS=A
//STEP01 EXEC PGM=PAYROLL
//INFILE DD DSN=PAY.INPUT.DATA,DISP=SHR
//OUTFILE DD DSN=PAY.OUTPUT.DATA,
//            DISP=(NEW,CATLG,DELETE),
//            UNIT=SYSDA,SPACE=(CYL,(10,5))
//STEP02 EXEC PGM=REPORT
//RPTDD DD SYSOUT=A
    `;
    const result = await memory.remember(source, { dataset: "test" });
    expect(result.status).toBe("completed");
    expect(result.program).toBe("PAYBATCH");
    expect(result.vectorsStored).toBeGreaterThan(0);

    const recall = await memory.recall("payroll batch job");
    expect(recall.results.length).toBeGreaterThan(0);

    const forget = await memory.forget("PAYBATCH");
    expect(forget.vectorsDeleted).toBeGreaterThan(0);
  });

  it("remember → recall → forget for PL/I", async () => {
    const memory = getMemory();
    const source = `
TAXCALC: PROC OPTIONS(MAIN);
  DCL INCOME FIXED DEC(9,2);
  DCL TAX FIXED DEC(9,2);
  DCL RATE FIXED DEC(3,2);

  RATE = 0.25;
  IF INCOME > 50000 THEN
    TAX = INCOME * RATE;

  CALL PRINT_REPORT(TAX);
END TAXCALC;
    `;
    const result = await memory.remember(source, {
      dataset: "test",
      language: "pli",
    });
    expect(result.status).toBe("completed");
    expect(result.program).toBe("TAXCALC");
    expect(result.vectorsStored).toBeGreaterThan(0);

    const recall = await memory.recall("tax calculation");
    expect(recall.results.length).toBeGreaterThan(0);

    const forget = await memory.forget("TAXCALC");
    expect(forget.vectorsDeleted).toBeGreaterThan(0);
  });

  it("remember → recall → forget for REXX", async () => {
    const memory = getMemory();
    const source = `
/* REXX script to validate input */
PARSE ARG input_file output_file
SAY 'Processing file:' input_file

DO i = 1 TO 100
  IF DATATYPE(record.i, 'NUM') THEN DO
    CALL VALIDATE_RECORD record.i
  END
END

CALL WRITE_REPORT output_file
SAY 'Processing complete.'
    `;
    const result = await memory.remember(source, {
      dataset: "test",
      language: "rexx",
    });
    expect(result.status).toBe("completed");
    expect(result.vectorsStored).toBeGreaterThan(0);

    const recall = await memory.recall("validate input records");
    expect(recall.results.length).toBeGreaterThan(0);

    const forget = await memory.forget(result.program);
    expect(forget.vectorsDeleted).toBeGreaterThan(0);
  });

  it("remembers multiple programs and recalls across them", async () => {
    const memory = getMemory();

    // Remember a COBOL program
    const cobol = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ACCTBAL.
       PROCEDURE DIVISION.
           PERFORM CALCULATE-BALANCE.
           STOP RUN.
       CALCULATE-BALANCE.
           DISPLAY 'Calculating balance'.
    `;
    await memory.remember(cobol, { dataset: "test" });

    // Remember a JCL job
    const jcl = `
//NIGHTRUN JOB (ACCT),'BATCH',CLASS=A
//STEP01 EXEC PGM=ACCTBAL
//INPUT DD DSN=ACCT.MASTER,DISP=SHR
    `;
    await memory.remember(jcl, { dataset: "test" });

    // Recall should find results from both
    const recall = await memory.recall("account balance");
    expect(recall.results.length).toBeGreaterThan(0);

    // Forget one, the other should still be findable
    await memory.forget("ACCTBAL");
    const afterForget = await memory.recall("batch job");
    expect(afterForget.results.length).toBeGreaterThan(0);
  });

  it("recall routes to correct search strategy based on query", async () => {
    const memory = getMemory();
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. LOANPROC.
       PROCEDURE DIVISION.
           DISPLAY 'Processing loan'.
           STOP RUN.
    `;
    await memory.remember(source, { dataset: "test" });

    // "what does X do" should route to RAPTOR or VECTOR
    const result = await memory.recall("what does LOANPROC do");
    expect(["VECTOR", "RAPTOR", "HYBRID"]).toContain(result.strategy);

    // Explicit strategy override
    const vectorResult = await memory.recall("loan processing", {
      strategy: "VECTOR",
    });
    expect(vectorResult.strategy).toBe("VECTOR");
  });

  it("session tracking works across remember and recall", async () => {
    const memory = getMemory();
    const source = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. SESSTEST.
       PROCEDURE DIVISION.
           DISPLAY 'Session test'.
           STOP RUN.
    `;
    const sessionId = "test-session-001";

    await memory.remember(source, {
      dataset: "test",
      sessionId,
    });

    const recall = await memory.recall("session test", { sessionId });
    expect(recall.results.length).toBeGreaterThan(0);
  });
});

import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { hashEmbed } from "../../src/memory/embedder";
import {
  getMemory,
  resetMemoryService,
} from "../../src/memory/service";

const SAMPLE_COBOL = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. LOAN-TEST.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-INTEREST PIC 9(5)V99.
       01 WS-BALANCE  PIC 9(9)V99.
       PROCEDURE DIVISION.
       MAIN-PARA.
           COMPUTE WS-INTEREST = WS-BALANCE * 0.05.
           IF WS-BALANCE < 0
               DISPLAY 'OVERDRAFT'
           END-IF.
           STOP RUN.
`;

describe("memory embedder", () => {
  it("produces normalized deterministic vectors", () => {
    const a = hashEmbed("interest calculation");
    const b = hashEmbed("interest calculation");
    const c = hashEmbed("payment batch");

    expect(a).toHaveLength(384);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);

    const norm = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("Memory service integration", () => {
  const vectorDb = join(tmpdir(), `agentsmcp-mem-test-${Date.now()}.db`);

  afterEach(() => {
    process.env.AGENTSMCP_USE_VECTOR_WORKER = "false";
    resetMemoryService();
    if (existsSync(vectorDb)) rmSync(vectorDb, { force: true });
  });

  it("remember stores vectors and recall returns results", async () => {
    process.env.AGENTSMCP_VECTOR_DB = vectorDb;
    process.env.AGENTSMCP_USE_VECTOR_WORKER = "false";
    delete process.env.AGENTSMCP_MODAL_EMBED_URL;
    delete process.env.AGENTSMCP_MODAL_ENDPOINT_URL;

    const memory = getMemory();
    const remembered = await memory.remember(SAMPLE_COBOL);

    if (remembered.status !== "completed") {
      throw new Error(`remember failed: ${remembered.error ?? "unknown"}`);
    }
    expect(remembered.program).toBe("LOAN-TEST");
    expect(remembered.vectorsStored).toBeGreaterThan(0);

    const recalled = await memory.recall("interest calculation", { topK: 3 });
    expect(recalled.results.length).toBeGreaterThan(0);
    expect(recalled.strategy).toBeDefined();
    expect(recalled.results[0].score).toBeGreaterThan(0);

    const forgotten = await memory.forget("LOAN-TEST");
    expect(forgotten.vectorsDeleted).toBeGreaterThan(0);

    const afterForget = await memory.recall("interest calculation", { topK: 3 });
    expect(afterForget.results.length).toBe(0);
  });
});

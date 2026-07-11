#!/usr/bin/env npx tsx
// ============================================================
// End-to-End Smoke Test: COBOL → GPU Embedding → Semantic Search
//
// Usage:
//   AGENTSMCP_MODAL_EMBED_URL=https://ragavrida--agentmailbox-embedder-fastapi-app.modal.run \
//     npx tsx scripts/smoke-e2e-vectors.ts
// ============================================================

import { parseCobol } from "../src/parser";
import { VectorStore } from "../src/vector/store";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const MODAL_URL =
  process.env.AGENTSMCP_MODAL_EMBED_URL ||
  "https://ragavrida--agentmailbox-embedder-fastapi-app.modal.run";

// A small COBOL program for testing
const COBOL_SOURCE = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. INTEREST-CALC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-PRINCIPAL     PIC 9(10)V99.
       01 WS-RATE           PIC 9(3)V99.
       01 WS-INTEREST       PIC 9(10)V99.
       01 WS-ACCOUNT-NO     PIC X(10).
       01 WS-CUST-NAME      PIC X(30).
       01 WS-ERROR-FLAG     PIC X(1).
       PROCEDURE DIVISION.
       MAIN-PARAGRAPH.
           PERFORM VALIDATE-ACCOUNT
           PERFORM CALCULATE-INTEREST
           PERFORM APPLY-TAX
           STOP RUN.
       VALIDATE-ACCOUNT.
           IF WS-ACCOUNT-NO = SPACES
               MOVE 'Y' TO WS-ERROR-FLAG
               DISPLAY 'ERROR: ACCOUNT MISSING'
           END-IF.
       CALCULATE-INTEREST.
           COMPUTE WS-INTEREST =
               WS-PRINCIPAL * WS-RATE / 100.
       APPLY-TAX.
           IF WS-INTEREST > 10000
               COMPUTE WS-INTEREST =
                   WS-INTEREST * 0.70
               DISPLAY 'TAX APPLIED'
           END-IF.
`;

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  End-to-End: COBOL → GPU Embed → Search");
  console.log("═══════════════════════════════════════════\n");

  // Step 1: Parse COBOL
  console.log("Step 1: Parsing COBOL...");
  const result = parseCobol(COBOL_SOURCE, { filename: "INTEREST-CALC.CBL" });
  console.log(`  Program: ${result.programName}`);
  console.log(`  Business Rules: ${result.businessRules.length}`);
  console.log(`  Data Access: ${result.dataAccess.length}`);
  console.log(`  Control Flow: ${result.controlFlow.length}`);
  console.log(`  Graph: ${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges`);
  console.log();

  // Step 2: Create vector store (temp SQLite file)
  const dbPath = path.join(os.tmpdir(), `agentsmcp-vectors-${Date.now()}.db`);
  console.log(`Step 2: Creating vector store at ${dbPath}`);
  const store = new VectorStore(dbPath, MODAL_URL);
  console.log();

  // Step 3: Collect all semantic nodes
  const allNodes = [
    ...result.businessRules.map((r) => ({
      id: `legacy:rule:${result.programName}:${r.id}`,
      nodeType: r.type,
      description: r.description,
      domain: r.domain,
      metadata: { inputs: r.inputs, outputs: r.outputs },
    })),
    ...result.dataAccess.map((d) => ({
      id: `legacy:data:${result.programName}:${d.id}`,
      nodeType: d.type,
      description: d.description,
      domain: d.domain,
      metadata: {},
    })),
    ...result.controlFlow.map((c) => ({
      id: `legacy:flow:${result.programName}:${c.id}`,
      nodeType: c.type,
      description: c.description,
      domain: c.domain,
      metadata: {},
    })),
  ];

  console.log(`Step 3: Collected ${allNodes.length} semantic nodes`);
  for (const n of allNodes) {
    console.log(`  [${n.domain}] ${n.description}`);
  }
  console.log();

  // Step 4: Batch embed via Modal GPU
  console.log(`Step 4: Sending ${allNodes.length} descriptions to Modal GPU...`);
  const descriptions = allNodes.map((n) => n.description);
  const startEmbed = Date.now();
  const embeddings = await store.embed(descriptions, "passage");
  const embedTime = Date.now() - startEmbed;
  console.log(`  ✅ Got ${embeddings.length} embeddings (${embeddings[0].length} dimensions each)`);
  console.log(`  ⏱  Embedding time: ${embedTime}ms`);
  console.log();

  // Step 5: Store vectors
  console.log("Step 5: Storing vectors in SQLite...");
  const entries = allNodes.map((n, i) => ({
    id: n.id,
    program: result.programName,
    nodeType: n.nodeType,
    domain: n.domain,
    description: n.description,
    embedding: embeddings[i],
    metadata: n.metadata,
  }));
  store.upsertMany(entries);
  console.log(`  ✅ Stored ${store.count()} vectors`);
  console.log();

  // Step 6: Semantic search!
  const queries = [
    "How does the system calculate interest?",
    "What happens when an account is invalid?",
    "Is there any tax logic?",
    "What are the payment rules?",
  ];

  console.log("Step 6: Semantic Search Results");
  console.log("───────────────────────────────────────────");

  for (const query of queries) {
    console.log(`\n  🔍 "${query}"`);
    const results = await store.semanticSearch(query, { limit: 3 });
    for (const r of results) {
      console.log(`     ${r.score.toFixed(3)} │ [${r.domain}] ${r.description}`);
    }
  }

  // Cleanup
  store.close();
  fs.unlinkSync(dbPath);

  console.log("\n═══════════════════════════════════════════");
  console.log("  ✅ End-to-End Pipeline Complete!");
  console.log("═══════════════════════════════════════════");
}

main().catch(console.error);

#!/usr/bin/env npx tsx
// ============================================================
// RAPTOR Smoke Test — Build tree from parsed data, then search
// ============================================================

import { VectorStore } from "../src/vector/store";
import { RaptorTreeBuilder } from "../src/raptor/tree-builder";

const MODAL_EMBED_URL = process.env.AGENTSMCP_MODAL_EMBED_URL
  || "https://ragavrida--agentmailbox-embedder-fastapi-app.modal.run";
const VLLM_URL = process.env.AGENTSMCP_VLLM_URL
  || "https://ragavrida--agentmailbox-inference-fastapi-app.modal.run";

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  RAPTOR Tree Smoke Test");
  console.log("═══════════════════════════════════════════\n");

  // 1. Parse COBOL and embed into vector store
  console.log("Step 1: Parsing COBOL + embedding...");
  const { parseCobol } = require("../src/parser");

  const INTEREST_CALC = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. INTEREST-CALC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-PRINCIPAL     PIC 9(10)V99.
       01 WS-RATE           PIC 9(3)V99.
       01 WS-INTEREST       PIC 9(10)V99.
       01 WS-ACCOUNT-NO     PIC X(10).
       PROCEDURE DIVISION.
       MAIN-PARAGRAPH.
           PERFORM VALIDATE-ACCOUNT
           PERFORM CALCULATE-INTEREST
           CALL 'TAXCALC' USING WS-INTEREST
           STOP RUN.
       VALIDATE-ACCOUNT.
           DISPLAY "VALIDATING".
       CALCULATE-INTEREST.
           COMPUTE WS-INTEREST = WS-PRINCIPAL * WS-RATE / 100.
  `;

  const TAXCALC = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. TAXCALC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-TAX-RATE       PIC 9(3)V99.
       PROCEDURE DIVISION.
       MAIN-PARAGRAPH.
           DISPLAY "TAX CALC".
           STOP RUN.
  `;

  const programs = [
    parseCobol(INTEREST_CALC, { filename: "INTEREST-CALC.cbl" }),
    parseCobol(TAXCALC, { filename: "TAXCALC.cbl" }),
  ];

  const store = new VectorStore(":memory:", MODAL_EMBED_URL);

  // Collect all nodes
  const allNodes = [];
  for (const result of programs) {
    for (const rule of result.businessRules) {
      allNodes.push({
        id: `${result.programName}:${rule.id}`,
        nodeType: rule.type,
        description: rule.description,
        domain: rule.domain,
        program: result.programName,
      });
    }
    for (const da of result.dataAccess) {
      allNodes.push({
        id: `${result.programName}:${da.id}`,
        nodeType: da.type,
        description: da.description,
        domain: da.domain,
        program: result.programName,
      });
    }
  }

  console.log(`  Collected ${allNodes.length} nodes from ${programs.length} programs`);

  // Batch embed
  console.log("  Embedding via Modal GPU...");
  const descriptions = allNodes.map(n => n.description);
  const embeddings = await store.embed(descriptions, "passage");

  // Store vectors
  const entries = allNodes.map((n, i) => ({
    ...n,
    embedding: embeddings[i],
    metadata: {},
  }));
  store.upsertMany(entries);
  console.log(`  ✅ ${entries.length} vectors stored\n`);

  // 2. Build RAPTOR tree
  console.log("Step 2: Building RAPTOR tree...");

  // Use vLLM as the summarizer
  const summarizer = async (texts: string[]): Promise<string> => {
    try {
      const resp = await fetch(`${VLLM_URL}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `Summarize these business rules in one sentence:\n${texts.join("\n")}`,
          system_context: "You are a technical summarizer. Be concise.",
          max_tokens: 100,
          temperature: 0.1,
        }),
      });
      const data = await resp.json() as { text: string };
      return data.text || texts[0];
    } catch {
      // Fallback: concatenate first 100 chars of each
      return texts.map(t => t.substring(0, 50)).join("; ");
    }
  };

  const builder = new RaptorTreeBuilder(store, summarizer);
  const tree = await builder.buildTree(entries, { maxClusterSize: 5 });

  console.log(`  Tree depth: ${tree.depth} levels`);
  console.log(`  Total nodes: ${tree.totalNodes}`);
  for (const [level, nodes] of tree.levels) {
    console.log(`    Level ${level}: ${nodes.length} nodes`);
  }
  console.log(`  Root: "${tree.root.description.substring(0, 80)}..."\n`);

  // 3. Search the tree
  console.log("Step 3: Hierarchical search...\n");

  const queries = [
    "How is interest calculated?",
    "What tax rates are used?",
    "What data does the system read?",
  ];

  for (const query of queries) {
    console.log(`  🔍 "${query}"`);
    const results = await builder.search(query, tree, { beamWidth: 2, maxResults: 3 });
    for (const r of results) {
      console.log(`    → [${r.domain}] ${r.description.substring(0, 70)} (score: ${r.score.toFixed(3)})`);
    }
    console.log();
  }

  // 4. Compare: flat search vs RAPTOR search
  console.log("Step 4: Flat search vs RAPTOR search...\n");
  const testQuery = "How is interest calculated?";

  const flatResults = await store.semanticSearch(testQuery, { limit: 3 });
  console.log(`  Flat search for "${testQuery}":`);
  for (const r of flatResults) {
    console.log(`    → [${r.domain}] ${r.description.substring(0, 70)} (score: ${r.score.toFixed(3)})`);
  }

  const raptorResults = await builder.search(testQuery, tree, { beamWidth: 2, maxResults: 3 });
  console.log(`\n  RAPTOR search for "${testQuery}":`);
  for (const r of raptorResults) {
    console.log(`    → [${r.domain}] ${r.description.substring(0, 70)} (score: ${r.score.toFixed(3)})`);
  }

  store.close();

  console.log("\n═══════════════════════════════════════════");
  console.log("  ✅ RAPTOR Tree Test Complete!");
  console.log("═══════════════════════════════════════════");
}

main().catch(console.error);

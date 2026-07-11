#!/usr/bin/env npx tsx
// ============================================================
// Smoke Test: Parse COBOL → Sync to Neo4j → Impact Analysis
//
// Usage:
//   npx tsx scripts/smoke-neo4j.ts
//
// Requires: Neo4j running on bolt://localhost:7687
//           (docker run -d -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/agentsmcp2026 neo4j:5)
// ============================================================

import { parseCobol, parseJcl } from "../src/parser";
import { Neo4jSync } from "../src/graph/neo4j-sync";

const NEO4J_URI = process.env.NEO4J_URI || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASS = process.env.NEO4J_PASS || "agentsmcp2026";

// Two COBOL programs and a JCL job that ties them together
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
           IF WS-ACCOUNT-NO = SPACES
               DISPLAY 'ERROR: ACCOUNT MISSING'
           END-IF.
       CALCULATE-INTEREST.
           COMPUTE WS-INTEREST =
               WS-PRINCIPAL * WS-RATE / 100.
`;

const TAX_CALC = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. TAXCALC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-AMOUNT         PIC 9(10)V99.
       01 WS-TAX-RATE        PIC 9(3)V99.
       01 WS-TAX             PIC 9(10)V99.
       PROCEDURE DIVISION USING WS-AMOUNT.
       MAIN-PARAGRAPH.
           PERFORM CALCULATE-TAX
           PERFORM APPLY-WITHHOLDING
           STOP RUN.
       CALCULATE-TAX.
           COMPUTE WS-TAX = WS-AMOUNT * WS-TAX-RATE / 100.
       APPLY-WITHHOLDING.
           IF WS-TAX > 5000
               COMPUTE WS-TAX = WS-TAX * 1.10
               DISPLAY 'WITHHOLDING APPLIED'
           END-IF.
`;

const JCL_JOB = `
//DAILYJOB JOB (ACCT),'DAILY INTEREST',MSGCLASS=A,CLASS=A
//STEP01   EXEC PGM=INTEREST-CALC
//INFILE   DD DSN=PROD.ACCT.MASTER,DISP=SHR
//OUTFILE  DD DSN=PROD.INTEREST.OUTPUT,DISP=(NEW,CATLG)
//STEP02   EXEC PGM=TAXCALC
//TAXDD    DD DSN=PROD.TAX.RATES,DISP=SHR
//SYSOUT   DD SYSOUT=A
`;

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  Neo4j Smoke Test: Parse → Sync → Query");
  console.log("═══════════════════════════════════════════\n");

  // Step 1: Parse everything
  console.log("Step 1: Parsing COBOL + JCL...");
  const interest = parseCobol(INTEREST_CALC, { filename: "INTEREST-CALC.CBL" });
  const tax = parseCobol(TAX_CALC, { filename: "TAXCALC.CBL" });
  const jcl = parseJcl(JCL_JOB, { filename: "DAILYJOB.JCL" });

  console.log(`  INTEREST-CALC: ${interest.businessRules.length} rules, ${interest.graph.nodes.length} nodes`);
  console.log(`  TAXCALC: ${tax.businessRules.length} rules, ${tax.graph.nodes.length} nodes`);
  console.log(`  DAILYJOB: ${jcl.graph.nodes.length} nodes, ${jcl.graph.edges.length} edges`);
  console.log();

  // Step 2: Connect to Neo4j
  console.log(`Step 2: Connecting to Neo4j at ${NEO4J_URI}...`);
  const neo4j = new Neo4jSync({ uri: NEO4J_URI, user: NEO4J_USER, password: NEO4J_PASS });

  await neo4j.initialize();
  console.log("  ✅ Indexes and constraints created");
  console.log();

  // Step 3: Sync to Neo4j
  console.log("Step 3: Syncing parsed graphs to Neo4j...");

  const r1 = await neo4j.syncCobol({
    programName: interest.programName,
    graph: interest.graph,
    semanticTree: { description: interest.semanticTree.description, domain: "Pricing" },
    businessRules: interest.businessRules,
    stats: interest.stats,
  });
  console.log(`  INTEREST-CALC: ${r1.nodesCreated} nodes, ${r1.edgesCreated} edges`);

  const r2 = await neo4j.syncCobol({
    programName: tax.programName,
    graph: tax.graph,
    semanticTree: { description: tax.semanticTree.description, domain: "Taxation" },
    businessRules: tax.businessRules,
    stats: tax.stats,
  });
  console.log(`  TAXCALC: ${r2.nodesCreated} nodes, ${r2.edgesCreated} edges`);

  const r3 = await neo4j.syncJcl({
    jobName: jcl.jobName,
    graph: jcl.graph,
  });
  console.log(`  DAILYJOB: ${r3.nodesCreated} nodes, ${r3.edgesCreated} edges`);
  console.log();

  // Step 4: Impact Analysis
  console.log("Step 4: Impact Analysis");
  console.log("───────────────────────────────────────────");

  const impact = await neo4j.impactAnalysis("INTEREST-CALC");
  console.log(`\n  🎯 Target: INTEREST-CALC`);
  console.log(`  Direct impact: ${impact.directImpact.length} nodes`);
  for (const d of impact.directImpact) {
    console.log(`    → [${d.type}] ${d.name} (${d.relationship})`);
  }
  console.log(`  Indirect impact: ${impact.indirectImpact.length} nodes`);
  for (const d of impact.indirectImpact) {
    console.log(`    → [${d.type}] ${d.name} (depth: ${d.depth})`);
  }
  console.log(`  Affected datasets: ${impact.affectedDatasets.join(", ") || "none"}`);
  console.log(`  Total affected: ${impact.totalAffected}`);
  console.log();

  // Step 5: Dependency Chain
  console.log("Step 5: Dependency Chains");
  console.log("───────────────────────────────────────────");

  const chains = await neo4j.dependencyChain("INTEREST-CALC");
  for (const chain of chains) {
    const path = chain.path.map((n) => `${n.name}(${n.type})`).join(" → ");
    console.log(`  ${path}`);
    console.log(`    via: ${chain.relationships.join(" → ")}`);
  }
  console.log();

  // Step 6: Generate Training Data
  console.log("Step 6: Synthetic Training Data");
  console.log("───────────────────────────────────────────");

  const trainingPairs = await neo4j.generateTrainingPairs(10);
  console.log(`  Generated ${trainingPairs.length} Q&A pairs:`);
  for (const pair of trainingPairs.slice(0, 5)) {
    console.log(`\n  Q: ${pair.question}`);
    console.log(`  A: ${pair.answer.substring(0, 150)}...`);
  }

  await neo4j.close();

  console.log("\n═══════════════════════════════════════════");
  console.log("  ✅ Neo4j Pipeline Complete!");
  console.log("  📊 Open http://localhost:7474 for visual graph explorer");
  console.log("═══════════════════════════════════════════");
}

main().catch(console.error);

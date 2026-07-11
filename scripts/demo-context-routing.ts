#!/usr/bin/env npx tsx
/**
 * Demo: Dynamic Context Routing with Encapsulation
 *
 * Shows how 3 agents communicate through the mailbox,
 * each getting ONLY what they need — no hardcoded contracts.
 */

import { ContextRouter } from "../src/context-router";

const router = new ContextRouter();

console.log("\n╔════════════════════════════════════════════════════════╗");
console.log("║  Dynamic Context Routing — Encapsulation Demo          ║");
console.log("╚════════════════════════════════════════════════════════╝\n");

// ══════════════════════════════════════════════════════════════
// STEP 1: Parser Agent produces FULL output
// ══════════════════════════════════════════════════════════════
console.log("── Step 1: Parser Agent sends full output ────────\n");

const parserOutput = {
  programName: "LOAN-PROCESSOR",
  businessRules: [
    { id: "sem_1", description: "CHECK WITHDRAWAL: compare against daily limit", domain: "Risk" },
    { id: "sem_2", description: "APPLY OVERDRAFT: deduct fee when balance < 0", domain: "Fees" },
    { id: "sem_3", description: "CALCULATE INTEREST: monthly compounding", domain: "Pricing" },
  ],
  controlFlow: Array.from({ length: 25 }, (_, i) => ({
    id: `cf_${i}`, type: "PERFORM", from: `PARA-${i}`, to: `PARA-${i + 1}`,
  })),
  dataTransforms: [
    { id: "dt_1", description: "COMPUTE WS-MONTHLY-RATE = ANNUAL-RATE / 12 / 100" },
    { id: "dt_2", description: "COMPUTE WS-BALANCE = WS-BALANCE - WS-OVERDRAFT-FEE" },
  ],
  graph: {
    nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n_${i}`, name: `NODE-${i}` })),
    edges: Array.from({ length: 40 }, (_, i) => ({ source: `n_${i}`, target: `n_${i + 1}` })),
  },
  _internalParserState: { peekBuffer: "...", tokenizer: "stateful", cacheHits: 42 },
  _debugAst: { raw: "massive internal AST representation..." },
  stats: { paragraphs: 6, llmCalls: 0, parseTimeMs: 150 },
};

// Wrap — auto-discovers visibility
const envelope = router.wrap("parser-agent", parserOutput);
console.log(`  Full payload: ${JSON.stringify(parserOutput).length} bytes`);
console.log(`  Fields discovered: ${envelope.fields.filter(f => !f.key.includes(".")).length} top-level`);
console.log(`  Field map:`);
for (const f of envelope.fields.filter(f => !f.key.includes("."))) {
  console.log(`    ${f.visibility.padEnd(9)} | ${f.key.padEnd(25)} | ${f.sizeBytes} bytes`);
}

// ══════════════════════════════════════════════════════════════
// STEP 2: Migration Agent receives — only needs business rules + graph
// (learned from access patterns, NOT hardcoded)
// ══════════════════════════════════════════════════════════════
console.log("\n── Step 2: Migration Agent receives (learned) ────\n");

// Simulate: migration agent has accessed these fields 5 times before
router.trackAccess("migration-agent", ["businessRules", "graph", "programName"]);
router.trackAccess("migration-agent", ["businessRules", "graph", "programName"]);
router.trackAccess("migration-agent", ["businessRules", "graph"]);
router.trackAccess("migration-agent", ["businessRules", "graph"]);
router.trackAccess("migration-agent", ["businessRules"]);

const migrationView = router.scope(envelope, "migration-agent");
console.log(`  Scoped payload: ${JSON.stringify(migrationView).length} bytes`);
console.log(`  Included fields: ${(migrationView._includedFields as string[]).join(", ")}`);
console.log(`  ❌ Excluded: _internalParserState, _debugAst (internal)`);
console.log(`  ❌ Excluded: controlFlow (never accessed → score too low)`);
console.log(`  ✅ Included: businessRules (accessed 5x), graph (4x), programName (2x)`);

// ══════════════════════════════════════════════════════════════
// STEP 3: Audit Agent receives — only needs stats + provenance
// (declared interest, NOT learned)
// ══════════════════════════════════════════════════════════════
console.log("\n── Step 3: Audit Agent receives (declared) ────────\n");

router.declareInterest("audit-agent", ["stats", "programName"], 500); // 500 token budget

const auditView = router.scope(envelope, "audit-agent");
console.log(`  Scoped payload: ${JSON.stringify(auditView).length} bytes`);
console.log(`  Included fields: ${(auditView._includedFields as string[]).join(", ")}`);
console.log(`  Token budget: 500 → only stats + programName fit`);

// ══════════════════════════════════════════════════════════════
// STEP 4: NEW agent with NO history — gets public fields only
// ══════════════════════════════════════════════════════════════
console.log("\n── Step 4: New Agent receives (no history) ────────\n");

const newAgentView = router.scope(envelope, "new-agent");
console.log(`  Scoped payload: ${JSON.stringify(newAgentView).length} bytes`);
console.log(`  Included fields: ${(newAgentView._includedFields as string[]).join(", ")}`);
console.log(`  Gets all PUBLIC fields, no internal, summaries for large derived`);

// ══════════════════════════════════════════════════════════════
// STEP 5: One-shot route (wrap + scope together)
// ══════════════════════════════════════════════════════════════
console.log("\n── Step 5: One-shot route ──────────────────────────\n");

const { scoped } = router.route("parser-agent", "migration-agent", parserOutput, {
  tokenBudget: 300,
});
console.log(`  Budget-constrained (300 tokens):`);
console.log(`  Included: ${(scoped._includedFields as string[]).join(", ")}`);
console.log(`  Large fields summarized: ${JSON.stringify(scoped.controlFlow || scoped.graph)?.substring(0, 80)}`);

// ══════════════════════════════════════════════════════════════
// COMPARISON
// ══════════════════════════════════════════════════════════════
console.log("\n╔════════════════════════════════════════════════════════╗");
console.log("║                  ENCAPSULATION RESULTS                 ║");
console.log("╠════════════════════════════════════════════════════════╣");

const fullSize = JSON.stringify(parserOutput).length;
const migSize = JSON.stringify(migrationView).length;
const auditSize = JSON.stringify(auditView).length;
const newSize = JSON.stringify(newAgentView).length;

const pct = (n: number) => ((n / fullSize) * 100).toFixed(0);

console.log(`║  Full payload (stored):     ${String(fullSize).padStart(6)} bytes (100%)        ║`);
console.log(`║  → Migration Agent sees:    ${String(migSize).padStart(6)} bytes (${pct(migSize).padStart(3)}%)        ║`);
console.log(`║  → Audit Agent sees:        ${String(auditSize).padStart(6)} bytes (${pct(auditSize).padStart(3)}%)        ║`);
console.log(`║  → New Agent sees:          ${String(newSize).padStart(6)} bytes (${pct(newSize).padStart(3)}%)        ║`);
console.log("╠════════════════════════════════════════════════════════╣");
console.log("║  No hardcoded contracts. Learned from usage.           ║");
console.log("║  Internal fields (_debug, _internal) never leak.       ║");
console.log("║  Large arrays auto-summarized under budget.            ║");
console.log("╚════════════════════════════════════════════════════════╝");

// Show interest profiles
console.log("\n── Agent Interest Profiles (auto-learned) ─────────\n");
for (const agentId of ["migration-agent", "audit-agent", "new-agent"]) {
  const profile = router.getInterestProfile(agentId);
  if (profile) {
    const accessed = [...profile.accessedFields.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}(${v}x)`)
      .join(", ");
    const requested = [...profile.requestedFields].join(", ");
    console.log(`  ${agentId}:`);
    if (accessed) console.log(`    Learned: ${accessed}`);
    if (requested) console.log(`    Declared: ${requested}`);
    console.log(`    Budget: ${profile.tokenBudget === Infinity ? "unlimited" : profile.tokenBudget + " tokens"}`);
  } else {
    console.log(`  ${agentId}: no profile (first time — gets public defaults)`);
  }
}

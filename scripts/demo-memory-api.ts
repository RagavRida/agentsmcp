#!/usr/bin/env npx tsx
/**
 * Demo: Cognee-inspired Memory API
 *
 * Shows the remember() → recall() → forget() flow
 * with auto-routing query classification.
 */

import { routeQuery, type SearchStrategy } from "../src/memory";

console.log("\n╔════════════════════════════════════════════════════════╗");
console.log("║  AgentMailbox Memory API — Cognee-inspired             ║");
console.log("║  remember() → recall() → forget()                      ║");
console.log("╚════════════════════════════════════════════════════════╝\n");

// ══════════════════════════════════════════════════════════════
// PART 1: Query Router Demo (no LLM needed)
// ══════════════════════════════════════════════════════════════
console.log("── Auto-Routing Query Classification ──────────────\n");

const queries = [
  // Should route to RAPTOR (high-level summary)
  "What does LOAN-PROCESSOR do?",
  "Give me an overview of the payment system",

  // Should route to GRAPH (relationship traversal)
  "What calls FRAUD-DETECTOR?",
  "Show me the impact of changing INTEREST-CALC",
  "What depends on DAILY-LIMIT?",

  // Should route to VECTOR (semantic similarity)
  "Find rules similar to overdraft fee calculation",
  "Search for withdrawal limit checks",

  // Should route to FLARE (complex reasoning)
  "Explain why the interest rate is compounded monthly",
  "What happens when balance goes negative?",

  // Should route to TRAJECTORY (audit)
  "When was LOAN-PROC last parsed?",
  "Show me the audit history for PAYMENT-BATCH",

  // Should route to HYBRID (broad)
  "Everything about the settlement process",
];

const strategyColors: Record<SearchStrategy, string> = {
  VECTOR: "\x1b[36m",      // cyan
  RAPTOR: "\x1b[33m",      // yellow
  GRAPH: "\x1b[35m",       // magenta
  FLARE: "\x1b[31m",       // red
  TRAJECTORY: "\x1b[32m",  // green
  HYBRID: "\x1b[34m",      // blue
};

const reset = "\x1b[0m";

for (const query of queries) {
  const route = routeQuery(query);
  const color = strategyColors[route.strategy] ?? "";
  const confidence = "█".repeat(Math.min(Math.round(route.confidence), 10));
  console.log(`  ${color}${route.strategy.padEnd(12)}${reset} ${confidence.padEnd(10)} "${query}"`);
}

// ══════════════════════════════════════════════════════════════
// PART 2: API Usage Examples
// ══════════════════════════════════════════════════════════════
console.log("\n── API Usage: Before vs After ──────────────────────\n");

console.log("  BEFORE (7-pillar manual):");
console.log("  ─────────────────────────────────────────────────");
console.log("  const parsed = parseCobol(source);");
console.log("  const descs = parsed.semanticNodes.map(n => n.description);");
console.log("  const embs = await embed(descs);");
console.log("  const entries = nodes.map((n,i) => ({ ...n, embedding: embs[i] }));");
console.log("  await vectorStore.upsertMany(entries);");
console.log("  const tree = await raptorBuilder.buildTree(entries);");
console.log("  await neo4j.syncProgram(name, parsed);");
console.log("  await byos.put(key, JSON.stringify(parsed));");
console.log("  trajectory.log({ action: 'PARSE', program: name, ... });");
console.log("  // 9 lines, 5 different services\n");

console.log("  AFTER (Memory API):");
console.log("  ─────────────────────────────────────────────────");
console.log('  const result = await memory.remember(cobolSource);');
console.log("  // 1 line. Done.\n");

console.log("  BEFORE (search):");
console.log("  ─────────────────────────────────────────────────");
console.log("  const queryEmb = await embed([query]);");
console.log("  // Which search do I use? vector? graph? RAPTOR?");
console.log("  const results = await vectorStore.search(queryEmb[0], 5);");
console.log("  // Or should I use neo4j.analyzeImpact()?");
console.log("  // Or raptorBuilder.search()?");
console.log("  // 🤷 User has to decide manually\n");

console.log("  AFTER (Memory API):");
console.log("  ─────────────────────────────────────────────────");
console.log('  const results = await memory.recall("What calls FRAUD-DETECTOR?");');
console.log("  // Auto-routes to GRAPH strategy. Done.\n");

console.log("  BEFORE (delete):");
console.log("  ─────────────────────────────────────────────────");
console.log("  await vectorStore.deleteByProgram('LOAN-PROC');");
console.log("  raptorTrees.delete('LOAN-PROC');");
console.log("  await neo4j.deleteProgram('LOAN-PROC');");
console.log("  await byos.delete('main/LOAN-PROC/');");
console.log("  trajectory.clearProgram('LOAN-PROC');");
console.log("  // 5 lines, easy to forget one\n");

console.log("  AFTER (Memory API):");
console.log("  ─────────────────────────────────────────────────");
console.log('  await memory.forget("LOAN-PROC");');
console.log("  // Cascade deletes from ALL stores. Done.\n");

// ══════════════════════════════════════════════════════════════
// PART 3: Session Memory
// ══════════════════════════════════════════════════════════════
console.log("── Session vs Persistent Memory ───────────────────\n");

console.log("  Session (ephemeral, per-agent):");
console.log("  ─────────────────────────────────────────────────");
console.log('  memory.sessionSet("session_abc", "lastProgram", "LOAN-PROC");');
console.log('  memory.sessionSet("session_abc", "currentTask", "analyzing overdrafts");');
console.log('  const ctx = memory.sessionGetAll("session_abc");');
console.log("  // → { lastProgram: 'LOAN-PROC', currentTask: 'analyzing overdrafts' }");
console.log("  // Auto-expires after 30 min. No config needed.\n");

console.log("  Persistent (knowledge graph, permanent):");
console.log("  ─────────────────────────────────────────────────");
console.log('  await memory.remember(cobolSource);');
console.log("  // → Stored in VectorStore + RAPTOR + Neo4j + BYOS");
console.log("  // → Survives restarts. Available to all agents.\n");

// ══════════════════════════════════════════════════════════════
// PART 4: Comparison with Cognee
// ══════════════════════════════════════════════════════════════
console.log("── What We Took vs What We Kept ───────────────────\n");

console.log("  From Cognee:");
console.log("  ✅ remember/recall/forget API pattern");
console.log("  ✅ Auto-routing query classification (rule-based, no LLM)");
console.log("  ✅ Session vs persistent memory separation");
console.log("  ✅ RememberResult with status, elapsed, items\n");

console.log("  Our Advantages (not in Cognee):");
console.log("  🏦 Deterministic COBOL parser (no LLM for extraction)");
console.log("  🏦 Semantic verifier (conservation of money, sign flip detection)");
console.log("  🏦 RAPTOR hierarchical tree (O(log N) vs O(N) search)");
console.log("  🏦 FLARE active retrieval (logprob-triggered)");
console.log("  🏦 DeepSeek MLA + prefix caching (sovereign on-prem)");
console.log("  🏦 Context router (dynamic encapsulation between agents)");

console.log("\n╔════════════════════════════════════════════════════════╗");
console.log("║  3 lines to replace 30. Same 7 pillars underneath.    ║");
console.log("║  remember() → recall() → forget()                      ║");
console.log("╚════════════════════════════════════════════════════════╝\n");

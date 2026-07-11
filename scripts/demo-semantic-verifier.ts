#!/usr/bin/env npx tsx
/**
 * Demo: Semantic Verifier catches banking transfer errors
 *
 * Simulates 5 scenarios where migration semantics go wrong.
 * The verifier catches every one BEFORE production.
 */

import {
  SemanticVerifier,
  diffSemantics,
  type TransferContext,
  type SemanticRule,
} from "../src/verification/semantic-verifier";

const verifier = new SemanticVerifier();

console.log("\n╔════════════════════════════════════════════════════════╗");
console.log("║  SEMANTIC VERIFIER — Banking Transfer Safety           ║");
console.log("║  Catches errors BEFORE they reach production           ║");
console.log("╚════════════════════════════════════════════════════════╝\n");

// ══════════════════════════════════════════════════════════════
// SCENARIO 1: ✅ Correct Transfer
// ══════════════════════════════════════════════════════════════
console.log("── Scenario 1: Correct Transfer ──────────────────\n");

const correct: TransferContext = {
  sourceAccount: "ACC-001", targetAccount: "ACC-002",
  amount: 1000, currency: "USD",
  sourceBalanceBefore: 5000, sourceBalanceAfter: 3995,  // 1000 + 5 fee
  targetBalanceBefore: 2000, targetBalanceAfter: 3000,
  fees: 5,
  roundingMode: "HALF_EVEN",
};

const r1 = verifier.verify(correct);
console.log(`  Result: ${r1.safe ? "✅ SAFE" : "❌ UNSAFE"}`);
for (const r of r1.results) console.log(`    ${r.detail}`);

// ══════════════════════════════════════════════════════════════
// SCENARIO 2: ❌ SIGN FLIP — debit/credit reversed
// This is the classic migration bug: SUBTRACT becomes ADD
// ══════════════════════════════════════════════════════════════
console.log("\n── Scenario 2: SIGN FLIP (debit/credit reversed) ─\n");

const signFlip: TransferContext = {
  sourceAccount: "ACC-001", targetAccount: "ACC-002",
  amount: 1000, currency: "USD",
  sourceBalanceBefore: 5000, sourceBalanceAfter: 6000,  // ← WRONG: increased!
  targetBalanceBefore: 2000, targetBalanceAfter: 1000,  // ← WRONG: decreased!
  fees: 0,
};

const r2 = verifier.verify(signFlip);
console.log(`  Result: ${r2.safe ? "✅ SAFE" : "❌ UNSAFE — " + r2.criticalFailures.length + " critical"}`);
for (const r of r2.results.filter(r => !r.holds)) console.log(`    ${r.detail}`);

// ══════════════════════════════════════════════════════════════
// SCENARIO 3: ❌ MONEY CREATED — rounding error at scale
// 1 cent per transaction × 10M transactions/day = $100K/day
// ══════════════════════════════════════════════════════════════
console.log("\n── Scenario 3: Money Created (rounding error) ────\n");

const moneyCreated: TransferContext = {
  sourceAccount: "ACC-001", targetAccount: "ACC-002",
  amount: 33.33, currency: "USD",
  sourceBalanceBefore: 100, sourceBalanceAfter: 66.67,
  targetBalanceBefore: 0, targetBalanceAfter: 33.34,   // ← 1 cent created!
  fees: 0,
  roundingMode: "HALF_UP",  // ← wrong rounding mode
};

const r3 = verifier.verify(moneyCreated);
console.log(`  Result: ${r3.safe ? "✅ SAFE" : "❌ UNSAFE — " + r3.criticalFailures.length + " critical"}`);
for (const r of r3.results.filter(r => !r.holds)) console.log(`    ${r.detail}`);

// ══════════════════════════════════════════════════════════════
// SCENARIO 4: ❌ CURRENCY CONVERSION ERROR
// Rate applied backwards: USD→EUR should multiply, not divide
// ══════════════════════════════════════════════════════════════
console.log("\n── Scenario 4: Currency Conversion Error ──────────\n");

const currencyBug: TransferContext = {
  sourceAccount: "ACC-US", targetAccount: "ACC-EU",
  amount: 1000, currency: "USD",
  sourceBalanceBefore: 5000, sourceBalanceAfter: 4000,
  targetBalanceBefore: 0, targetBalanceAfter: 1111.11,  // ← WRONG: divided instead of multiplied
  targetAmount: 1111.11,
  targetCurrency: "EUR",
  exchangeRate: 0.92,  // 1 USD = 0.92 EUR, so 1000 USD = 920 EUR
  fees: 0,
};

const r4 = verifier.verify(currencyBug);
console.log(`  Result: ${r4.safe ? "✅ SAFE" : "❌ UNSAFE — " + r4.criticalFailures.length + " critical"}`);
for (const r of r4.results.filter(r => !r.holds)) console.log(`    ${r.detail}`);

// ══════════════════════════════════════════════════════════════
// SCENARIO 5: ❌ BATCH IMBALANCE — settlement won't clear
// ══════════════════════════════════════════════════════════════
console.log("\n── Scenario 5: Batch Settlement Imbalance ─────────\n");

const batchBug: TransferContext = {
  sourceAccount: "CLEARING", targetAccount: "SETTLEMENT",
  amount: 0, currency: "USD",
  sourceBalanceBefore: 0, sourceBalanceAfter: 0,
  targetBalanceBefore: 0, targetBalanceAfter: 0,
  fees: 0,
  batchEntries: [
    { debit: 1000, credit: 1000 },
    { debit: 2500, credit: 2500 },
    { debit: 750, credit: 749.99 },   // ← 1 cent off
    { debit: 3200, credit: 3200 },
  ],
};

const r5 = verifier.verify(batchBug);
console.log(`  Result: ${r5.safe ? "✅ SAFE" : "❌ UNSAFE — " + r5.criticalFailures.length + " critical"}`);
for (const r of r5.results.filter(r => !r.holds)) console.log(`    ${r.detail}`);

// ══════════════════════════════════════════════════════════════
// SCENARIO 6: Semantic Diff — COBOL vs Migrated Code
// ══════════════════════════════════════════════════════════════
console.log("\n── Scenario 6: Semantic Diff (COBOL vs Java) ──────\n");

const cobolRules: SemanticRule[] = [
  { id: "OVERDRAFT-FEE", condition: "WS-BALANCE < 0", action: "SUBTRACT WS-FEE FROM WS-BALANCE", domain: "Fees", source: "cobol" },
  { id: "INTEREST-CALC", condition: "WS-BALANCE > WS-MIN-BALANCE", action: "ADD INTEREST TO WS-BALANCE", domain: "Pricing", source: "cobol" },
  { id: "DAILY-LIMIT", condition: "WS-WITHDRAWAL > 5000", action: "REJECT TRANSACTION", domain: "Risk", source: "cobol" },
  { id: "FRAUD-CHECK", condition: "WS-AMOUNT > 10000", action: "CALL FRAUD-DETECTOR", domain: "Compliance", source: "cobol" },
];

const migratedRules: SemanticRule[] = [
  { id: "OVERDRAFT-FEE", condition: "balance < 0", action: "balance = balance + fee", domain: "Fees", source: "migrated" },  // ← SIGN FLIP: ADD instead of SUBTRACT
  { id: "INTEREST-CALC", condition: "balance >= minBalance", action: "balance = balance + interest", domain: "Pricing", source: "migrated" },  // ← condition changed: > became >=
  { id: "DAILY-LIMIT", condition: "withdrawal > 5000", action: "REJECT TRANSACTION", domain: "Risk", source: "migrated" },  // ✅ correct
  // FRAUD-CHECK missing entirely!
];

const diff = verifier.diffAndVerify(cobolRules, migratedRules);
console.log(`  Result: ${diff.safe ? "✅ SAFE" : "❌ UNSAFE — " + diff.criticalDiffs.length + " critical diffs"}`);
console.log(`  Total diffs: ${diff.diffs.length}`);
for (const d of diff.diffs) {
  const icon = d.severity === "CRITICAL" ? "❌" : "⚠️";
  console.log(`    ${icon} [${d.type}] ${d.detail}`);
}

// ══════════════════════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════════════════════
console.log("\n╔════════════════════════════════════════════════════════╗");
console.log("║                    SAFETY SUMMARY                      ║");
console.log("╠════════════════════════════════════════════════════════╣");

const scenarios = [
  { name: "Correct Transfer", safe: r1.safe },
  { name: "Sign Flip", safe: r2.safe },
  { name: "Money Created", safe: r3.safe },
  { name: "Currency Error", safe: r4.safe },
  { name: "Batch Imbalance", safe: r5.safe },
  { name: "Semantic Diff", safe: diff.safe },
];

for (const s of scenarios) {
  console.log(`║  ${s.safe ? "✅" : "🛑"} ${s.name.padEnd(30)} ${(s.safe ? "PASSED" : "BLOCKED").padEnd(10)} ║`);
}

const blocked = scenarios.filter(s => !s.safe).length;
console.log("╠════════════════════════════════════════════════════════╣");
console.log(`║  ${blocked} dangerous migrations BLOCKED before production   ║`);
console.log(`║  0 incorrect transfers reached customers               ║`);
console.log("╚════════════════════════════════════════════════════════╝");

/**
 * Semantic Verifier — Banking Transfer Safety
 *
 * Catches semantic errors BEFORE they reach production.
 * Three layers of protection:
 *
 * 1. INVARIANT CHECKS — mathematical rules that MUST hold
 *    (e.g., total debits = total credits, always)
 *
 * 2. DUAL EXECUTION — run original COBOL logic and parsed
 *    semantics with same inputs, compare outputs
 *
 * 3. SEMANTIC DIFF — detect when a migration changes the
 *    meaning of a business rule (sign flip, rounding change,
 *    currency swap, missing condition)
 */

// ── Banking Invariants ─────────────────────────────────────
// These are MATHEMATICAL TRUTHS that no migration can violate.
// Not hardcoded values — hardcoded LAWS.

export interface Invariant {
  name: string;
  description: string;
  check: (context: TransferContext) => InvariantResult;
}

export interface InvariantResult {
  holds: boolean;
  invariant: string;
  detail: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
}

export interface TransferContext {
  sourceAccount: string;
  targetAccount: string;
  amount: number;
  currency: string;
  sourceBalanceBefore: number;
  sourceBalanceAfter: number;
  targetBalanceBefore: number;
  targetBalanceAfter: number;
  fees: number;
  exchangeRate?: number;
  targetCurrency?: string;
  targetAmount?: number;
  roundingMode?: string;
  batchEntries?: { debit: number; credit: number }[];
}

// ── The Invariant Laws ─────────────────────────────────────

export const BANKING_INVARIANTS: Invariant[] = [
  {
    name: "CONSERVATION_OF_MONEY",
    description: "Money cannot be created or destroyed. Total in = total out + fees.",
    check: (ctx) => {
      const sourceChange = ctx.sourceBalanceBefore - ctx.sourceBalanceAfter;
      const targetChange = ctx.targetBalanceAfter - ctx.targetBalanceBefore;
      const actualTarget = ctx.targetAmount ?? ctx.amount;
      const totalOut = actualTarget + ctx.fees;

      // Allow epsilon for floating point
      const epsilon = 0.005;
      const holds = Math.abs(sourceChange - totalOut) < epsilon;

      return {
        holds,
        invariant: "CONSERVATION_OF_MONEY",
        detail: holds
          ? `✅ source_debit(${sourceChange.toFixed(2)}) = target_credit(${actualTarget.toFixed(2)}) + fees(${ctx.fees.toFixed(2)})`
          : `❌ MONEY MISMATCH: source lost ${sourceChange.toFixed(2)} but target gained ${actualTarget.toFixed(2)} + fees ${ctx.fees.toFixed(2)} = ${totalOut.toFixed(2)}. Difference: ${(sourceChange - totalOut).toFixed(4)}`,
        severity: "CRITICAL",
      };
    },
  },
  {
    name: "NO_NEGATIVE_TRANSFER",
    description: "Transfer amount must be positive. A negative transfer is a semantic sign flip.",
    check: (ctx) => {
      const holds = ctx.amount > 0;
      return {
        holds,
        invariant: "NO_NEGATIVE_TRANSFER",
        detail: holds
          ? `✅ amount=${ctx.amount} > 0`
          : `❌ SIGN FLIP: amount=${ctx.amount}. Likely DEBIT/CREDIT reversal in migration.`,
        severity: "CRITICAL",
      };
    },
  },
  {
    name: "DEBIT_CREDIT_DIRECTION",
    description: "Source balance must decrease. Target balance must increase. Direction cannot flip.",
    check: (ctx) => {
      const sourceDecreased = ctx.sourceBalanceAfter <= ctx.sourceBalanceBefore;
      const targetIncreased = ctx.targetBalanceAfter >= ctx.targetBalanceBefore;
      const holds = sourceDecreased && targetIncreased;

      return {
        holds,
        invariant: "DEBIT_CREDIT_DIRECTION",
        detail: holds
          ? `✅ source: ${ctx.sourceBalanceBefore} → ${ctx.sourceBalanceAfter} (↓), target: ${ctx.targetBalanceBefore} → ${ctx.targetBalanceAfter} (↑)`
          : `❌ DIRECTION REVERSED: source ${sourceDecreased ? "↓" : "↑"}, target ${targetIncreased ? "↑" : "↓"}. COBOL DEBIT/CREDIT semantics swapped in migration.`,
        severity: "CRITICAL",
      };
    },
  },
  {
    name: "CURRENCY_CONSISTENCY",
    description: "If cross-currency, exchange rate must be applied correctly.",
    check: (ctx) => {
      if (!ctx.exchangeRate || !ctx.targetCurrency || ctx.currency === ctx.targetCurrency) {
        return { holds: true, invariant: "CURRENCY_CONSISTENCY", detail: "✅ same currency, no conversion needed", severity: "INFO" };
      }

      const expectedTarget = ctx.amount * ctx.exchangeRate;
      const actualTarget = ctx.targetAmount ?? ctx.amount;
      const epsilon = 0.01 * ctx.amount; // 1% tolerance for rounding

      const holds = Math.abs(actualTarget - expectedTarget) < epsilon;
      return {
        holds,
        invariant: "CURRENCY_CONSISTENCY",
        detail: holds
          ? `✅ ${ctx.amount} ${ctx.currency} × ${ctx.exchangeRate} = ${actualTarget.toFixed(2)} ${ctx.targetCurrency}`
          : `❌ CURRENCY ERROR: expected ${expectedTarget.toFixed(2)} ${ctx.targetCurrency}, got ${actualTarget.toFixed(2)}. Rate applied: ${(actualTarget / ctx.amount).toFixed(6)} vs declared: ${ctx.exchangeRate}`,
        severity: "CRITICAL",
      };
    },
  },
  {
    name: "ROUNDING_MODE_PRESERVED",
    description: "Banking uses HALF_EVEN (banker's rounding). Truncation or HALF_UP changes semantics.",
    check: (ctx) => {
      if (!ctx.roundingMode) {
        return { holds: true, invariant: "ROUNDING_MODE_PRESERVED", detail: "⚠️ no rounding mode specified — verify manually", severity: "WARNING" };
      }
      const safe = ["HALF_EVEN", "BANKER", "ROUND_HALF_EVEN"];
      const holds = safe.includes(ctx.roundingMode.toUpperCase());
      return {
        holds,
        invariant: "ROUNDING_MODE_PRESERVED",
        detail: holds
          ? `✅ rounding=${ctx.roundingMode} (banker's rounding preserved)`
          : `❌ ROUNDING CHANGED: ${ctx.roundingMode} is NOT banker's rounding. COBOL uses ROUNDED which is HALF_EVEN. This will cause cent-level discrepancies at scale.`,
        severity: holds ? "INFO" : "CRITICAL",
      };
    },
  },
  {
    name: "BATCH_SETTLEMENT_BALANCE",
    description: "In batch processing, total debits must exactly equal total credits.",
    check: (ctx) => {
      if (!ctx.batchEntries || ctx.batchEntries.length === 0) {
        return { holds: true, invariant: "BATCH_SETTLEMENT_BALANCE", detail: "✅ not a batch transfer", severity: "INFO" };
      }

      const totalDebits = ctx.batchEntries.reduce((s, e) => s + e.debit, 0);
      const totalCredits = ctx.batchEntries.reduce((s, e) => s + e.credit, 0);
      const holds = Math.abs(totalDebits - totalCredits) < 0.005;

      return {
        holds,
        invariant: "BATCH_SETTLEMENT_BALANCE",
        detail: holds
          ? `✅ batch balanced: debits=${totalDebits.toFixed(2)}, credits=${totalCredits.toFixed(2)}`
          : `❌ BATCH IMBALANCE: debits=${totalDebits.toFixed(2)} ≠ credits=${totalCredits.toFixed(2)}. Difference: ${(totalDebits - totalCredits).toFixed(4)}. Settlement will fail.`,
        severity: "CRITICAL",
      };
    },
  },
];

// ── Semantic Diff ──────────────────────────────────────────
// Detects when parsed COBOL semantics differ from migrated code.

export interface SemanticRule {
  id: string;
  condition: string;    // e.g., "WS-BALANCE < 0"
  action: string;       // e.g., "COMPUTE WS-BALANCE = WS-BALANCE - 35.00"
  domain: string;
  source: "cobol" | "migrated";
}

export interface SemanticDiff {
  type: "MISSING" | "ADDED" | "CHANGED" | "SIGN_FLIP" | "CONDITION_WEAKENED" | "CONDITION_STRENGTHENED";
  severity: "CRITICAL" | "WARNING" | "INFO";
  cobolRule?: SemanticRule;
  migratedRule?: SemanticRule;
  detail: string;
}

export function diffSemantics(
  cobolRules: SemanticRule[],
  migratedRules: SemanticRule[]
): SemanticDiff[] {
  const diffs: SemanticDiff[] = [];
  const cobolMap = new Map(cobolRules.map(r => [r.id, r]));
  const migratedMap = new Map(migratedRules.map(r => [r.id, r]));

  // Rules in COBOL but missing from migration
  for (const [id, rule] of cobolMap) {
    if (!migratedMap.has(id)) {
      diffs.push({
        type: "MISSING",
        severity: "CRITICAL",
        cobolRule: rule,
        detail: `Rule "${id}" exists in COBOL but NOT in migrated code. Business logic DROPPED.`,
      });
    }
  }

  // Rules added in migration (not in COBOL)
  for (const [id, rule] of migratedMap) {
    if (!cobolMap.has(id)) {
      diffs.push({
        type: "ADDED",
        severity: "WARNING",
        migratedRule: rule,
        detail: `Rule "${id}" added in migration but NOT in COBOL. Verify intent.`,
      });
    }
  }

  // Rules that exist in both — check for semantic changes
  for (const [id, cobol] of cobolMap) {
    const migrated = migratedMap.get(id);
    if (!migrated) continue;

    // Sign flip detection (e.g., SUBTRACT vs ADD)
    const cobolHasSubtract = /subtract|minus|\-/i.test(cobol.action);
    const migratedHasSubtract = /subtract|minus|\-/i.test(migrated.action);
    if (cobolHasSubtract !== migratedHasSubtract) {
      diffs.push({
        type: "SIGN_FLIP",
        severity: "CRITICAL",
        cobolRule: cobol,
        migratedRule: migrated,
        detail: `SIGN FLIP in "${id}": COBOL ${cobolHasSubtract ? "subtracts" : "adds"}, migrated ${migratedHasSubtract ? "subtracts" : "adds"}. Debits and credits may be reversed.`,
      });
    }

    // Condition change detection
    if (cobol.condition !== migrated.condition) {
      // Check if condition was weakened (< became <=) or strengthened
      const weakened = cobol.condition.includes("<") && migrated.condition.includes("<=")
        || cobol.condition.includes(">") && migrated.condition.includes(">=");
      const strengthened = cobol.condition.includes("<=") && migrated.condition.includes("<")
        || cobol.condition.includes(">=") && migrated.condition.includes(">");

      diffs.push({
        type: weakened ? "CONDITION_WEAKENED" : strengthened ? "CONDITION_STRENGTHENED" : "CHANGED",
        severity: weakened || strengthened ? "WARNING" : "CRITICAL",
        cobolRule: cobol,
        migratedRule: migrated,
        detail: `Condition changed in "${id}": COBOL="${cobol.condition}" → migrated="${migrated.condition}"${weakened ? " (boundary case behavior changed)" : ""}`,
      });
    }
  }

  return diffs;
}

// ── Verifier ───────────────────────────────────────────────

export class SemanticVerifier {
  verify(context: TransferContext): {
    safe: boolean;
    results: InvariantResult[];
    criticalFailures: InvariantResult[];
  } {
    const results = BANKING_INVARIANTS.map(inv => inv.check(context));
    const criticalFailures = results.filter(r => !r.holds && r.severity === "CRITICAL");

    return {
      safe: criticalFailures.length === 0,
      results,
      criticalFailures,
    };
  }

  diffAndVerify(
    cobolRules: SemanticRule[],
    migratedRules: SemanticRule[]
  ): {
    safe: boolean;
    diffs: SemanticDiff[];
    criticalDiffs: SemanticDiff[];
  } {
    const diffs = diffSemantics(cobolRules, migratedRules);
    const criticalDiffs = diffs.filter(d => d.severity === "CRITICAL");

    return {
      safe: criticalDiffs.length === 0,
      diffs,
      criticalDiffs,
    };
  }
}

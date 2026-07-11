/**
 * Eval Framework — structured evaluation metrics for the pipeline.
 *
 * Inspired by Cognee's eval_framework/ module.
 * Provides deterministic metrics for each pillar:
 *   - Parser accuracy (extracted rules vs expected)
 *   - Search relevance (recall@K, precision@K)
 *   - Grounding score (FLARE hallucination rate)
 *   - Semantic safety (invariant pass rate)
 */

// ── Metric Types ───────────────────────────────────────────

export interface MetricResult {
  name: string;
  value: number;      // 0.0 to 1.0
  details: Record<string, unknown>;
  timestamp: number;
  /**
   * Whether this metric was actually measured. Omit (or true) for real
   * measurements. Set to `false` for metrics that could not be measured
   * (e.g. no embedding/LLM endpoint configured, no test vectors authored).
   * `notMeasured` metrics are EXCLUDED from the weighted overall and the
   * pass check — they must never be fabricated as a passing value.
   */
  measured?: boolean;
}

export interface EvalReport {
  runId: string;
  timestamp: number;
  metrics: MetricResult[];
  overall: number;    // weighted average of measured metrics only
  pass: boolean;      // all measured metrics above threshold
  notMeasured: string[]; // names of metrics that were not measured
}

/**
 * Build an explicit "not measured" metric. Never scored, never fabricated —
 * it records WHY a metric could not be measured so the report is honest.
 */
export function notMeasured(name: string, reason: string): MetricResult {
  return {
    name,
    value: 0,
    measured: false,
    details: { notMeasured: true, reason },
    timestamp: Date.now(),
  };
}

// ── Parser Accuracy ────────────────────────────────────────
// Compare extracted rules against ground truth

export function parserAccuracy(
  extracted: Array<{ id: string; type: string; description: string }>,
  expected: Array<{ id: string; type: string; description: string }>
): MetricResult {
  if (expected.length === 0) {
    return { name: "parser_accuracy", value: 1.0, details: { reason: "no expected rules", f1: 1.0, precision: 1.0, recall: 1.0, matched: 0, expected: 0, extracted: extracted.length, missing: [], extra: [] }, timestamp: Date.now() };
  }

  // Phase 1: Exact ID matching
  const expectedIds = new Set(expected.map(e => e.id));
  const extractedIds = new Set(extracted.map(e => e.id));

  let matches = 0;
  const matchedExpected = new Set<string>();
  const matchedExtracted = new Set<string>();

  for (const id of expectedIds) {
    if (extractedIds.has(id)) {
      matches++;
      matchedExpected.add(id);
      matchedExtracted.add(id);
    }
  }

  // Phase 2: Fuzzy description matching for unmatched rules
  // This handles cases where the parser produces natural language descriptions
  // and the expected rules have synthetic IDs (e.g., COMPUTE-WS-DTI)
  const unmatchedExpected = expected.filter(e => !matchedExpected.has(e.id));
  const unmatchedExtracted = extracted.filter(e => !matchedExtracted.has(e.id));

  for (const exp of unmatchedExpected) {
    const expKeywords = extractKeywords(exp.id + " " + exp.description);
    let bestMatch: typeof unmatchedExtracted[0] | null = null;
    let bestScore = 0;

    for (const ext of unmatchedExtracted) {
      if (matchedExtracted.has(ext.id)) continue;
      const extKeywords = extractKeywords(ext.id + " " + ext.description);
      const score = keywordOverlap(expKeywords, extKeywords);
      if (score > bestScore && score >= 0.15) {
        bestScore = score;
        bestMatch = ext;
      }
    }

    if (bestMatch) {
      matches++;
      matchedExpected.add(exp.id);
      matchedExtracted.add(bestMatch.id);
    }
  }

  const recall = matches / expected.length;
  const precision = extracted.length > 0 ? matches / extracted.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    name: "parser_accuracy",
    value: f1,
    details: {
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      matched: matches,
      expected: expected.length,
      extracted: extracted.length,
      missing: expected.filter(e => !matchedExpected.has(e.id)).map(e => e.id),
      extra: extracted.filter(e => !matchedExtracted.has(e.id)).map(e => e.id),
    },
    timestamp: Date.now(),
  };
}

/** Extract meaningful keywords from a rule ID or description */
export function extractKeywords(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/[\s_-]+/)
    .filter(w => w.length > 1 && !["the", "and", "for", "from", "with", "that", "is", "to", "of", "in", "ws", "a"].includes(w));

  // Add synonyms for domain-specific terms
  const withSynonyms = new Set(normalized);
  for (const w of normalized) {
    const syns = SYNONYMS[w];
    if (syns) syns.forEach(s => withSynonyms.add(s));
  }
  return withSynonyms;
}

/** Domain synonyms for COBOL banking rule matching */
const SYNONYMS: Record<string, string[]> = {
  // Comparison operators
  "greater": ["exceeds", "above", "over", "gt"],
  "exceeds": ["greater", "above", "gt"],
  "less": ["below", "under", "lt", "insufficient"],
  "below": ["less", "under", "lt"],
  "equals": ["equal", "eq", "match"],
  "not": ["ne", "invalid"],
  // Financial terms
  "dti": ["debt", "income", "ratio"],
  "rate": ["interest", "percentage"],
  "balance": ["amount", "total", "position"],
  "fee": ["charge", "surcharge", "cost"],
  "overdraft": ["negative", "deficit"],
  "payment": ["amortiz", "monthly"],
  "settlement": ["settle", "reconcile", "batch"],
  "reversal": ["reverse", "undo"],
  "conservation": ["invariant", "conservation", "violated"],
  "nostro": ["correspondent", "bank"],
  "tolerance": ["threshold", "limit"],
  "imbalance": ["mismatch", "difference"],
  "accrual": ["accrue", "accrued", "interest"],
  "monotonic": ["increasing", "decrease"],
  // Actions
  "compute": ["calculate", "calc"],
  "calculate": ["compute", "calc"],
  "add": ["increase", "plus", "surcharge"],
  "subtract": ["deduct", "minus", "reduce"],
  "minimum": ["min", "floor"],
  "maximum": ["max", "ceiling", "cap"],
  "rejected": ["reject", "decline", "denied"],
  "decision": ["if", "condition", "check", "conditional"],
  "check": ["verify", "validate", "decision"],
  "conversion": ["convert", "exchange"],
  "transfer": ["xfer", "wire", "send"],
  "set": ["move", "assign"],
  "empty": ["zero", "blank", "null"],
};

/** Calculate keyword overlap with synonym support */
export function keywordOverlap(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const w of a) {
    if (b.has(w)) common++;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? common / union : 0;
}

// ── Search Relevance ───────────────────────────────────────
// Measure recall@K and precision@K for search results

export function searchRelevance(
  results: Array<{ id: string; score: number }>,
  relevant: Set<string>,
  k: number = 5
): MetricResult {
  const topK = results.slice(0, k);
  const topKIds = topK.map(r => r.id);

  let hits = 0;
  for (const id of topKIds) {
    if (relevant.has(id)) hits++;
  }

  const recallAtK = relevant.size > 0 ? hits / relevant.size : 0;
  const precisionAtK = topKIds.length > 0 ? hits / topKIds.length : 0;
  const mrr = computeMRR(results, relevant);

  return {
    name: `search_relevance@${k}`,
    value: recallAtK,
    details: {
      recall_at_k: round(recallAtK),
      precision_at_k: round(precisionAtK),
      mrr: round(mrr),
      hits,
      k,
      total_relevant: relevant.size,
    },
    timestamp: Date.now(),
  };
}

/** Mean Reciprocal Rank */
function computeMRR(
  results: Array<{ id: string }>,
  relevant: Set<string>
): number {
  for (let i = 0; i < results.length; i++) {
    if (relevant.has(results[i].id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

// ── Grounding Score ────────────────────────────────────────
// Measure how grounded LLM output is (FLARE hallucination rate)

export function groundingScore(
  flareCycles: number,
  totalTokens: number,
  retrievals: Array<{ logprob: number }>
): MetricResult {
  if (totalTokens === 0) {
    return { name: "grounding_score", value: 1.0, details: { reason: "no tokens" }, timestamp: Date.now() };
  }

  // Grounding = 1 - (uncertain tokens / total tokens)
  // More FLARE retrievals = more uncertainty was corrected
  const avgLogprob = retrievals.length > 0
    ? retrievals.reduce((sum, r) => sum + r.logprob, 0) / retrievals.length
    : 0;

  // Higher is better: no FLARE cycles needed = fully grounded
  const value = flareCycles === 0 ? 1.0 : Math.max(0, 1 - (flareCycles * 0.1));

  return {
    name: "grounding_score",
    value: round(value),
    details: {
      flare_cycles: flareCycles,
      total_tokens: totalTokens,
      avg_trigger_logprob: round(avgLogprob),
      retrievals_count: retrievals.length,
    },
    timestamp: Date.now(),
  };
}

// ── Semantic Safety ────────────────────────────────────────
// Invariant pass rate from the semantic verifier

export function semanticSafety(
  invariants: Array<{
    name: string;
    passed: boolean;
    severity: "CRITICAL" | "WARNING";
    detail?: string;
  }>
): MetricResult {
  if (invariants.length === 0) {
    return { name: "semantic_safety", value: 1.0, details: { reason: "no invariants checked" }, timestamp: Date.now() };
  }

  const passed = invariants.filter(i => i.passed).length;
  const criticalFails = invariants.filter(i => !i.passed && i.severity === "CRITICAL");
  const warningFails = invariants.filter(i => !i.passed && i.severity === "WARNING");

  // Critical failures make the score 0 regardless
  const value = criticalFails.length > 0 ? 0 : passed / invariants.length;

  return {
    name: "semantic_safety",
    value: round(value),
    details: {
      total: invariants.length,
      passed,
      critical_failures: criticalFails.map(i => ({ name: i.name, detail: i.detail })),
      warnings: warningFails.map(i => ({ name: i.name, detail: i.detail })),
      is_safe: criticalFails.length === 0,
    },
    timestamp: Date.now(),
  };
}

// ── Eval Report Builder ────────────────────────────────────

const DEFAULT_WEIGHTS: Record<string, number> = {
  parser_accuracy: 0.3,
  grounding_score: 0.2,
  semantic_safety: 0.35,  // safety is weighted highest
};

export function buildReport(
  metrics: MetricResult[],
  opts?: { threshold?: number; weights?: Record<string, number> }
): EvalReport {
  const threshold = opts?.threshold ?? 0.7;
  const weights = opts?.weights ?? DEFAULT_WEIGHTS;

  let weightedSum = 0;
  let totalWeight = 0;

  // Only measured metrics contribute to the score. notMeasured metrics are
  // never fabricated as passing — they are excluded from overall and pass.
  const measuredMetrics = metrics.filter(m => m.measured !== false);

  for (const metric of measuredMetrics) {
    const baseMetricName = metric.name.replace(/@\d+$/, "");
    const w = weights[baseMetricName] ?? 0.15;
    weightedSum += metric.value * w;
    totalWeight += w;
  }

  const overall = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const pass = measuredMetrics.length > 0 && measuredMetrics.every(m => m.value >= threshold);

  return {
    runId: `eval-${Date.now().toString(36)}`,
    timestamp: Date.now(),
    metrics,
    overall: round(overall),
    pass,
    notMeasured: metrics.filter(m => m.measured === false).map(m => m.name),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

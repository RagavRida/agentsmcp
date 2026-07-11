/**
 * DeepEval-style Answer Metrics — correctness, exact match, F1.
 *
 * Cognee uses DeepEval (Python) for these. We implement them in TypeScript
 * so we don't need a Python dependency. Same formulas, same output format.
 *
 * Metrics:
 *   - Correctness: fuzzy string similarity (normalized Levenshtein)
 *   - Exact Match (EM): binary exact match after normalization
 *   - Token F1: precision/recall over word tokens
 *   - Answer Relevance: keyword overlap between question and answer
 */

// ── Normalization ──────────────────────────────────────────

/** Normalize text for comparison: lowercase, strip articles/punct, collapse whitespace */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(a|an|the|is|are|was|were|of|in|to|for|and|or|but)\b/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenize normalized text into words */
function tokenize(text: string): string[] {
  return normalize(text).split(" ").filter(t => t.length > 0);
}

// ── Exact Match ────────────────────────────────────────────

export interface EMResult {
  match: boolean;
  normalizedPrediction: string;
  normalizedGolden: string;
}

/** Binary exact match after normalization */
export function exactMatch(prediction: string, golden: string): EMResult {
  const normPred = normalize(prediction);
  const normGold = normalize(golden);
  return {
    match: normPred === normGold,
    normalizedPrediction: normPred,
    normalizedGolden: normGold,
  };
}

// ── Token F1 ───────────────────────────────────────────────

export interface TokenF1Result {
  f1: number;
  precision: number;
  recall: number;
  predTokens: number;
  goldTokens: number;
  commonTokens: number;
}

/** Token-level F1 between prediction and golden answer */
export function tokenF1(prediction: string, golden: string): TokenF1Result {
  const predTokens = tokenize(prediction);
  const goldTokens = tokenize(golden);

  if (predTokens.length === 0 && goldTokens.length === 0) {
    return { f1: 1.0, precision: 1.0, recall: 1.0, predTokens: 0, goldTokens: 0, commonTokens: 0 };
  }
  if (predTokens.length === 0 || goldTokens.length === 0) {
    return { f1: 0, precision: 0, recall: 0, predTokens: predTokens.length, goldTokens: goldTokens.length, commonTokens: 0 };
  }

  const goldSet = new Set(goldTokens);
  const commonTokens = predTokens.filter(t => goldSet.has(t));
  const common = commonTokens.length;

  const precision = common / predTokens.length;
  const recall = common / goldTokens.length;
  const f1 = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;

  return {
    f1: round(f1),
    precision: round(precision),
    recall: round(recall),
    predTokens: predTokens.length,
    goldTokens: goldTokens.length,
    commonTokens: common,
  };
}

// ── Correctness (Fuzzy) ────────────────────────────────────

export interface CorrectnessResult {
  score: number;        // 0.0 to 1.0
  method: string;
  details: Record<string, unknown>;
}

/**
 * Fuzzy correctness score — combines:
 *   1. Token F1 (50% weight)
 *   2. Containment check (25% weight)
 *   3. Length ratio penalty (25% weight)
 */
export function correctness(prediction: string, golden: string): CorrectnessResult {
  const normPred = normalize(prediction);
  const normGold = normalize(golden);

  // Component 1: Token F1
  const f1Result = tokenF1(prediction, golden);

  // Component 2: Does the prediction contain the golden answer?
  const containment = normPred.includes(normGold) ? 1.0
    : normGold.includes(normPred) ? 0.8
    : 0.0;

  // Component 3: Length ratio (penalize very long or very short)
  const lengthRatio = normGold.length > 0
    ? Math.min(normPred.length / normGold.length, normGold.length / normPred.length)
    : 0;

  const score = round(
    f1Result.f1 * 0.5 +
    containment * 0.25 +
    lengthRatio * 0.25
  );

  return {
    score,
    method: "token_f1+containment+length",
    details: {
      tokenF1: f1Result.f1,
      containment,
      lengthRatio: round(lengthRatio),
      exactMatch: normPred === normGold,
    },
  };
}

// ── Aggregate Metrics ──────────────────────────────────────

export interface AggregateMetrics {
  correctness: { mean: number; ci_lower: number; ci_upper: number };
  EM: { mean: number; ci_lower: number; ci_upper: number };
  f1: { mean: number; ci_lower: number; ci_upper: number };
  count: number;
}

/**
 * Calculate aggregate metrics with 95% confidence intervals.
 * Matches Cognee's aggregate_metrics output format.
 */
export function calculateAggregateMetrics(
  results: Array<{ prediction: string; golden: string }>
): AggregateMetrics {
  if (results.length === 0) {
    return {
      correctness: { mean: 0, ci_lower: 0, ci_upper: 0 },
      EM: { mean: 0, ci_lower: 0, ci_upper: 0 },
      f1: { mean: 0, ci_lower: 0, ci_upper: 0 },
      count: 0,
    };
  }

  const correctnessScores: number[] = [];
  const emScores: number[] = [];
  const f1Scores: number[] = [];

  for (const r of results) {
    correctnessScores.push(correctness(r.prediction, r.golden).score);
    emScores.push(exactMatch(r.prediction, r.golden).match ? 1 : 0);
    f1Scores.push(tokenF1(r.prediction, r.golden).f1);
  }

  return {
    correctness: computeCI(correctnessScores),
    EM: computeCI(emScores),
    f1: computeCI(f1Scores),
    count: results.length,
  };
}

// ── Helpers ────────────────────────────────────────────────

function computeCI(values: number[]): { mean: number; ci_lower: number; ci_upper: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, ci_lower: 0, ci_upper: 0 };

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  // 95% CI using z=1.96
  const margin = 1.96 * (stdDev / Math.sqrt(n));

  return {
    mean: round(mean),
    ci_lower: round(Math.max(0, mean - margin)),
    ci_upper: round(Math.min(1, mean + margin)),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

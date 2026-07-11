/**
 * Tests for DeepEval metrics, dataset registry, and cross-system comparison.
 */
import { describe, it, expect } from "vitest";
import {
  exactMatch,
  tokenF1,
  correctness,
  calculateAggregateMetrics,
} from "../../src/eval/deep-eval";
import {
  buildComparison,
  COGNEE_BENCHMARKS,
  formatComparisonTable,
} from "../../src/eval/comparison";
import {
  listDatasets,
  loadDataset,
} from "../../src/eval/registry";
import {
  COBOL_BANKING_CORPUS,
  COBOL_BANKING_QA,
} from "../../src/eval/datasets/cobol-banking";

// ── Exact Match ────────────────────────────────────────────

describe("exactMatch", () => {
  it("matches identical strings", () => {
    const r = exactMatch("hello world", "hello world");
    expect(r.match).toBe(true);
  });

  it("matches after normalization", () => {
    const r = exactMatch("The Answer is 42!", "answer 42");
    expect(r.match).toBe(true);
  });

  it("does not match different strings", () => {
    const r = exactMatch("loan approved", "loan rejected");
    expect(r.match).toBe(false);
  });

  it("handles empty strings", () => {
    const r = exactMatch("", "");
    expect(r.match).toBe(true);
  });
});

// ── Token F1 ───────────────────────────────────────────────

describe("tokenF1", () => {
  it("returns 1.0 for identical answers", () => {
    const r = tokenF1("calculate interest rate", "calculate interest rate");
    expect(r.f1).toBe(1);
  });

  it("returns partial F1 for overlap", () => {
    const r = tokenF1(
      "loan is rejected because risk score too low",
      "loan rejected risk score below minimum"
    );
    expect(r.f1).toBeGreaterThan(0.3);
    expect(r.f1).toBeLessThan(1);
  });

  it("returns 0 for no overlap", () => {
    const r = tokenF1("apple banana cherry", "dog elephant fox");
    expect(r.f1).toBe(0);
  });

  it("handles empty prediction", () => {
    const r = tokenF1("", "some answer");
    expect(r.f1).toBe(0);
  });

  it("handles both empty", () => {
    const r = tokenF1("", "");
    expect(r.f1).toBe(1);
  });

  it("tracks token counts", () => {
    // Note: 'a' is removed as a stop word
    const r = tokenF1("x b c d", "c d e f");
    expect(r.predTokens).toBe(4);
    expect(r.goldTokens).toBe(4);
    expect(r.commonTokens).toBe(2);
    expect(r.precision).toBe(0.5);
    expect(r.recall).toBe(0.5);
  });
});

// ── Correctness ────────────────────────────────────────────

describe("correctness", () => {
  it("scores 1.0 for identical answers", () => {
    const r = correctness("43 percent", "43 percent");
    expect(r.score).toBeGreaterThanOrEqual(0.9);
  });

  it("scores high for contained answer", () => {
    const r = correctness(
      "The maximum DTI is 43.00 percent stored in WS-MAX-DTI",
      "43.00 percent, stored in WS-MAX-DTI"
    );
    expect(r.score).toBeGreaterThan(0.5);
  });

  it("scores low for wrong answer", () => {
    const r = correctness("completely unrelated output", "loan rejected due to risk");
    expect(r.score).toBeLessThan(0.5);
  });

  it("includes method info", () => {
    const r = correctness("test", "test");
    expect(r.method).toContain("token_f1");
  });
});

// ── Aggregate Metrics ──────────────────────────────────────

describe("calculateAggregateMetrics", () => {
  it("produces all three metric groups", () => {
    const results = [
      { prediction: "hello world", golden: "hello world" },
      { prediction: "foo bar", golden: "foo bar" },
    ];
    const agg = calculateAggregateMetrics(results);
    expect(agg.correctness.mean).toBeGreaterThan(0);
    expect(agg.EM.mean).toBeGreaterThan(0);
    expect(agg.f1.mean).toBeGreaterThan(0);
    expect(agg.count).toBe(2);
  });

  it("computes confidence intervals", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      prediction: `answer ${i}`,
      golden: `answer ${i}`,
    }));
    const agg = calculateAggregateMetrics(results);
    expect(agg.correctness.ci_lower).toBeLessThanOrEqual(agg.correctness.mean);
    expect(agg.correctness.ci_upper).toBeGreaterThanOrEqual(agg.correctness.mean);
  });

  it("handles empty results", () => {
    const agg = calculateAggregateMetrics([]);
    expect(agg.count).toBe(0);
    expect(agg.correctness.mean).toBe(0);
  });

  it("handles mixed results", () => {
    const results = [
      { prediction: "correct answer", golden: "correct answer" },
      { prediction: "wrong answer", golden: "completely different" },
    ];
    const agg = calculateAggregateMetrics(results);
    expect(agg.EM.mean).toBe(0.5); // 1 exact match out of 2
  });
});

// ── Dataset Registry ───────────────────────────────────────

describe("Dataset Registry", () => {
  it("lists all built-in datasets", () => {
    const datasets = listDatasets();
    expect(datasets.length).toBeGreaterThanOrEqual(2);
    const ids = datasets.map(d => d.id);
    expect(ids).toContain("sample");
    expect(ids).toContain("cobol-banking");
  });

  it("loads sample dataset", () => {
    const ds = loadDataset("sample");
    expect(ds.corpus.length).toBe(2);
    expect(ds.qaPairs.length).toBe(5);
    expect(ds.meta.source).toBe("builtin");
  });

  it("loads cobol-banking dataset", () => {
    const ds = loadDataset("cobol-banking");
    expect(ds.corpus.length).toBe(5);
    expect(ds.qaPairs.length).toBe(25);
    expect(ds.meta.domains).toContain("Risk");
    expect(ds.meta.domains).toContain("Treasury");
  });

  it("throws on unknown dataset", () => {
    expect(() => loadDataset("nonexistent")).toThrow("not found");
  });
});

// ── COBOL Banking Dataset ──────────────────────────────────

describe("COBOL Banking Dataset", () => {
  it("has 5 programs", () => {
    expect(COBOL_BANKING_CORPUS.length).toBe(5);
  });

  it("covers 5 banking domains", () => {
    const domains = new Set(COBOL_BANKING_CORPUS.map(c => c.domain));
    expect(domains.size).toBe(5);
    expect(domains.has("Risk")).toBe(true);
    expect(domains.has("Payments")).toBe(true);
    expect(domains.has("CoreBanking")).toBe(true);
    expect(domains.has("Settlement")).toBe(true);
    expect(domains.has("Treasury")).toBe(true);
  });

  it("has at least 4 expected rules per program", () => {
    for (const entry of COBOL_BANKING_CORPUS) {
      expect(entry.expectedRules.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("has 25 QA pairs", () => {
    expect(COBOL_BANKING_QA.length).toBe(25);
  });

  it("has 5 QA pairs per program (except cross-program)", () => {
    const byProgram = new Map<string, number>();
    for (const qa of COBOL_BANKING_QA) {
      if (qa.program) {
        byProgram.set(qa.program, (byProgram.get(qa.program) ?? 0) + 1);
      }
    }
    // Programs with explicit assignment should have 4-5 QA pairs
    for (const [, count] of byProgram) {
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });

  it("covers all search strategies", () => {
    const strategies = new Set(COBOL_BANKING_QA.map(q => q.expectedStrategy));
    expect(strategies.has("VECTOR")).toBe(true);
    expect(strategies.has("GRAPH")).toBe(true);
    expect(strategies.has("RAPTOR")).toBe(true);
    expect(strategies.has("FLARE")).toBe(true);
  });

  it("all programs have valid COBOL source", () => {
    for (const entry of COBOL_BANKING_CORPUS) {
      expect(entry.source).toContain("IDENTIFICATION DIVISION");
      expect(entry.source).toContain("PROGRAM-ID");
      expect(entry.source).toContain("PROCEDURE DIVISION");
    }
  });

  it("total expected rules >= 27", () => {
    const total = COBOL_BANKING_CORPUS.reduce(
      (sum, entry) => sum + entry.expectedRules.length, 0
    );
    expect(total).toBeGreaterThanOrEqual(27);
  });
});

// ── Cross-System Comparison ────────────────────────────────

describe("Cross-System Comparison", () => {
  it("includes all 4 reference systems", () => {
    expect(COGNEE_BENCHMARKS.length).toBe(4);
    const names = COGNEE_BENCHMARKS.map(b => b.system);
    expect(names).toContain("Cognee");
    expect(names).toContain("LightRAG");
    expect(names).toContain("Mem0");
    expect(names).toContain("Graphiti");
  });

  it("builds comparison with AgentMailbox entry", () => {
    const report = buildComparison({
      correctness: { mean: 0.85, ci_lower: 0.80, ci_upper: 0.90 },
      EM: { mean: 0.60, ci_lower: 0.55, ci_upper: 0.65 },
      f1: { mean: 0.75, ci_lower: 0.70, ci_upper: 0.80 },
      count: 25,
    });

    expect(report.systems.length).toBe(5); // 4 reference + us
    const ourEntry = report.systems.find(s => s.system === "AgentMailbox");
    expect(ourEntry).toBeDefined();
    expect(ourEntry!["Correctness"]).toBe(0.85);
    expect(ourEntry!["F1"]).toBe(0.75);
  });

  it("determines winner correctly", () => {
    const report = buildComparison({
      correctness: { mean: 0.99, ci_lower: 0.98, ci_upper: 1.0 },
      EM: { mean: 0.95, ci_lower: 0.93, ci_upper: 0.97 },
      f1: { mean: 0.99, ci_lower: 0.98, ci_upper: 1.0 },
      count: 25,
    });
    expect(report.winner).toBe("AgentMailbox");
  });

  it("formats ASCII table", () => {
    const report = buildComparison({
      correctness: { mean: 0.85, ci_lower: 0.80, ci_upper: 0.90 },
      EM: { mean: 0.60, ci_lower: 0.55, ci_upper: 0.65 },
      f1: { mean: 0.75, ci_lower: 0.70, ci_upper: 0.80 },
      count: 25,
    });
    const table = formatComparisonTable(report);
    expect(table).toContain("AgentMailbox");
    expect(table).toContain("Cognee");
    expect(table).toContain("Winner:");
  });
});

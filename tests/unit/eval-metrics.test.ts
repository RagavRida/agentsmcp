/**
 * Unit tests for Eval Framework — parser accuracy, search relevance, grounding, semantic safety.
 */
import { describe, it, expect } from "vitest";
import {
  parserAccuracy, searchRelevance, groundingScore,
  semanticSafety, buildReport,
} from "../../src/eval";

describe("Eval Metrics", () => {
  // ── Parser Accuracy ─────────────────────────────

  describe("parserAccuracy", () => {
    it("perfect match returns F1 = 1.0", () => {
      const nodes = [
        { id: "A", type: "T", description: "d" },
        { id: "B", type: "T", description: "d" },
      ];
      const result = parserAccuracy(nodes, nodes);
      expect(result.value).toBe(1);
      expect(result.details.precision).toBe(1);
      expect(result.details.recall).toBe(1);
    });

    it("no matches returns F1 = 0", () => {
      const extracted = [{ id: "A", type: "T", description: "d" }];
      const expected = [{ id: "B", type: "T", description: "d" }];
      const result = parserAccuracy(extracted, expected);
      expect(result.value).toBe(0);
    });

    it("partial match returns correct F1", () => {
      const extracted = [
        { id: "A", type: "T", description: "d" },
        { id: "B", type: "T", description: "d" },
        { id: "C", type: "T", description: "d" }, // extra
      ];
      const expected = [
        { id: "A", type: "T", description: "d" },
        { id: "B", type: "T", description: "d" },
        { id: "D", type: "T", description: "d" }, // missing
      ];
      const result = parserAccuracy(extracted, expected);
      // Precision = 2/3, Recall = 2/3, F1 = 2/3
      expect(result.value).toBeCloseTo(0.6667, 3);
      expect(result.details.missing).toContain("D");
      expect(result.details.extra).toContain("C");
    });

    it("empty expected returns 1.0", () => {
      const result = parserAccuracy([], []);
      expect(result.value).toBe(1);
    });
  });

  // ── Search Relevance ────────────────────────────

  describe("searchRelevance", () => {
    it("all relevant in top-K", () => {
      const results = [
        { id: "A", score: 0.9 },
        { id: "B", score: 0.8 },
      ];
      const relevant = new Set(["A", "B"]);
      const metric = searchRelevance(results, relevant, 5);
      expect(metric.value).toBe(1);
    });

    it("none relevant returns 0", () => {
      const results = [
        { id: "X", score: 0.9 },
        { id: "Y", score: 0.8 },
      ];
      const relevant = new Set(["A", "B"]);
      const metric = searchRelevance(results, relevant, 5);
      expect(metric.value).toBe(0);
    });

    it("computes MRR correctly", () => {
      const results = [
        { id: "X", score: 0.9 },
        { id: "A", score: 0.8 }, // first relevant at position 2
      ];
      const relevant = new Set(["A"]);
      const metric = searchRelevance(results, relevant, 5);
      expect(metric.details.mrr).toBe(0.5);
    });
  });

  // ── Grounding Score ─────────────────────────────

  describe("groundingScore", () => {
    it("no FLARE cycles = fully grounded", () => {
      const metric = groundingScore(0, 100, []);
      expect(metric.value).toBe(1);
    });

    it("more FLARE cycles = lower score", () => {
      const metric = groundingScore(3, 100, [
        { logprob: -0.5 }, { logprob: -0.3 }, { logprob: -0.4 },
      ]);
      expect(metric.value).toBeLessThan(1);
      expect(metric.value).toBeGreaterThan(0);
    });
  });

  // ── Semantic Safety ─────────────────────────────

  describe("semanticSafety", () => {
    it("all passed = 1.0", () => {
      const invariants = [
        { name: "money_conservation", passed: true, severity: "CRITICAL" as const },
        { name: "sign_check", passed: true, severity: "CRITICAL" as const },
      ];
      const metric = semanticSafety(invariants);
      expect(metric.value).toBe(1);
    });

    it("critical failure = 0", () => {
      const invariants = [
        { name: "money_conservation", passed: false, severity: "CRITICAL" as const, detail: "diff: 0.01" },
        { name: "rounding", passed: true, severity: "WARNING" as const },
      ];
      const metric = semanticSafety(invariants);
      expect(metric.value).toBe(0);
      expect(metric.details.is_safe).toBe(false);
    });

    it("warning only still passes", () => {
      const invariants = [
        { name: "ok", passed: true, severity: "CRITICAL" as const },
        { name: "warn", passed: false, severity: "WARNING" as const, detail: "minor" },
      ];
      const metric = semanticSafety(invariants);
      expect(metric.value).toBeGreaterThan(0);
      expect(metric.details.is_safe).toBe(true);
    });
  });

  // ── Report Builder ──────────────────────────────

  describe("buildReport", () => {
    it("builds a report with overall score", () => {
      const metrics = [
        parserAccuracy(
          [{ id: "A", type: "T", description: "d" }],
          [{ id: "A", type: "T", description: "d" }]
        ),
        semanticSafety([
          { name: "test", passed: true, severity: "CRITICAL" as const },
        ]),
      ];

      const report = buildReport(metrics);
      expect(report.runId).toContain("eval-");
      expect(report.overall).toBeGreaterThan(0);
      expect(report.pass).toBe(true);
      expect(report.metrics).toHaveLength(2);
    });

    it("fails when metric below threshold", () => {
      const metrics = [
        parserAccuracy([], [{ id: "A", type: "T", description: "d" }]),
      ];
      const report = buildReport(metrics, { threshold: 0.5 });
      expect(report.pass).toBe(false);
    });
  });
});

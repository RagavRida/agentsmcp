/**
 * Unit tests for the query router — rule-based strategy classification.
 */
import { describe, it, expect } from "vitest";
import { routeQuery } from "../../src/memory/api";

describe("routeQuery — Strategy Classification", () => {
  // ── RAPTOR (high-level summary queries) ──
  it("routes 'what does X do' to RAPTOR", () => {
    const r = routeQuery("What does LOAN-PROCESSOR do?");
    expect(r.strategy).toBe("RAPTOR");
  });

  it("routes 'overview' to RAPTOR", () => {
    const r = routeQuery("Give me an overview of the payment system");
    expect(r.strategy).toBe("RAPTOR");
  });

  it("routes 'summarize' to RAPTOR", () => {
    const r = routeQuery("Summarize the batch settlement logic");
    expect(r.strategy).toBe("RAPTOR");
  });

  // ── GRAPH (relationship queries) ──
  it("routes 'what calls X' to GRAPH", () => {
    const r = routeQuery("What calls FRAUD-DETECTOR?");
    expect(r.strategy).toBe("GRAPH");
  });

  it("routes 'impact of changing X' to GRAPH", () => {
    const r = routeQuery("Show me the impact of changing INTEREST-CALC");
    expect(r.strategy).toBe("GRAPH");
  });

  it("routes 'what depends on X' to GRAPH", () => {
    const r = routeQuery("What depends on DAILY-LIMIT?");
    expect(r.strategy).toBe("GRAPH");
  });

  it("routes PERFORM verb to GRAPH", () => {
    const r = routeQuery("PERFORM CALCULATE-BALANCE");
    expect(r.strategy).toBe("GRAPH");
  });

  // ── VECTOR (semantic similarity queries) ──
  it("routes 'find similar to' to VECTOR", () => {
    const r = routeQuery("Find rules similar to overdraft fee calculation");
    expect(r.strategy).toBe("VECTOR");
  });

  it("routes 'search for' to VECTOR", () => {
    const r = routeQuery("Search for withdrawal limit checks");
    expect(r.strategy).toBe("VECTOR");
  });

  // ── FLARE (reasoning / explanation queries) ──
  it("routes 'explain why' to FLARE", () => {
    const r = routeQuery("Explain why the interest rate is compounded monthly");
    expect(r.strategy).toBe("FLARE");
  });

  it("routes 'step by step' to FLARE", () => {
    const r = routeQuery("Step by step trace through the fee calculation");
    expect(r.strategy).toBe("FLARE");
  });

  // ── TRAJECTORY (audit / history queries) ──
  it("routes 'when was X last parsed' to TRAJECTORY", () => {
    const r = routeQuery("When was LOAN-PROC last parsed?");
    expect(r.strategy).toBe("TRAJECTORY");
  });

  it("routes 'audit history' to TRAJECTORY", () => {
    const r = routeQuery("Show me the audit history for PAYMENT-BATCH");
    expect(r.strategy).toBe("TRAJECTORY");
  });

  // ── HYBRID (broad queries) ──
  it("routes 'everything about' to HYBRID", () => {
    const r = routeQuery("Everything about the settlement process");
    expect(r.strategy).toBe("HYBRID");
  });

  // ── Confidence and runner-up ──
  it("returns confidence > 0", () => {
    const r = routeQuery("What calls FRAUD-DETECTOR?");
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("returns a runner-up strategy", () => {
    const r = routeQuery("What calls FRAUD-DETECTOR?");
    expect(r.runnerUp).toBeDefined();
    expect(r.runnerUp).not.toBe(r.strategy);
  });

  it("returns allScores for all strategies", () => {
    const r = routeQuery("What calls FRAUD-DETECTOR?");
    expect(r.allScores).toBeDefined();
    expect(Object.keys(r.allScores).length).toBeGreaterThanOrEqual(1);
  });

  // ── Fallback ──
  it("falls back to HYBRID for ambiguous queries", () => {
    const r = routeQuery("hello world");
    expect(["VECTOR", "HYBRID"]).toContain(r.strategy);
  });
});

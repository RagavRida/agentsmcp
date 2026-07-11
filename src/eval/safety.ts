/**
 * HONEST semantic-safety evaluation.
 *
 * Replaces the previous stub, which regex-grepped the source for COMPUTE/ADD/…
 * and unconditionally pushed `passed: true` (a rubber stamp). This runs the
 * REAL banking `SemanticVerifier` over hand-authored `TransferContext` vectors
 * attached to each corpus program.
 *
 * Programs WITHOUT vectors contribute nothing (they are listed as notMeasured,
 * never fake-passed). If NO program has vectors, the whole metric is
 * notMeasured. The transfer invariants are transfer/settlement-specific, so
 * only programs that genuinely model a transfer should carry vectors.
 */

import { SemanticVerifier, type TransferContext } from "../verification/semantic-verifier";
import { semanticSafety, notMeasured, type MetricResult } from "./index";
import type { CorpusEntry } from "./runner";

export interface SafetyRow {
  program: string;
  measured: boolean;
  passed: boolean;
  criticalFailures: string[];
}

export interface SafetyEvalResult {
  metric: MetricResult;
  results: SafetyRow[];
}

type ScoredInvariant = {
  name: string;
  passed: boolean;
  severity: "CRITICAL" | "WARNING";
  detail?: string;
};

export function evaluateSafety(corpus: CorpusEntry[]): SafetyEvalResult {
  const verifier = new SemanticVerifier();
  const invariants: ScoredInvariant[] = [];
  const results: SafetyRow[] = [];
  const notMeasuredPrograms: string[] = [];
  let programsWithVectors = 0;

  for (const entry of corpus) {
    const vectors: TransferContext[] = entry.safetyVectors ?? [];
    if (vectors.length === 0) {
      notMeasuredPrograms.push(entry.programId);
      results.push({
        program: entry.programId,
        measured: false,
        passed: false,
        criticalFailures: [],
      });
      continue;
    }
    programsWithVectors++;

    const criticalFailures: string[] = [];
    vectors.forEach((ctx, i) => {
      const { results: invResults } = verifier.verify(ctx);
      for (const r of invResults) {
        if (r.severity === "INFO") continue; // INFO invariants don't gate safety
        invariants.push({
          name: `${entry.programId}[${i}]:${r.invariant}`,
          passed: r.holds,
          severity: r.severity,
          detail: r.detail,
        });
        if (!r.holds && r.severity === "CRITICAL") criticalFailures.push(r.invariant);
      }
    });

    results.push({
      program: entry.programId,
      measured: true,
      passed: criticalFailures.length === 0,
      criticalFailures,
    });
  }

  if (programsWithVectors === 0) {
    return {
      metric: notMeasured(
        "semantic_safety",
        "no TransferContext safety vectors authored for any corpus program",
      ),
      results,
    };
  }

  const metric = semanticSafety(invariants);
  (metric.details as Record<string, unknown>).notMeasuredPrograms = notMeasuredPrograms;
  return { metric, results };
}

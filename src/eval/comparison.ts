/**
 * Cross-System Benchmark Comparison — AgentMailbox vs Cognee vs others.
 *
 * Loads benchmark results from multiple systems and produces a
 * comparison table in the same format as Cognee's
 * benchmark_summary_competition.json.
 */

import * as fs from "fs";
import * as path from "path";
import type { AggregateMetrics } from "./deep-eval";

// ── Types ──────────────────────────────────────────────────

export interface SystemBenchmark {
  system: string;
  "Correctness": number;
  "Correctness Error": [number, number];
  "EM": number;
  "EM Error": [number, number];
  "F1": number;
  "F1 Error": [number, number];
  "Parser F1"?: number;
  "Search MRR"?: number;
  "Semantic Safety"?: number;
  "Overall Score"?: number;
}

export interface ComparisonReport {
  systems: SystemBenchmark[];
  winner: string;
  winningMetric: string;
  generated: string;
}

// ── Cognee Reference Benchmarks ────────────────────────────
// From benchmark_summary_competition.json (real Cognee data)

export const COGNEE_BENCHMARKS: SystemBenchmark[] = [
  {
    system: "Cognee",
    "Correctness": 0.925,
    "Correctness Error": [0.911, 0.94],
    "EM": 0.687,
    "EM Error": [0.661, 0.717],
    "F1": 0.841,
    "F1 Error": [0.821, 0.861],
  },
  {
    system: "LightRAG",
    "Correctness": 0.955,
    "Correctness Error": [0.944, 0.965],
    "EM": 0.0,
    "EM Error": [0.0, 0.0],
    "F1": 0.09,
    "F1 Error": [0.087, 0.094],
  },
  {
    system: "Mem0",
    "Correctness": 0.722,
    "Correctness Error": [0.695, 0.747],
    "EM": 0.0,
    "EM Error": [0.0, 0.0],
    "F1": 0.12,
    "F1 Error": [0.114, 0.127],
  },
  {
    system: "Graphiti",
    "Correctness": 0.884,
    "Correctness Error": [0.802, 0.954],
    "EM": 0.46,
    "EM Error": [0.32, 0.6],
    "F1": 0.695,
    "F1 Error": [0.589, 0.797],
  },
];

// ── Comparison Builder ─────────────────────────────────────

/**
 * Build a cross-system comparison from aggregate metrics.
 */
export function buildComparison(
  agentMailboxMetrics: AggregateMetrics,
  parserF1?: number,
  searchMRR?: number,
  semanticSafety?: number,
  overallScore?: number
): ComparisonReport {
  const ourEntry: SystemBenchmark = {
    system: "AgentMailbox",
    "Correctness": agentMailboxMetrics.correctness.mean,
    "Correctness Error": [
      agentMailboxMetrics.correctness.ci_lower,
      agentMailboxMetrics.correctness.ci_upper,
    ],
    "EM": agentMailboxMetrics.EM.mean,
    "EM Error": [
      agentMailboxMetrics.EM.ci_lower,
      agentMailboxMetrics.EM.ci_upper,
    ],
    "F1": agentMailboxMetrics.f1.mean,
    "F1 Error": [
      agentMailboxMetrics.f1.ci_lower,
      agentMailboxMetrics.f1.ci_upper,
    ],
    "Parser F1": parserF1,
    "Search MRR": searchMRR,
    "Semantic Safety": semanticSafety,
    "Overall Score": overallScore,
  };

  const systems = [...COGNEE_BENCHMARKS, ourEntry];

  // Determine winner by average of Correctness + F1
  let bestScore = -1;
  let winner = "";
  for (const s of systems) {
    const avg = (s["Correctness"] + s["F1"]) / 2;
    if (avg > bestScore) {
      bestScore = avg;
      winner = s.system;
    }
  }

  return {
    systems,
    winner,
    winningMetric: "avg(Correctness + F1)",
    generated: new Date().toISOString(),
  };
}

/**
 * Save comparison to disk in Cognee-compatible JSON format.
 */
export function saveComparison(
  report: ComparisonReport,
  outputPath: string
): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(outputPath, JSON.stringify(report.systems, null, 2));
}

/**
 * Format comparison as ASCII table for terminal display.
 */
export function formatComparisonTable(report: ComparisonReport): string {
  const lines: string[] = [];
  const header = "│ System         │ Correctness │    EM │     F1 │";
  const sep    = "├────────────────┼─────────────┼───────┼────────┤";

  lines.push("┌────────────────┬─────────────┬───────┬────────┐");
  lines.push(header);
  lines.push(sep);

  for (const s of report.systems) {
    const name = s.system.padEnd(14);
    const corr = s["Correctness"].toFixed(3).padStart(11);
    const em = s["EM"].toFixed(3).padStart(5);
    const f1 = s["F1"].toFixed(3).padStart(6);
    const marker = s.system === report.winner ? " ★" : "";
    lines.push(`│ ${name} │ ${corr} │ ${em} │ ${f1} │${marker}`);
  }

  lines.push("└────────────────┴─────────────┴───────┴────────┘");
  lines.push(`Winner: ${report.winner} (by ${report.winningMetric})`);

  return lines.join("\n");
}

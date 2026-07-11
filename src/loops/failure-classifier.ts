/**
 * Failure Mode Classifier
 *
 * Given a LoopVerificationResult, classifies each failed rule
 * into a root cause so the prompt optimizer can make targeted,
 * surgical fixes instead of blind rewrites.
 *
 * Principle: "Debug like code — run evals → find failure modes
 * → targeted fixes."
 */

import type { LoopVerificationResult } from "./verifier";

export type FailureMode =
  | "HALLUCINATION"    // LLM extracted a rule that doesn't exist
  | "MISSED_PATTERN"   // LLM returned nothing for a valid rule
  | "WRONG_TYPE"       // Correct rule, wrong classification
  | "WRONG_VARS"       // Correct rule, wrong variable names
  | "REFUSED_VALID";   // LLM refused to extract a valid rule (too conservative)

export interface ClassifiedFailure {
  mode: FailureMode;
  program: string;
  /** The rule description or ID that failed */
  ruleDescription: string;
  /** Human-readable explanation of the failure */
  explanation: string;
}

export interface FailureReport {
  totalFailures: number;
  counts: Record<FailureMode, number>;
  failures: ClassifiedFailure[];
  /** Human-readable summary for loop_memory.md */
  summary: string;
  /** Suggested fix strategies per dominant failure mode */
  suggestedFixes: string[];
}

const ZERO_COUNTS: Record<FailureMode, number> = {
  HALLUCINATION: 0,
  MISSED_PATTERN: 0,
  WRONG_TYPE: 0,
  WRONG_VARS: 0,
  REFUSED_VALID: 0,
};

/**
 * Classify all failures from a LoopVerificationResult into root causes.
 */
export function classifyFailures(
  result: LoopVerificationResult
): FailureReport {
  const failures: ClassifiedFailure[] = [];
  const counts = { ...ZERO_COUNTS };

  for (const failed of result.failedRules) {
    // Missing rules → either MISSED_PATTERN or REFUSED_VALID
    for (const missing of failed.missing) {
      const mode: FailureMode = "MISSED_PATTERN";
      counts[mode]++;
      failures.push({
        mode,
        program: failed.program,
        ruleDescription: missing,
        explanation: `Expected rule "${missing}" was not extracted by the LLM for program ${failed.program}.`,
      });
    }

    // Extra rules → HALLUCINATION
    for (const extra of failed.extra) {
      const mode: FailureMode = "HALLUCINATION";
      counts[mode]++;
      failures.push({
        mode,
        program: failed.program,
        ruleDescription: extra,
        explanation: `LLM extracted rule "${extra}" which does not match any expected rule in program ${failed.program}.`,
      });
    }
  }

  const totalFailures = failures.length;
  const dominantMode = (Object.entries(counts) as [FailureMode, number][])
    .sort((a, b) => b[1] - a[1])
    .filter(([, count]) => count > 0);

  const suggestedFixes = dominantMode.map(([mode, count]) => {
    switch (mode) {
      case "HALLUCINATION":
        return `[HALLUCINATION ×${count}] Tighten <policies>: add "Do NOT extract [pattern]" rules. Raise confidence threshold.`;
      case "MISSED_PATTERN":
        return `[MISSED_PATTERN ×${count}] Add examples to <guidelines> showing the missed COBOL patterns. Lower temperature.`;
      case "WRONG_TYPE":
        return `[WRONG_TYPE ×${count}] Add disambiguation notes to <guidelines> (e.g., "EVALUATE → CONTROL_FLOW, not IF").`;
      case "WRONG_VARS":
        return `[WRONG_VARS ×${count}] Strengthen the variable extraction instruction. Add: "Use names exactly as shown."`;
      case "REFUSED_VALID":
        return `[REFUSED_VALID ×${count}] Remove overly restrictive <policies> lines that caused the refusal.`;
    }
  });

  const summary = totalFailures === 0
    ? "✅ All rules passed — no failures to classify."
    : [
        `❌ ${totalFailures} failures across ${result.failedRules.length} programs.`,
        `   Breakdown: ${dominantMode.map(([m, c]) => `${m}=${c}`).join(", ")}`,
        `   Dominant mode: ${dominantMode[0]?.[0] ?? "none"}`,
        "",
        ...suggestedFixes,
      ].join("\n");

  return {
    totalFailures,
    counts,
    failures,
    summary,
    suggestedFixes,
  };
}

/**
 * Format a failure report for appending to loop_memory.md.
 */
export function formatFailureReportForMemory(
  report: FailureReport,
  iteration: number,
  promptVersion: string
): string {
  const lines = [
    `### Iteration ${iteration} — Prompt ${promptVersion}`,
    "",
    report.summary,
    "",
  ];

  if (report.failures.length > 0) {
    lines.push("#### Failure Details");
    lines.push("");
    for (const f of report.failures.slice(0, 10)) {
      lines.push(`- **${f.mode}** in \`${f.program}\`: ${f.explanation}`);
    }
    if (report.failures.length > 10) {
      lines.push(`- ...and ${report.failures.length - 10} more.`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

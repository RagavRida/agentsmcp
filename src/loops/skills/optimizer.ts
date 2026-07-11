/**
 * Prompt Optimizer Skill — Surgical, targeted prompt mutations.
 *
 * Implements Principle 5: "Prefer modular generate-evaluate-repair loops
 * over monolithic prompts."
 *
 * Instead of asking an LLM to blindly rewrite the entire prompt, this skill
 * consumes the structured FailureReport from the verifier and applies
 * surgical patches to specific XML sections (<guidelines> and <policies>).
 *
 * Supports rollback via PromptRegistry if a mutation degrades performance.
 */

import { PromptRegistry, type PromptVersion } from "../../parser/prompt-registry";
import type { FailureReport, FailureMode } from "../failure-classifier";

export interface OptimizerContext {
  registry: PromptRegistry;
  failureReport: FailureReport;
  currentF1: number;
  targetF1: number;
}

export interface OptimizerResult {
  patched: boolean;
  action: "patched" | "rollback" | "noop";
  previousVersion: string;
  newVersion: string;
  patchSummary: string[];
}

export class PromptOptimizerSkill {
  /**
   * Run the optimizer to surgically mutate the active prompt version based
   * on observed failure modes.
   */
  async optimize(context: OptimizerContext): Promise<OptimizerResult> {
    const { registry, failureReport, currentF1, targetF1 } = context;
    const active = registry.getActive();

    if (!active) {
      throw new Error("No active prompt version found in PromptRegistry.");
    }

    // Step 1: Check if we should rollback (if current F1 degraded compared to best previous)
    const best = registry.getBestVersion();
    if (best && best.version !== active.version && (best.evalScore ?? 0) > currentF1 + 0.05) {
      const rolledBack = registry.rollback();
      if (rolledBack) {
        await registry.save();
        return {
          patched: true,
          action: "rollback",
          previousVersion: active.version,
          newVersion: rolledBack.version,
          patchSummary: [
            `🔄 Rolled back from ${active.version} (F1=${currentF1.toFixed(4)}) to ${rolledBack.version} (F1=${best.evalScore?.toFixed(4)}) due to performance degradation.`,
          ],
        };
      }
    }

    // If goal already achieved or zero failures, no patch needed
    if (currentF1 >= targetF1 || failureReport.totalFailures === 0) {
      return {
        patched: false,
        action: "noop",
        previousVersion: active.version,
        newVersion: active.version,
        patchSummary: ["✅ No prompt mutations needed (target F1 achieved or zero failures)."],
      };
    }

    // Step 2: Apply surgical patches based on dominant failure modes
    let newPrompt = active.prompt;
    const patchSummary: string[] = [];

    // Sort failure counts descending
    const sortedModes = (Object.entries(failureReport.counts) as [FailureMode, number][])
      .sort((a, b) => b[1] - a[1])
      .filter(([, count]) => count > 0);

    for (const [mode, count] of sortedModes) {
      const { prompt: patchedPrompt, summary } = this.applySurgicalPatch(
        newPrompt,
        mode,
        count,
        failureReport
      );
      if (patchedPrompt !== newPrompt) {
        newPrompt = patchedPrompt;
        patchSummary.push(summary);
      }
    }

    if (patchSummary.length === 0) {
      return {
        patched: false,
        action: "noop",
        previousVersion: active.version,
        newVersion: active.version,
        patchSummary: ["⚠️ Could not identify surgical patches for observed failures."],
      };
    }

    // Step 3: Register the newly patched prompt version
    const newVersion = PromptRegistry.bumpPatch(active.version);
    registry.register(newVersion, newPrompt, patchSummary.join(" | "));
    await registry.save();

    return {
      patched: true,
      action: "patched",
      previousVersion: active.version,
      newVersion,
      patchSummary,
    };
  }

  /**
   * Apply a surgical mutation to the prompt text based on a specific failure mode.
   */
  private applySurgicalPatch(
    prompt: string,
    mode: FailureMode,
    count: number,
    report: FailureReport
  ): { prompt: string; summary: string } {
    let mutated = prompt;
    let summary = "";

    switch (mode) {
      case "HALLUCINATION": {
        // Find example hallucinated rules to create a negative constraint
        const samples = report.failures
          .filter((f) => f.mode === "HALLUCINATION")
          .slice(0, 2)
          .map((f) => f.ruleDescription);
        const ruleText = samples.length > 0
          ? `- Do NOT extract non-business boilerplate or internal variables like "${samples[0]}" as business rules.`
          : `- Do NOT extract implicit or speculative rules that are not explicitly coded in the procedure division.`;

        mutated = this.appendToXmlSection(mutated, "policies", ruleText);
        summary = `[HALLUCINATION ×${count}] Added negative constraint to <policies>: ${ruleText}`;
        break;
      }

      case "MISSED_PATTERN": {
        const samples = report.failures
          .filter((f) => f.mode === "MISSED_PATTERN")
          .slice(0, 2)
          .map((f) => f.ruleDescription);
        const ruleText = samples.length > 0
          ? `- Ensure rules like "${samples[0]}" are explicitly extracted when present in the fragment.`
          : `- Pay close attention to multi-line COMPUTE and conditional statements to avoid missing rules.`;

        mutated = this.appendToXmlSection(mutated, "guidelines", ruleText);
        summary = `[MISSED_PATTERN ×${count}] Added extraction reminder to <guidelines>: ${ruleText}`;
        break;
      }

      case "WRONG_TYPE": {
        const ruleText = `- Double-check rule classification: EVALUATE is CONTROL_FLOW, arithmetic calculations are COMPUTE or ARITHMETIC, conditional checks are IF.`;
        mutated = this.appendToXmlSection(mutated, "guidelines", ruleText);
        summary = `[WRONG_TYPE ×${count}] Added classification disambiguation to <guidelines>.`;
        break;
      }

      case "WRONG_VARS": {
        const ruleText = `- Extract variable names EXACTLY as written in the COBOL fragment without truncating or modifying prefixes.`;
        mutated = this.appendToXmlSection(mutated, "guidelines", ruleText);
        summary = `[WRONG_VARS ×${count}] Strengthened variable extraction fidelity in <guidelines>.`;
        break;
      }

      case "REFUSED_VALID": {
        // Relax overly restrictive policies by adding a clarifying exception
        const ruleText = `- Note: Fragments containing procedural arithmetic or conditional assignments should be extracted even if they appear inside utility paragraphs.`;
        mutated = this.appendToXmlSection(mutated, "guidelines", ruleText);
        summary = `[REFUSED_VALID ×${count}] Added exception guidance for valid procedural logic.`;
        break;
      }
    }

    return { prompt: mutated, summary };
  }

  /**
   * Helper to append a line inside a specific XML tag section (e.g., <guidelines> or <policies>).
   */
  private appendToXmlSection(prompt: string, sectionTag: string, lineToAppend: string): string {
    const regex = new RegExp(`(<${sectionTag}>[\\s\\S]*?)(</${sectionTag}>)`, "i");
    if (regex.test(prompt)) {
      return prompt.replace(regex, `$1\n${lineToAppend}\n$2`);
    }
    // If tag not found, just append to the end of prompt
    return `${prompt}\n\n<${sectionTag}>\n${lineToAppend}\n</${sectionTag}>`;
  }
}

import { mkdir } from "fs/promises";
import { resolve } from "path";
import { loadDataset } from "../eval/registry";
import { getDefaultLlmFallbackPrompt, PROMPT_VERSION } from "../parser/llm-fallback";
import { PromptRegistry } from "../parser/prompt-registry";
import { LoopMemory } from "./memory";
import { PromptOptimizerSkill, OptimizerResult } from "./skills/optimizer";
import { LoopVerifier } from "./verifier";

export interface OptimizeLoopConfig {
  /** Target parser F1 score (0–1). Default 0.85 */
  targetF1?: number;
  /** Max verify→optimize iterations. Default 3 */
  maxIterations?: number;
  /** Eval dataset id. Default "sample" */
  dataset?: string;
  /** Output directory for benchmark artifacts */
  outputDir?: string;
  /** Path to prompt registry JSON */
  registryPath?: string;
  /** Starting LLM fallback confidence threshold */
  confidenceThreshold?: number;
  /** Human-readable goal for loop memory */
  goal?: string;
}

export interface OptimizeLoopIteration {
  iteration: number;
  f1Score: number;
  achieved: boolean;
  optimizerAction: "patched" | "rollback" | "noop";
  promptVersion: string;
  patchSummary: string[];
  confidenceThreshold: number;
  nextConfidenceThreshold: number;
  elapsedMs: number;
}

export interface OptimizeLoopResult {
  achieved: boolean;
  finalF1: number;
  targetF1: number;
  iterations: OptimizeLoopIteration[];
  promptVersion: string;
  loopMemoryPath: string;
  message: string;
}

export async function runOptimizeLoop(
  config: OptimizeLoopConfig = {},
): Promise<OptimizeLoopResult> {
  const targetF1 = config.targetF1 ?? 0.85;
  const maxIterations = config.maxIterations ?? 3;
  const datasetId = config.dataset ?? "sample";
  const outputDir = resolve(config.outputDir ?? ".agentmailbox/eval-loop");
  const registryPath = resolve(config.registryPath ?? ".agentmailbox/prompt-registry.json");
  const goal = config.goal ?? `Reach parser F1 >= ${targetF1} on ${datasetId}`;

  await mkdir(outputDir, { recursive: true });

  const dataset = loadDataset(datasetId);
  const registry = await ensurePromptRegistry(registryPath);
  const verifier = new LoopVerifier({ goal, targetF1, outputDir });
  const optimizer = new PromptOptimizerSkill();
  const loopMemory = new LoopMemory({
    filePath: resolve(outputDir, "loop_memory.md"),
  });

  let confidenceThreshold = config.confidenceThreshold ?? 0.7;
  const iterations: OptimizeLoopIteration[] = [];
  let finalF1 = 0;
  let achieved = false;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const start = Date.now();
    const verification = await verifier.verify(
      iteration,
      dataset.corpus,
      dataset.qaPairs,
      confidenceThreshold,
    );
    finalF1 = verification.f1Score;
    achieved = verification.achieved;

    const active = registry.getActive();
    if (active) {
      registry.recordScore(active.version, verification.f1Score);
    }

    let optimizerResult: OptimizerResult = {
      patched: false,
      action: "noop" as const,
      previousVersion: active?.version ?? PROMPT_VERSION,
      newVersion: active?.version ?? PROMPT_VERSION,
      patchSummary: ["Target F1 achieved — no prompt mutation needed."],
    };

    if (!achieved) {
      optimizerResult = await optimizer.optimize({
        registry,
        failureReport: verification.failureReport,
        currentF1: verification.f1Score,
        targetF1,
      });
      if (optimizerResult.patched || optimizerResult.action === "rollback") {
        await registry.save();
      }
    }

    const elapsedMs = Date.now() - start;
    iterations.push({
      iteration,
      f1Score: verification.f1Score,
      achieved: verification.achieved,
      optimizerAction: optimizerResult.action,
      promptVersion: optimizerResult.newVersion,
      patchSummary: optimizerResult.patchSummary,
      confidenceThreshold,
      nextConfidenceThreshold: verification.nextConfidenceThreshold,
      elapsedMs,
    });

    await loopMemory.appendIteration({
      iteration,
      goal,
      achieved: verification.achieved,
      f1Score: verification.f1Score,
      targetF1,
      confidenceThreshold,
      failedRules: verification.failedRules,
      lessonsLearned: verification.lessonsLearned,
      elapsedMs,
    });

    confidenceThreshold = verification.nextConfidenceThreshold;
    if (achieved) break;
  }

  const promptVersion = registry.getActive()?.version ?? PROMPT_VERSION;
  await registry.save();

  return {
    achieved,
    finalF1,
    targetF1,
    iterations,
    promptVersion,
    loopMemoryPath: loopMemory.path,
    message: achieved
      ? `Goal achieved: F1 ${finalF1.toFixed(4)} >= ${targetF1} after ${iterations.length} iteration(s).`
      : `Max iterations (${maxIterations}) reached. Final F1: ${finalF1.toFixed(4)}. ` +
        `See ${loopMemory.path} for lessons.`,
  };
}

async function ensurePromptRegistry(filePath: string): Promise<PromptRegistry> {
  const registry = await PromptRegistry.load(filePath);
  if (!registry.getActive()) {
    registry.register(PROMPT_VERSION, getDefaultLlmFallbackPrompt(), "Initial default prompt");
    await registry.save();
  }
  return registry;
}

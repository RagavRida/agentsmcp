import { parseCobol } from "../../parser";
import type { CorpusEntry } from "../../eval/runner";

export interface LoopExecutionContext {
  goal: string;
  iteration: number;
  confidenceThreshold: number;
  corpus: CorpusEntry[];
}

export interface ExecutionSkillResult {
  processedPrograms: number;
  errors: Array<{ program: string; error: string }>;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  artifacts: Record<string, unknown>;
}

export interface PipelineOrchestratorLike {
  execute?(context: LoopExecutionContext): Promise<ExecutionSkillResult> | ExecutionSkillResult;
  run?(context: LoopExecutionContext): Promise<ExecutionSkillResult> | ExecutionSkillResult;
  processRepository?(context: LoopExecutionContext): Promise<ExecutionSkillResult> | ExecutionSkillResult;
}

export class ExecutionSkill {
  constructor(private readonly orchestrator?: PipelineOrchestratorLike) {}

  async execute(context: LoopExecutionContext): Promise<ExecutionSkillResult> {
    if (this.orchestrator?.execute) return this.orchestrator.execute(context);
    if (this.orchestrator?.run) return this.orchestrator.run(context);
    if (this.orchestrator?.processRepository) return this.orchestrator.processRepository(context);
    return this.defaultExecute(context);
  }

  private async defaultExecute(context: LoopExecutionContext): Promise<ExecutionSkillResult> {
    const errors: ExecutionSkillResult["errors"] = [];
    let processedPrograms = 0;

    for (const entry of context.corpus) {
      try {
        parseCobol(entry.source, { filename: `${entry.programId}.CBL` });
        processedPrograms++;
      } catch (err) {
        errors.push({
          program: entry.programId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      processedPrograms,
      errors,
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      artifacts: {
        mode: "deterministic-parser",
      },
    };
  }
}

import { appendFile, mkdir, readFile } from "fs/promises";
import { dirname, resolve } from "path";

export interface LoopMemoryIteration {
  iteration: number;
  goal: string;
  achieved: boolean;
  f1Score: number;
  targetF1: number;
  confidenceThreshold: number;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  failedRules: Array<{
    program: string;
    missing: string[];
    extra: string[];
  }>;
  lessonsLearned: string[];
  elapsedMs: number;
}

export interface LoopMemoryOptions {
  filePath?: string;
}

export class LoopMemory {
  private readonly filePath: string;

  constructor(options: LoopMemoryOptions = {}) {
    this.filePath = resolve(options.filePath ?? ".agentmailbox/loop_memory.md");
  }

  async appendIteration(entry: LoopMemoryIteration): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, formatIteration(entry), "utf-8");
  }

  async read(): Promise<string> {
    try {
      return await readFile(this.filePath, "utf-8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return "";
      throw err;
    }
  }

  get path(): string {
    return this.filePath;
  }
}

function formatIteration(entry: LoopMemoryIteration): string {
  const tokenUsage = entry.tokenUsage ?? {};
  const failed = entry.failedRules.length === 0
    ? "- none\n"
    : entry.failedRules.map((rule) =>
        `- ${rule.program}: missing=[${rule.missing.join(", ")}], extra=[${rule.extra.join(", ")}]`
      ).join("\n") + "\n";
  const lessons = entry.lessonsLearned.length === 0
    ? "- none\n"
    : entry.lessonsLearned.map((lesson) => `- ${lesson}`).join("\n") + "\n";

  return [
    `\n## Loop Iteration ${entry.iteration}`,
    "",
    `- Timestamp: ${new Date().toISOString()}`,
    `- Goal: ${entry.goal}`,
    `- Achieved: ${entry.achieved ? "yes" : "no"}`,
    `- Parser F1: ${entry.f1Score.toFixed(4)} / target ${entry.targetF1.toFixed(4)}`,
    `- LLM fallback confidence threshold: ${entry.confidenceThreshold.toFixed(2)}`,
    `- Token usage: prompt=${tokenUsage.promptTokens ?? 0}, completion=${tokenUsage.completionTokens ?? 0}, total=${tokenUsage.totalTokens ?? 0}`,
    `- Elapsed: ${entry.elapsedMs}ms`,
    "",
    "### Failed Rules",
    failed.trimEnd(),
    "",
    "### Lessons Learned",
    lessons.trimEnd(),
    "",
  ].join("\n") + "\n";
}

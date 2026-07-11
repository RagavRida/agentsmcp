import { LoopMemory } from "../loops/memory";
import { PromptRegistry } from "../parser/prompt-registry";

const DEFAULT_PROMPT_REGISTRY = ".agentmailbox/prompt-registry.json";

/** Extract the most recent loop iteration block from loop memory markdown. */
export function extractRecentLoopLessons(raw: string, maxLines = 20): string[] {
  if (!raw.trim()) return [];

  const blocks = raw.split(/^## Loop Iteration /m).slice(1);
  if (blocks.length === 0) return [];

  const latest = blocks[blocks.length - 1];
  const lessonsSection = latest.split("### Lessons Learned")[1];
  if (!lessonsSection) return [];

  return lessonsSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && line !== "- none")
    .map((line) => line.slice(2))
    .slice(0, maxLines);
}

export async function loadBriefingLoopMemory(
  filePath?: string,
): Promise<{ path: string; recentLessons: string[] }> {
  const loopMemory = new LoopMemory({ filePath });
  const raw = await loopMemory.read();
  return {
    path: loopMemory.path,
    recentLessons: extractRecentLoopLessons(raw),
  };
}

export async function loadBriefingPromptVersion(
  filePath?: string,
): Promise<{
  activeVersion: string;
  evalScore?: number;
  notes?: string;
} | null> {
  const registry = await PromptRegistry.load(
    filePath ?? process.env.AGENTSMCP_PROMPT_REGISTRY ?? DEFAULT_PROMPT_REGISTRY,
  );
  const active = registry.getActive();
  if (!active) return null;

  return {
    activeVersion: active.version,
    evalScore: active.evalScore,
    notes: active.notes,
  };
}

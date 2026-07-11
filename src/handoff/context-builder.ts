import type { HandoffOptions, Message, ThreadSummary } from "../types";

export interface HandoffContext {
  [key: string]: unknown;
  version: 1;
  goal?: string;
  nextAction?: string;
  context: Record<string, unknown>;
  decisions: string[];
  openQuestions: string[];
  artifacts: Record<string, unknown>;
  sourceThreadId?: string;
  generatedAt: number;
}

export interface BuildHandoffInput {
  messages: Message[];
  sourceThreadId?: string;
  snapshot?: Record<string, unknown>;
  summary?: ThreadSummary;
  options?: HandoffOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function latestSnapshot(messages: Message[]): Record<string, unknown> {
  const latest = [...messages].sort((a, b) => a.timestamp - b.timestamp).at(-1);
  return latest?.contextSnapshot ?? {};
}

function selectContext(
  snapshot: Record<string, unknown>,
  options: HandoffOptions,
): Record<string, unknown> {
  const requested = options.includeFields ? new Set(options.includeFields) : null;
  const selected: Record<string, unknown> = {};
  const maxBytes = options.maxContextBytes ?? 16_000;
  let usedBytes = 0;

  for (const [key, value] of Object.entries(snapshot)) {
    // Routing metadata is regenerated for the actual recipient and should
    // never become application context or be copied between agents.
    if (key.startsWith("_") || key === "handoff") continue;
    if (requested && !requested.has(key)) continue;

    const size = Buffer.byteLength(JSON.stringify(value));
    if (usedBytes + size > maxBytes) continue;
    selected[key] = value;
    usedBytes += size;
  }
  return selected;
}

function inferGoal(messages: Message[]): string | undefined {
  const latest = [...messages].sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!isRecord(latest?.payload)) return undefined;
  return scalarText(latest.payload.goal) ?? scalarText(latest.payload.task);
}

/**
 * Creates a compact, generic handoff packet from existing thread state.
 * It deliberately does not inspect domain-specific fields or call an LLM;
 * callers can provide includeFields when a task requires a narrower view.
 */
export function buildHandoffContext(input: BuildHandoffInput): HandoffContext {
  const options = input.options ?? {};
  const snapshot = input.snapshot ?? latestSnapshot(input.messages);
  const summary = input.summary;

  return {
    version: 1,
    ...(options.goal ? { goal: options.goal } : inferGoal(input.messages) ? { goal: inferGoal(input.messages) } : {}),
    ...(options.nextAction ? { nextAction: options.nextAction } : {}),
    context: selectContext(snapshot, options),
    decisions: [...(summary?.decisions ?? [])],
    openQuestions: [...(summary?.openQuestions ?? [])],
    artifacts: isRecord(summary?.artifacts) ? { ...summary.artifacts } : {},
    ...(input.sourceThreadId ? { sourceThreadId: input.sourceThreadId } : {}),
    generatedAt: Date.now(),
  };
}

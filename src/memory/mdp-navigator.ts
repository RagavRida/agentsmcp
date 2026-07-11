import type { SearchResult } from "../vector/store";

export type NavigatorStrategy =
  | "VECTOR"
  | "RAPTOR"
  | "GRAPH"
  | "FLARE"
  | "TRAJECTORY"
  | "HYBRID";

export interface NavigatorToolResult {
  results: SearchResult[];
  flareResult?: unknown;
  impactResult?: unknown;
}

export interface NavigatorTool {
  strategy: NavigatorStrategy;
  description: string;
  execute: () => Promise<NavigatorToolResult>;
}

export interface NavigatorState {
  query: string;
  step: number;
  selected: NavigatorStrategy[];
  evidence: SearchResult[];
  uncertainty: number;
}

export interface NavigatorDecision {
  strategy: NavigatorStrategy;
  confidence: number;
  runnerUp: NavigatorStrategy;
  allScores: Record<NavigatorStrategy, number>;
}

export interface NavigatorResult extends NavigatorDecision {
  results: SearchResult[];
  flareResult?: unknown;
  impactResult?: unknown;
  steps: number;
}

export interface NavigatorOptions {
  maxSteps?: number;
  planner?: (state: NavigatorState, tools: NavigatorTool[]) => NavigatorStrategy | "STOP";
}

const strategies: NavigatorStrategy[] = ["VECTOR", "RAPTOR", "GRAPH", "FLARE", "TRAJECTORY", "HYBRID"];

function tokens(query: string): Set<string> {
  return new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function hasAny(values: Set<string>, candidates: string[]): boolean {
  return candidates.some((value) => values.has(value));
}

/**
 * Default bounded policy. It is intentionally deterministic and explainable,
 * but is expressed as an action policy rather than coupling recall to regexes.
 * Deployments can replace it with an LLM/MDP policy through NavigatorOptions.
 */
export function planQuery(query: string): NavigatorDecision {
  const words = tokens(query);
  const scores = Object.fromEntries(strategies.map((strategy) => [strategy, 0])) as Record<NavigatorStrategy, number>;

  if (hasAny(words, ["everything", "complete", "all"])) scores.HYBRID += 5;
  if (hasAny(words, ["calls", "call", "depends", "dependency", "linked", "connected", "relationship", "impact", "uses", "perform", "copy", "exec", "upstream", "downstream"])) scores.GRAPH += 6;
  if (hasAny(words, ["summarize", "summary", "overview", "purpose", "architecture", "overall", "system", "main"]) || words.has("what") && words.has("do")) scores.RAPTOR += 5;
  if (hasAny(words, ["similar", "related", "meaning", "semantic", "concept", "search", "find"])) scores.VECTOR += 4;
  if (hasAny(words, ["explain", "why", "step", "reason", "trace", "failure", "edge", "corner"])) scores.FLARE += 5;
  if (hasAny(words, ["when", "history", "audit", "log", "trajectory", "version", "revision", "before", "after", "last", "parsed", "changed"])) scores.TRAJECTORY += 6;

  if (Object.values(scores).every((score) => score === 0)) scores.VECTOR = 2;
  const ordered = strategies.slice().sort((a, b) => scores[b] - scores[a]);
  const strategy = ordered[0];
  const runnerUp = ordered[1];
  return { strategy, confidence: scores[strategy], runnerUp, allScores: scores };
}

export class MDPNavigator {
  private readonly maxSteps: number;
  private readonly planner: NonNullable<NavigatorOptions["planner"]>;

  constructor(options: NavigatorOptions = {}) {
    this.maxSteps = Math.max(1, options.maxSteps ?? 2);
    this.planner = options.planner ?? ((state) => {
      if (state.step === 0) return planQuery(state.query).strategy;
      if (state.evidence.length === 0 && !state.selected.includes("VECTOR")) return "VECTOR";
      return "STOP";
    });
  }

  async run(query: string, tools: NavigatorTool[], override?: NavigatorStrategy): Promise<NavigatorResult> {
    const initial = planQuery(query);
    const state: NavigatorState = {
      query,
      step: 0,
      selected: [],
      evidence: [],
      uncertainty: 1,
    };
    let flareResult: unknown;
    let impactResult: unknown;

    while (state.step < this.maxSteps) {
      const requested = state.step === 0 && override ? override : this.planner(state, tools);
      if (requested === "STOP") break;
      const tool = tools.find((candidate) => candidate.strategy === requested);
      if (!tool || state.selected.includes(requested)) break;

      const output = await tool.execute();
      state.selected.push(requested);
      state.evidence.push(...output.results);
      flareResult = output.flareResult ?? flareResult;
      impactResult = output.impactResult ?? impactResult;
      state.uncertainty = output.results.length > 0 ? 0 : Math.max(0, state.uncertainty - 0.25);
      state.step += 1;
      if (state.uncertainty === 0) break;
    }

    const strategy = state.selected[0] ?? initial.strategy;
    const results = dedupeResults(state.evidence).slice(0, 100);
    return {
      ...initial,
      strategy,
      confidence: results.length > 0 ? Math.max(initial.confidence, 1) : initial.confidence,
      results,
      flareResult,
      impactResult,
      steps: state.step,
    };
  }
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.id)) return false;
    seen.add(result.id);
    return true;
  });
}


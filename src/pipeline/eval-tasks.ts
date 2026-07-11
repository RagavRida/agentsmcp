import type { StorageAdapter } from "../storage/interfaces";
import { createStorageAdapterFromEnv } from "../storage/interfaces";
import {
  parseProgramInProcess,
  parseProgramsConcurrently,
  resolveWorkerCount,
} from "../distributed/worker";
import {
  buildReport,
  parserAccuracy,
  type MetricResult,
} from "../eval";
import { buildCorpusIndex } from "../eval/index-corpus";
import { evaluateRetrieval } from "../eval/retrieval";
import { evaluateSafety } from "../eval/safety";
import { evaluateAnswerQuality } from "../eval/answer-quality";
import { evaluateGrounding } from "../eval/grounding";
import type { BenchmarkConfig, BenchmarkResult, CorpusEntry, QAPair } from "../eval/runner";
import {
  findUnrecognizedPatterns,
  LLMFallbackExtractor,
  type LLMExtractedRule,
} from "../parser/llm-fallback";
import { Pipeline, type PipelineOptions, type Task } from "./orchestrator";

export const PARSE_COBOL_TASK_ID = "parse-cobol";
export const SEMANTIC_ELEVATION_TASK_ID = "semantic-elevation";
export const LLM_FALLBACK_TASK_ID = "llm-fallback";
export const SCORING_TASK_ID = "scoring";

export interface EvalPipelineContext {
  corpus: CorpusEntry[];
  qaPairs: QAPair[];
  config: BenchmarkConfig;
  llmFallback?: {
    vllmUrl?: string;
    minConfidence?: number;
    maxFragmentTokens?: number;
    anonymize?: boolean;
    cacheDir?: string;
    failOnError?: boolean;
  };
}

export interface ParsedProgram {
  programId: string;
  source: string;
  expectedRules: CorpusEntry["expectedRules"];
  domain?: string;
  ast?: unknown;
  semanticTree?: unknown;
  extractedRules?: Array<{ id: string; type: string; description: string }>;
  error?: string;
}

export interface ParseCobolOutput {
  programs: ParsedProgram[];
  timingMs: number;
}

export interface ElevatedProgram extends ParsedProgram {
  semanticTree?: unknown;
  extractedRules: Array<{ id: string; type: string; description: string }>;
}

export interface SemanticElevationOutput {
  programs: ElevatedProgram[];
  timingMs: number;
}

export interface LLMFallbackProgramResult {
  programId: string;
  fragments: number;
  rules: LLMExtractedRule[];
  error?: string;
}

export interface LLMFallbackOutput {
  programs: LLMFallbackProgramResult[];
  stats: ReturnType<LLMFallbackExtractor["getStats"]>;
  timingMs: number;
}

export type ScoringOutput = BenchmarkResult;

export class ParseCobolTask implements Task<EvalPipelineContext, ParseCobolOutput> {
  id = PARSE_COBOL_TASK_ID;

  async execute(context: EvalPipelineContext): Promise<ParseCobolOutput> {
    const start = Date.now();
    const parseConcurrency = resolveWorkerCount(context.config.parseConcurrency);
    const jobs = context.corpus.map((entry) => ({
      programId: entry.programId,
      source: entry.source,
      filename: `${entry.programId}.CBL`,
    }));
    const parsed = parseConcurrency > 1 && jobs.length > 1
      ? await parseProgramsConcurrently(jobs, { size: parseConcurrency })
      : jobs.map((job) => {
          try {
            return parseProgramInProcess(job);
          } catch (err) {
            return {
              programId: job.programId,
              extractedRules: [],
              timingMs: 0,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        });

    const programs = context.corpus.map((entry) => {
      const result = parsed.find((item) => item.programId === entry.programId);
      if (result) {
        return {
          programId: entry.programId,
          source: entry.source,
          expectedRules: entry.expectedRules,
          domain: entry.domain,
          ast: result.ast,
          semanticTree: result.semanticTree,
          extractedRules: result.extractedRules,
          error: result.error,
        };
      }

      try {
        const result = parseProgramInProcess({
          programId: entry.programId,
          source: entry.source,
          filename: `${entry.programId}.CBL`,
        });
        return {
          programId: entry.programId,
          source: entry.source,
          expectedRules: entry.expectedRules,
          domain: entry.domain,
          ast: result.ast,
          semanticTree: result.semanticTree,
          extractedRules: result.extractedRules,
        };
      } catch (err) {
        return {
          programId: entry.programId,
          source: entry.source,
          expectedRules: entry.expectedRules,
          domain: entry.domain,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    return {
      programs,
      timingMs: Date.now() - start,
    };
  }

  async rollback(): Promise<void> {
    return undefined;
  }
}

export class SemanticElevationTask implements Task<EvalPipelineContext, SemanticElevationOutput> {
  id = SEMANTIC_ELEVATION_TASK_ID;
  dependencies = [PARSE_COBOL_TASK_ID];

  async execute(
    _context: EvalPipelineContext,
    results: { require<T = unknown>(taskId: string): T }
  ): Promise<SemanticElevationOutput> {
    const start = Date.now();
    const parseOutput = results.require<ParseCobolOutput>(PARSE_COBOL_TASK_ID);
    const { SemanticElevator } = loadParserClasses();

    const programs = parseOutput.programs.map((program) => {
      if (!program.ast) {
        return {
          ...program,
          extractedRules: [],
          error: program.error ?? "No AST available for semantic elevation",
        };
      }

      if (program.semanticTree && program.extractedRules) {
        return {
          ...program,
          semanticTree: program.semanticTree,
          extractedRules: program.extractedRules,
        };
      }

      try {
        const elevator = new SemanticElevator();
        const semanticTree = elevator.elevate(program.ast);
        const extractedRules = collectSemanticNodes(semanticTree, "BUSINESS_RULE")
          .map((node) => {
            const description = stringValue(node.description);
            const sourceAST = isRecord(node.sourceAST) ? node.sourceAST : {};
            return {
              id: description.split(":")[0]?.trim() || description || "unknown",
              type: stringValue(sourceAST.type) || "RULE",
              description,
            };
          });

        return {
          ...program,
          semanticTree,
          extractedRules,
        };
      } catch (err) {
        return {
          ...program,
          extractedRules: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    return {
      programs,
      timingMs: Date.now() - start,
    };
  }

  async rollback(): Promise<void> {
    return undefined;
  }
}

export class LLMFallbackTask implements Task<EvalPipelineContext, LLMFallbackOutput> {
  id = LLM_FALLBACK_TASK_ID;
  dependencies = [PARSE_COBOL_TASK_ID, SEMANTIC_ELEVATION_TASK_ID];

  async execute(
    context: EvalPipelineContext,
    results: { require<T = unknown>(taskId: string): T }
  ): Promise<LLMFallbackOutput> {
    const start = Date.now();
    const parseOutput = results.require<ParseCobolOutput>(PARSE_COBOL_TASK_ID);
    const semanticOutput = results.require<SemanticElevationOutput>(SEMANTIC_ELEVATION_TASK_ID);
    const extractor = new LLMFallbackExtractor({
      vllmUrl: context.llmFallback?.vllmUrl ?? process.env.AGENTSMCP_VLLM_URL ?? "",
      minConfidence: context.llmFallback?.minConfidence ?? 0.7,
      maxFragmentTokens: context.llmFallback?.maxFragmentTokens ?? 500,
      anonymize: context.llmFallback?.anonymize ?? true,
      cacheDir: context.llmFallback?.cacheDir,
      failOnError: context.llmFallback?.failOnError ?? true,
    });

    const programs: LLMFallbackProgramResult[] = [];
    for (const semanticProgram of semanticOutput.programs) {
      const parsedProgram = parseOutput.programs.find((item) => item.programId === semanticProgram.programId);
      if (!parsedProgram?.ast || !semanticProgram.semanticTree) {
        programs.push({
          programId: semanticProgram.programId,
          fragments: 0,
          rules: [],
          error: semanticProgram.error ?? parsedProgram?.error ?? "No AST or semantic tree available",
        });
        continue;
      }

      const fragments = findUnrecognizedPatterns(
        parsedProgram.ast,
        semanticProgram.semanticTree,
        semanticProgram.programId
      );
      const rules = await extractor.extractFromFragments(fragments);
      programs.push({
        programId: semanticProgram.programId,
        fragments: fragments.length,
        rules,
      });
    }

    return {
      programs,
      stats: extractor.getStats(),
      timingMs: Date.now() - start,
    };
  }

  async rollback(): Promise<void> {
    return undefined;
  }
}

export class ScoringTask implements Task<EvalPipelineContext, ScoringOutput> {
  id = SCORING_TASK_ID;
  dependencies = [SEMANTIC_ELEVATION_TASK_ID, LLM_FALLBACK_TASK_ID];

  async execute(
    context: EvalPipelineContext,
    results: { require<T = unknown>(taskId: string): T }
  ): Promise<ScoringOutput> {
    const totalStart = Date.now();
    const semanticOutput = results.require<SemanticElevationOutput>(SEMANTIC_ELEVATION_TASK_ID);
    const llmOutput = results.require<LLMFallbackOutput>(LLM_FALLBACK_TASK_ID);
    const parseOutput = results.require<ParseCobolOutput>(PARSE_COBOL_TASK_ID);
    const log = context.config.verbose ? console.log : () => {};

    const allMetrics: MetricResult[] = [];
    const parserResults: BenchmarkResult["parserResults"] = [];

    for (const program of semanticOutput.programs) {
      const llmProgram = llmOutput.programs.find((item) => item.programId === program.programId);
      const fallbackRules = (llmProgram?.rules ?? []).map((rule, index) => ({
        id: `LLM-${program.programId}-${index + 1}`,
        type: rule.type,
        description: rule.description,
      }));
      const extractedRules = [...program.extractedRules, ...fallbackRules];
      const metric = parserAccuracy(extractedRules, program.expectedRules);
      allMetrics.push(metric);

      parserResults.push({
        program: program.programId,
        f1: metric.details.f1 as number,
        precision: metric.details.precision as number,
        recall: metric.details.recall as number,
        missing: metric.details.missing as string[],
        extra: metric.details.extra as string[],
      });

      log(`  ${program.programId}: F1=${metric.details.f1}, rules=${extractedRules.length}`);
    }

    // Build a real vector index once, shared by retrieval/answer/grounding.
    // Null when no embedding endpoint is configured → those metrics report
    // notMeasured rather than fabricated numbers.
    const store = await buildCorpusIndex(context.corpus);
    try {
      const retrieval = await evaluateRetrieval(store, context.corpus, context.qaPairs, 5);
      allMetrics.push(retrieval.metric);
      const searchResults = retrieval.rows;

      const safety = evaluateSafety(context.corpus);
      allMetrics.push(safety.metric);
      const safetyResults = safety.results;

      const answerQuality = await evaluateAnswerQuality(store, context.corpus, context.qaPairs, 5);
      allMetrics.push(...answerQuality.metrics);
      allMetrics.push(await evaluateGrounding(store, context.qaPairs));

      const report = buildReport(allMetrics, { threshold: 0.6 });
      const result: BenchmarkResult = {
        config: serializableConfig(context.config),
        report,
        parserResults,
        searchResults,
        safetyResults,
        answerMetrics: answerQuality.aggregate,
        timing: {
          totalMs: Date.now() - totalStart,
          parseMs: parseOutput.timingMs,
          searchMs: 0,
          evalMs: 0,
        },
      };

      await saveBenchmarkResults(result, context.config);
      return result;
    } finally {
      store?.close();
    }
  }

  async rollback(): Promise<void> {
    return undefined;
  }
}

export function createEvalPipeline(options: PipelineOptions = {}): Pipeline<EvalPipelineContext> {
  return new Pipeline<EvalPipelineContext>(
    [
      new ParseCobolTask(),
      new SemanticElevationTask(),
      new LLMFallbackTask(),
      new ScoringTask(),
    ],
    options
  );
}

export async function runEvalPipeline(
  context: EvalPipelineContext,
  options: PipelineOptions = {}
): Promise<BenchmarkResult> {
  const pipeline = createEvalPipeline(options);
  const result = await pipeline.run(context);
  if (result.status === "FAILED") {
    const state = pipeline.getState();
    const taskError = result.failed ? state?.tasks[result.failed]?.error : undefined;
    throw new Error(`Evaluation pipeline failed at ${result.failed}: ${taskError ?? "unknown error"}`);
  }
  const scoring = result.outputs[SCORING_TASK_ID];
  if (!scoring) throw new Error("Evaluation pipeline completed without scoring output");
  return scoring as BenchmarkResult;
}

function loadParserClasses(): {
  COBOLParser: new () => { parse(source: string): unknown };
  SemanticElevator: new () => { elevate(ast: unknown): unknown };
} {
  const path = require("path");
  const fs = require("fs");
  const cjsDist = path.resolve(__dirname, "../../parser/dist-cjs");
  const srcDir = path.resolve(__dirname, "../../parser/src");
  const parserRoot = fs.existsSync(path.join(cjsDist, "types.js")) ? cjsDist : srcDir;

  const cobolParser = require(path.join(parserRoot, "cobol-parser"));
  const semanticElevator = require(path.join(parserRoot, "semantic-elevator"));
  return {
    COBOLParser: cobolParser.COBOLParser,
    SemanticElevator: semanticElevator.SemanticElevator,
  };
}

function collectSemanticNodes(node: unknown, type: string): Array<Record<string, unknown>> {
  const current = node as { type?: string; children?: unknown[] };
  const result: Array<Record<string, unknown>> = [];
  if (current?.type === type) result.push(current as Record<string, unknown>);
  for (const child of current?.children ?? []) {
    result.push(...collectSemanticNodes(child, type));
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function serializableConfig(config: BenchmarkConfig): BenchmarkConfig {
  const { storageAdapter: _storageAdapter, ...rest } = config;
  return rest;
}

async function saveBenchmarkResults(result: BenchmarkResult, config: BenchmarkConfig): Promise<void> {
  const storage = config.storageAdapter ?? createStorageAdapterFromEnv({
    localRoot: config.outputDir,
    s3Prefix: config.outputDir,
  });

  await writeJson(storage, "benchmark_results.json", result);
  await writeJson(storage, "eval_report.json", result.report);
  await writeJson(storage, "parser_results.json", result.parserResults);
  await writeJson(storage, "benchmark_summary.json", [
    {
      system: "AgentMailbox",
      "Parser F1": avgField(result.parserResults, "f1"),
      "Search MRR": measuredValue(result.report, "search_relevance@5", "mrr"),
      "Semantic Safety": measuredValue(result.report, "semantic_safety"),
      "Overall Score": result.report.overall,
      "Pass": result.report.pass,
      "Not Measured": result.report.notMeasured,
    },
  ]);
}

/**
 * Read a metric value (or detail) only if it was actually measured; null for
 * notMeasured metrics — never a fabricated number.
 */
function measuredValue(
  report: BenchmarkResult["report"],
  name: string,
  detailKey?: string,
): number | null {
  const metric = report.metrics.find((m) => m.name === name);
  if (!metric || metric.measured === false) return null;
  if (detailKey) return (metric.details[detailKey] as number) ?? null;
  return metric.value;
}

async function writeJson(storage: StorageAdapter, key: string, value: unknown): Promise<void> {
  await storage.write(key, JSON.stringify(value, null, 2));
}

function avgField(items: Array<Record<string, unknown>>, field: string): number {
  if (items.length === 0) return 0;
  const sum = items.reduce((acc, item) => {
    const value = item[field];
    return acc + (typeof value === "number" ? value : 0);
  }, 0);
  return Math.round((sum / items.length) * 10000) / 10000;
}

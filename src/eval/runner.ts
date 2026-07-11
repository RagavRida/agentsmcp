/**
 * Eval Runner — End-to-end benchmark runner for the AgentMailbox pipeline.
 *
 * Inspired by Cognee's QABenchmarkRAG pattern:
 *   1. Load corpus (COBOL programs with ground truth)
 *   2. Ingest via pipeline (parse → embed → store)
 *   3. Run Q&A pairs against recall()
 *   4. Score with metrics (parser F1, search MRR, grounding, safety)
 *   5. Produce structured report
 */

import * as fs from "fs";
import {
  parseProgramInProcess,
  parseProgramsConcurrently,
  resolveWorkerCount,
  type ParsedProgramResult,
} from "../distributed/worker";
import type { StorageAdapter } from "../storage/interfaces";
import { createStorageAdapterFromEnv } from "../storage/interfaces";
import type { TransferContext } from "../verification/semantic-verifier";
import type { AggregateMetrics } from "./deep-eval";
import {
  parserAccuracy,
  buildReport,
  type MetricResult,
  type EvalReport,
} from "./index";
import { buildCorpusIndex } from "./index-corpus";
import { evaluateRetrieval } from "./retrieval";
import { evaluateSafety } from "./safety";
import { evaluateAnswerQuality } from "./answer-quality";
import { evaluateGrounding } from "./grounding";

// ── Types ──────────────────────────────────────────────────

export interface QAPair {
  id: string;
  question: string;
  expectedAnswer: string;
  program?: string;
  expectedStrategy?: string;
  relevantNodeIds?: string[];
}

export interface CorpusEntry {
  programId: string;
  source: string;
  expectedRules: Array<{ id: string; type: string; description: string }>;
  domain?: string;
  /**
   * Hand-authored runtime transfer scenarios used to REALLY exercise the
   * banking SemanticVerifier for this program. These are correct scenarios
   * (all invariants should hold); they cannot be derived from static COBOL,
   * so they are authored per program. Programs without vectors are reported
   * as notMeasured for safety rather than fake-passed.
   */
  safetyVectors?: TransferContext[];
}

export interface BenchmarkConfig {
  name: string;
  corpusLimit?: number;
  qaLimit?: number;
  outputDir: string;
  verbose?: boolean;
  storageAdapter?: StorageAdapter;
  /** Number of worker_threads to use for parse + semantic elevation. Defaults to AGENTSMCP_PARSE_WORKERS or 1. */
  parseConcurrency?: number;
}

export interface BenchmarkResult {
  config: BenchmarkConfig;
  report: EvalReport;
  parserResults: Array<{
    program: string;
    f1: number;
    precision: number;
    recall: number;
    missing: string[];
    extra: string[];
  }>;
  searchResults: Array<{
    question: string;
    strategy: string;
    hits: number;
    mrr: number;
  }>;
  safetyResults: Array<{
    program: string;
    measured: boolean;
    passed: boolean;
    criticalFailures: string[];
  }>;
  /**
   * Real DeepEval-style answer metrics when the LLM path ran, else null.
   * Never synthesized from other scores.
   */
  answerMetrics?: AggregateMetrics | null;
  timing: {
    totalMs: number;
    parseMs: number;
    searchMs: number;
    evalMs: number;
  };
}

// ── Benchmark Runner ───────────────────────────────────────

export class BenchmarkRunner {
  private config: BenchmarkConfig;
  private corpus: CorpusEntry[];
  private qaPairs: QAPair[];

  constructor(
    corpus: CorpusEntry[],
    qaPairs: QAPair[],
    config: BenchmarkConfig
  ) {
    this.config = config;
    this.corpus = config.corpusLimit
      ? corpus.slice(0, config.corpusLimit)
      : corpus;
    this.qaPairs = config.qaLimit
      ? qaPairs.slice(0, config.qaLimit)
      : qaPairs;
  }

  /**
   * Create a runner from JSON files on disk.
   */
  static fromFiles(
    corpusFile: string,
    qaPairsFile: string,
    config: BenchmarkConfig
  ): BenchmarkRunner {
    const corpus: CorpusEntry[] = JSON.parse(
      fs.readFileSync(corpusFile, "utf-8")
    );
    const qaPairs: QAPair[] = JSON.parse(
      fs.readFileSync(qaPairsFile, "utf-8")
    );
    return new BenchmarkRunner(corpus, qaPairs, config);
  }

  /**
   * Run the full benchmark pipeline.
   */
  async run(): Promise<BenchmarkResult> {
    const totalStart = Date.now();
    const log = this.config.verbose ? console.log : () => {};

    log(`\n═══ AgentMailbox Benchmark: ${this.config.name} ═══`);
    log(`Corpus: ${this.corpus.length} programs`);
    log(`QA Pairs: ${this.qaPairs.length} questions\n`);

    // ── Phase 1: Parse Corpus ────────────────────────
    const parseStart = Date.now();
    const parserResults: BenchmarkResult["parserResults"] = [];
    const allMetrics: MetricResult[] = [];

    const parseConcurrency = resolveWorkerCount(this.config.parseConcurrency);
    const parsedPrograms = await this.parseCorpus(parseConcurrency);
    for (const entry of this.corpus) {
      const parsed = parsedPrograms.find((item) => item.programId === entry.programId);
      log(`Parsing ${entry.programId}${parseConcurrency > 1 ? " (worker)" : ""}...`);

      try {
        if (!parsed || parsed.error) {
          throw new Error(parsed?.error ?? "parser did not return a result");
        }
        const extractedRules = parsed.extractedRules;
        const metric = parserAccuracy(extractedRules, entry.expectedRules);
        allMetrics.push(metric);

        parserResults.push({
          program: entry.programId,
          f1: metric.details.f1 as number,
          precision: metric.details.precision as number,
          recall: metric.details.recall as number,
          missing: metric.details.missing as string[],
          extra: metric.details.extra as string[],
        });

        log(`  ✓ ${entry.programId}: F1=${metric.details.f1}, ` +
          `P=${metric.details.precision}, R=${metric.details.recall}, ` +
          `rules=${extractedRules.length}`);
      } catch (err) {
        log(`  ✗ ${entry.programId}: ${String(err)}`);
        parserResults.push({
          program: entry.programId,
          f1: 0, precision: 0, recall: 0,
          missing: entry.expectedRules.map(r => r.id),
          extra: [],
        });
      }
    }
    const parseMs = Date.now() - parseStart;

    // Build a real vector index over the corpus (null when no embedding
    // endpoint is configured → retrieval/answer/grounding report notMeasured).
    const store = await buildCorpusIndex(this.corpus);

    try {
      // ── Phase 2: Retrieval Evaluation (real semantic search) ──
      const searchStart = Date.now();
      const retrieval = await evaluateRetrieval(store, this.corpus, this.qaPairs, 5);
      allMetrics.push(retrieval.metric);
      const searchResults: BenchmarkResult["searchResults"] = retrieval.rows;
      const searchMs = Date.now() - searchStart;

      // ── Phase 3: Safety Evaluation (real SemanticVerifier) ──
      const safety = evaluateSafety(this.corpus);
      allMetrics.push(safety.metric);
      const safetyResults: BenchmarkResult["safetyResults"] = safety.results;

      // ── Phase 4: Answer quality + grounding + report ──
      const evalStart = Date.now();
      const answerQuality = await evaluateAnswerQuality(store, this.corpus, this.qaPairs, 5);
      allMetrics.push(...answerQuality.metrics);
      allMetrics.push(await evaluateGrounding(store, this.qaPairs));

      const report = buildReport(allMetrics, { threshold: 0.6 });
      const evalMs = Date.now() - evalStart;
      const totalMs = Date.now() - totalStart;

      const { storageAdapter: _storageAdapter, ...serializableConfig } = this.config;
      const result: BenchmarkResult = {
        config: serializableConfig,
        report,
        parserResults,
        searchResults,
        safetyResults,
        answerMetrics: answerQuality.aggregate,
        timing: { totalMs, parseMs, searchMs, evalMs },
      };

      // ── Save Results ─────────────────────────────────
      await this.saveResults(result);

      log(`\n═══ Results ═══`);
      log(`Overall score: ${report.overall}`);
      log(`Pass: ${report.pass ? "✅ YES" : "❌ NO"}`);
      if (report.notMeasured.length > 0) {
        log(`Not measured: ${report.notMeasured.join(", ")}`);
      }
      log(`Timing: ${totalMs}ms total (parse: ${parseMs}ms, search: ${searchMs}ms)`);
      log(`Output: ${this.config.outputDir}`);

      return result;
    } finally {
      store?.close();
    }
  }

  private async parseCorpus(parseConcurrency: number): Promise<ParsedProgramResult[]> {
    const jobs = this.corpus.map((entry) => ({
      programId: entry.programId,
      source: entry.source,
      filename: `${entry.programId}.CBL`,
    }));

    if (parseConcurrency > 1 && jobs.length > 1) {
      return parseProgramsConcurrently(jobs, { size: parseConcurrency });
    }

    return jobs.map((job) => {
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
  }

  /**
   * Save results to the configured storage backend.
   */
  private async saveResults(result: BenchmarkResult): Promise<void> {
    const storage = this.config.storageAdapter ?? createStorageAdapterFromEnv({
      localRoot: this.config.outputDir,
      s3Prefix: this.config.outputDir,
    });

    // Full results
    await storage.write(
      "benchmark_results.json",
      JSON.stringify(result, null, 2)
    );

    // Summary report
    await storage.write(
      "eval_report.json",
      JSON.stringify(result.report, null, 2)
    );

    // Parser breakdown
    await storage.write(
      "parser_results.json",
      JSON.stringify(result.parserResults, null, 2)
    );

    // Comparison-ready format (matches Cognee's benchmark_summary_competition.json)
    const comparisonEntry = {
      system: "AgentMailbox",
      "Parser F1": avgField(result.parserResults, "f1"),
      "Search MRR": comparisonMetricValue(result.report, "search_relevance@5", "mrr"),
      "Semantic Safety": comparisonMetricValue(result.report, "semantic_safety"),
      "Overall Score": result.report.overall,
      "Pass": result.report.pass,
      "Not Measured": result.report.notMeasured,
    };

    await storage.write(
      "benchmark_summary.json",
      JSON.stringify([comparisonEntry], null, 2)
    );
  }
}

// ── Helpers ────────────────────────────────────────────────

function avgField(arr: Array<Record<string, any>>, field: string): number {
  if (arr.length === 0) return 0;
  const sum = arr.reduce((acc, item) => acc + (item[field] ?? 0), 0);
  return Math.round((sum / arr.length) * 10000) / 10000;
}

/**
 * Read a metric's value (or a specific detail) only if it was actually
 * measured. Returns null for notMeasured metrics — never a fabricated number.
 */
function measuredValue(report: EvalReport, name: string, detailKey?: string): number | null {
  const metric = report.metrics.find((m) => m.name === name);
  if (!metric || metric.measured === false) return null;
  if (detailKey) return (metric.details[detailKey] as number) ?? null;
  return metric.value;
}

function comparisonMetricValue(
  report: EvalReport,
  name: string,
  detailKey?: string,
): number {
  return measuredValue(report, name, detailKey) ?? 0;
}

// ── Sample Benchmark Data (COBOL) ──────────────────────────
// Minimal built-in test corpus for quick validation.

export const SAMPLE_CORPUS: CorpusEntry[] = [
  {
    programId: "LOAN-CALC",
    domain: "Risk",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. LOAN-CALC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-PRINCIPAL    PIC 9(9)V99.
       01 WS-RATE          PIC 9(3)V9999.
       01 WS-INTEREST      PIC 9(9)V99.
       PROCEDURE DIVISION.
           COMPUTE WS-INTEREST = WS-PRINCIPAL * WS-RATE
           IF WS-INTEREST > 10000
               DISPLAY "HIGH INTEREST ALERT"
           END-IF
           STOP RUN.
    `,
    expectedRules: [
      { id: "COMPUTE-WS-INTEREST", type: "COMPUTE", description: "Calculate interest" },
      { id: "IF-WS-INTEREST-GT-10000", type: "IF", description: "High interest check" },
    ],
  },
  {
    programId: "PAY-BATCH",
    domain: "Payments",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAY-BATCH.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-TOTAL-DEBITS  PIC 9(9)V99.
       01 WS-TOTAL-CREDITS PIC 9(9)V99.
       01 WS-DIFF           PIC S9(9)V99.
       PROCEDURE DIVISION.
           SUBTRACT WS-TOTAL-DEBITS FROM WS-TOTAL-CREDITS
               GIVING WS-DIFF
           IF WS-DIFF NOT = ZERO
               DISPLAY "BATCH IMBALANCE"
           END-IF
           STOP RUN.
    `,
    expectedRules: [
      { id: "SUBTRACT-WS-TOTAL-DEBITS", type: "SUBTRACT", description: "Calculate batch difference" },
      { id: "IF-WS-DIFF-NE-ZERO", type: "IF", description: "Batch balance check" },
    ],
  },
];

export const SAMPLE_QA_PAIRS: QAPair[] = [
  {
    id: "q1",
    question: "What does LOAN-CALC do?",
    expectedAnswer: "Calculates loan interest and alerts on high interest amounts",
    program: "LOAN-CALC",
    expectedStrategy: "RAPTOR",
  },
  {
    id: "q2",
    question: "What calls the interest calculation?",
    expectedAnswer: "LOAN-CALC program computes WS-INTEREST from principal and rate",
    program: "LOAN-CALC",
    expectedStrategy: "GRAPH",
  },
  {
    id: "q3",
    question: "Find rules similar to balance checking",
    expectedAnswer: "PAY-BATCH checks batch imbalance via SUBTRACT and IF",
    program: "PAY-BATCH",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["SUBTRACT-WS-TOTAL-DEBITS", "IF-WS-DIFF-NE-ZERO"],
  },
  {
    id: "q4",
    question: "What is the impact of changing WS-RATE?",
    expectedAnswer: "Affects WS-INTEREST computation in LOAN-CALC",
    program: "LOAN-CALC",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["COMPUTE-WS-INTEREST"],
  },
  {
    id: "q5",
    question: "Explain why the batch checks for imbalance",
    expectedAnswer: "Settlement integrity: total debits must equal total credits",
    program: "PAY-BATCH",
    expectedStrategy: "FLARE",
  },
];

// ── Helpers ────────────────────────────────────────────────

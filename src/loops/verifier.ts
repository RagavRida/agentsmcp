import {
  BenchmarkRunner,
  type BenchmarkConfig,
  type BenchmarkResult,
  type CorpusEntry,
  type QAPair,
} from "../eval/runner";
import { classifyFailures, type FailureReport } from "./failure-classifier";

export interface LoopVerifierConfig {
  goal: string;
  targetF1: number;
  outputDir: string;
  confidenceStep?: number;
  minConfidenceThreshold?: number;
  storageAdapter?: BenchmarkConfig["storageAdapter"];
}

export interface LoopVerificationResult {
  achieved: boolean;
  f1Score: number;
  targetF1: number;
  failedRules: Array<{
    program: string;
    missing: string[];
    extra: string[];
  }>;
  nextConfidenceThreshold: number;
  lessonsLearned: string[];
  /** Root-cause classification of each failure */
  failureReport: FailureReport;
  benchmark: BenchmarkResult;
}

export class LoopVerifier {
  private readonly config: Required<Omit<LoopVerifierConfig, "storageAdapter">> & {
    storageAdapter?: BenchmarkConfig["storageAdapter"];
  };

  constructor(config: LoopVerifierConfig) {
    this.config = {
      confidenceStep: 0.1,
      minConfidenceThreshold: 0.3,
      ...config,
    };
  }

  async verify(
    iteration: number,
    corpus: CorpusEntry[],
    qaPairs: QAPair[],
    confidenceThreshold: number,
  ): Promise<LoopVerificationResult> {
    const runner = new BenchmarkRunner(corpus, qaPairs, {
      name: `loop-${iteration}-${Date.now().toString(36)}`,
      outputDir: this.config.outputDir,
      verbose: false,
      storageAdapter: this.config.storageAdapter,
    });
    const benchmark = await runner.run();
    const f1Score = averageF1(benchmark);
    const failedRules = benchmark.parserResults
      .filter((result) => result.missing.length > 0 || result.extra.length > 0 || result.f1 < this.config.targetF1)
      .map((result) => ({
        program: result.program,
        missing: result.missing,
        extra: result.extra,
      }));
    const achieved = f1Score >= this.config.targetF1;
    const nextConfidenceThreshold = achieved
      ? confidenceThreshold
      : Math.max(
          this.config.minConfidenceThreshold,
          round2(confidenceThreshold - this.config.confidenceStep),
        );

    const verificationResult: Omit<LoopVerificationResult, "failureReport"> = {
      achieved,
      f1Score,
      targetF1: this.config.targetF1,
      failedRules,
      nextConfidenceThreshold,
      lessonsLearned: buildLessons(f1Score, this.config.targetF1, failedRules, confidenceThreshold, nextConfidenceThreshold),
      benchmark,
    };

    // Classify failure modes for targeted prompt repair
    const failureReport = classifyFailures(verificationResult as LoopVerificationResult);

    return {
      ...verificationResult,
      failureReport,
    };
  }
}

function averageF1(result: BenchmarkResult): number {
  if (result.parserResults.length === 0) return 0;
  return result.parserResults.reduce((sum, item) => sum + item.f1, 0) / result.parserResults.length;
}

function buildLessons(
  f1Score: number,
  targetF1: number,
  failedRules: LoopVerificationResult["failedRules"],
  currentThreshold: number,
  nextThreshold: number,
): string[] {
  const lessons: string[] = [];
  if (f1Score >= targetF1) {
    lessons.push(`Goal satisfied: parser F1 ${f1Score.toFixed(4)} reached target ${targetF1.toFixed(4)}.`);
  } else {
    lessons.push(`Parser F1 ${f1Score.toFixed(4)} is below target ${targetF1.toFixed(4)}.`);
    lessons.push(`Tune LLM fallback confidence threshold from ${currentThreshold.toFixed(2)} to ${nextThreshold.toFixed(2)} for the next iteration.`);
  }
  if (failedRules.length > 0) {
    lessons.push(`Focus on ${failedRules.length} program(s) with missing or extra rules.`);
  }
  return lessons;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

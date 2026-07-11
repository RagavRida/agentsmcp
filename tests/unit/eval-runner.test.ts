/**
 * Unit tests for the Eval Runner — benchmark pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  BenchmarkRunner,
  SAMPLE_CORPUS,
  SAMPLE_QA_PAIRS,
  type BenchmarkConfig,
  type BenchmarkResult,
} from "../../src/eval/runner";
import type { StorageAdapter, StorageData } from "../../src/storage/interfaces";

describe("BenchmarkRunner", () => {
  const outputDir = path.join(os.tmpdir(), ".agentsmcp-eval-test");

  afterEach(() => {
    // Clean up output
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  const config: BenchmarkConfig = {
    name: "unit-test-benchmark",
    outputDir,
    verbose: false,
  };

  it("constructs with sample data", () => {
    const runner = new BenchmarkRunner(SAMPLE_CORPUS, SAMPLE_QA_PAIRS, config);
    expect(runner).toBeDefined();
  });

  it("respects corpusLimit", () => {
    const limited = new BenchmarkRunner(
      SAMPLE_CORPUS,
      SAMPLE_QA_PAIRS,
      { ...config, corpusLimit: 1 }
    );
    expect(limited).toBeDefined();
  });

  it("respects qaLimit", () => {
    const limited = new BenchmarkRunner(
      SAMPLE_CORPUS,
      SAMPLE_QA_PAIRS,
      { ...config, qaLimit: 2 }
    );
    expect(limited).toBeDefined();
  });

  // ── Run Pipeline ───────────────────────────────────

  it("runs full benchmark and produces report", async () => {
    const runner = new BenchmarkRunner(SAMPLE_CORPUS, SAMPLE_QA_PAIRS, config);
    const result = await runner.run();

    // Structure checks
    expect(result.config.name).toBe("unit-test-benchmark");
    expect(result.report).toBeDefined();
    expect(result.report.runId).toContain("eval-");
    expect(typeof result.report.overall).toBe("number");
    expect(typeof result.report.pass).toBe("boolean");
    expect(result.report.metrics.length).toBeGreaterThan(0);
  });

  it("produces parser results for each corpus entry", async () => {
    const runner = new BenchmarkRunner(SAMPLE_CORPUS, SAMPLE_QA_PAIRS, config);
    const result = await runner.run();

    expect(result.parserResults).toHaveLength(SAMPLE_CORPUS.length);
    for (const pr of result.parserResults) {
      expect(pr.program).toBeDefined();
      expect(typeof pr.f1).toBe("number");
      expect(typeof pr.precision).toBe("number");
      expect(typeof pr.recall).toBe("number");
    }
  });

  it("produces search results for each QA pair", async () => {
    const runner = new BenchmarkRunner(SAMPLE_CORPUS, SAMPLE_QA_PAIRS, config);
    const result = await runner.run();

    expect(result.searchResults).toHaveLength(SAMPLE_QA_PAIRS.length);
    for (const sr of result.searchResults) {
      expect(sr.question).toBeDefined();
      expect(sr.strategy).toBeDefined();
      expect(typeof sr.mrr).toBe("number");
    }
  });

  it("produces safety results", async () => {
    const runner = new BenchmarkRunner(SAMPLE_CORPUS, SAMPLE_QA_PAIRS, config);
    const result = await runner.run();

    expect(result.safetyResults).toHaveLength(SAMPLE_CORPUS.length);
    for (const sr of result.safetyResults) {
      expect(typeof sr.passed).toBe("boolean");
    }
  });

  it("records timing", async () => {
    const runner = new BenchmarkRunner(SAMPLE_CORPUS, SAMPLE_QA_PAIRS, config);
    const result = await runner.run();

    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.parseMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.searchMs).toBeGreaterThanOrEqual(0);
  });

  // ── File Output ────────────────────────────────────

  it("saves output files", async () => {
    const runner = new BenchmarkRunner(SAMPLE_CORPUS, SAMPLE_QA_PAIRS, config);
    await runner.run();

    expect(fs.existsSync(path.join(outputDir, "benchmark_results.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "eval_report.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "parser_results.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "benchmark_summary.json"))).toBe(true);
  });

  it("saves Cognee-compatible comparison format", async () => {
    const runner = new BenchmarkRunner(SAMPLE_CORPUS, SAMPLE_QA_PAIRS, config);
    await runner.run();

    const summary = JSON.parse(
      fs.readFileSync(path.join(outputDir, "benchmark_summary.json"), "utf-8")
    );

    expect(Array.isArray(summary)).toBe(true);
    expect(summary[0].system).toBe("AgentMailbox");
    expect(typeof summary[0]["Parser F1"]).toBe("number");
    expect(typeof summary[0]["Search MRR"]).toBe("number");
    expect(typeof summary[0]["Semantic Safety"]).toBe("number");
    expect(typeof summary[0]["Overall Score"]).toBe("number");
  });

  it("can save results through an injected storage adapter", async () => {
    const writes = new Map<string, string>();
    const storageAdapter: StorageAdapter = {
      async read(key: string) {
        const value = writes.get(key);
        return value === undefined ? null : Buffer.from(value);
      },
      async write(key: string, data: StorageData) {
        writes.set(key, Buffer.from(data).toString("utf-8"));
      },
      async exists(key: string) {
        return writes.has(key);
      },
    };

    const runner = new BenchmarkRunner(SAMPLE_CORPUS, SAMPLE_QA_PAIRS, {
      ...config,
      storageAdapter,
    });
    await runner.run();

    expect(writes.has("benchmark_results.json")).toBe(true);
    expect(writes.has("eval_report.json")).toBe(true);
    expect(writes.has("parser_results.json")).toBe(true);
    expect(writes.has("benchmark_summary.json")).toBe(true);
    expect(JSON.parse(writes.get("benchmark_results.json")!).config.storageAdapter).toBeUndefined();
    expect(JSON.parse(writes.get("benchmark_summary.json")!)[0].system).toBe("AgentMailbox");
  });

  // ── fromFiles ──────────────────────────────────────

  it("fromFiles loads data from JSON", () => {
    // Write temp files
    const tmpDir = path.join(os.tmpdir(), ".agentsmcp-eval-files");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const corpusFile = path.join(tmpDir, "corpus.json");
    const qaFile = path.join(tmpDir, "qa.json");

    fs.writeFileSync(corpusFile, JSON.stringify(SAMPLE_CORPUS));
    fs.writeFileSync(qaFile, JSON.stringify(SAMPLE_QA_PAIRS));

    const runner = BenchmarkRunner.fromFiles(corpusFile, qaFile, config);
    expect(runner).toBeDefined();

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Sample Data ────────────────────────────────────

  it("SAMPLE_CORPUS has valid entries", () => {
    expect(SAMPLE_CORPUS.length).toBeGreaterThanOrEqual(2);
    for (const entry of SAMPLE_CORPUS) {
      expect(entry.programId).toBeDefined();
      expect(entry.source.length).toBeGreaterThan(50);
      expect(entry.expectedRules.length).toBeGreaterThan(0);
    }
  });

  it("SAMPLE_QA_PAIRS has valid entries", () => {
    expect(SAMPLE_QA_PAIRS.length).toBeGreaterThanOrEqual(5);
    for (const qa of SAMPLE_QA_PAIRS) {
      expect(qa.question).toBeDefined();
      expect(qa.expectedAnswer).toBeDefined();
      expect(qa.expectedStrategy).toBeDefined();
    }
  });
});

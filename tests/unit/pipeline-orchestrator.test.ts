import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { loadDataset } from "../../src/eval/registry";
import {
  LLM_FALLBACK_TASK_ID,
  PARSE_COBOL_TASK_ID,
  SCORING_TASK_ID,
  SEMANTIC_ELEVATION_TASK_ID,
  runEvalPipeline,
} from "../../src/pipeline/eval-tasks";
import { Pipeline, type Task } from "../../src/pipeline/orchestrator";

describe("Pipeline orchestrator", () => {
  it("resumes from the last successful DAG node", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentsmcp-pipeline-"));
    const stateFile = join(dir, "state.json");
    const calls: string[] = [];

    const firstRun = new Pipeline<{ failMiddle: boolean }>(
      [
        task("parse", [], calls),
        task("llm", ["parse"], calls, (context) => {
          if (context.failMiddle) throw new Error("network unavailable");
          return { ok: true };
        }),
        task("score", ["llm"], calls),
      ],
      { runId: "resume-test", stateFile }
    );

    const failed = await firstRun.run({ failMiddle: true });
    expect(failed.status).toBe("FAILED");
    expect(failed.completed).toEqual(["parse"]);
    expect(failed.failed).toBe("llm");
    expect(calls).toEqual(["parse", "llm"]);

    calls.length = 0;
    const resumed = new Pipeline<{ failMiddle: boolean }>(
      [
        task("parse", [], calls),
        task("llm", ["parse"], calls, () => ({ ok: true })),
        task("score", ["llm"], calls),
      ],
      { runId: "resume-test", stateFile }
    );

    const completed = await resumed.run({ failMiddle: false });
    expect(completed.status).toBe("COMPLETED");
    expect(calls).toEqual(["llm", "score"]);

    const state = JSON.parse(await readFile(stateFile, "utf-8"));
    expect(state.tasks.parse.status).toBe("COMPLETED");
    expect(state.tasks.llm.status).toBe("COMPLETED");
    expect(state.tasks.score.status).toBe("COMPLETED");
  });

  it("rejects cyclic DAGs", () => {
    expect(() => new Pipeline([
      task("a", ["b"], []),
      task("b", ["a"], []),
    ])).toThrow("cycle");
  });
});

describe("Evaluation pipeline tasks", () => {
  it("runs the sample dataset through parse, semantic, fallback, and scoring tasks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentsmcp-eval-pipeline-"));
    const dataset = loadDataset("sample");
    const result = await runEvalPipeline(
      {
        corpus: dataset.corpus,
        qaPairs: dataset.qaPairs,
        config: {
          name: "pipeline-sample-test",
          outputDir: join(dir, "results"),
          verbose: false,
        },
        llmFallback: {
          vllmUrl: "",
          failOnError: true,
        },
      },
      {
        runId: "pipeline-sample-test",
        stateFile: join(dir, "state.json"),
      }
    );

    expect(result.parserResults).toHaveLength(dataset.corpus.length);
    expect(result.searchResults).toHaveLength(dataset.qaPairs.length);

    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf-8"));
    expect(state.tasks[PARSE_COBOL_TASK_ID].status).toBe("COMPLETED");
    expect(state.tasks[SEMANTIC_ELEVATION_TASK_ID].status).toBe("COMPLETED");
    expect(state.tasks[LLM_FALLBACK_TASK_ID].status).toBe("COMPLETED");
    expect(state.tasks[SCORING_TASK_ID].status).toBe("COMPLETED");
  });
});

function task<TContext>(
  id: string,
  dependencies: string[],
  calls: string[],
  run?: (context: TContext) => unknown
): Task<TContext> {
  return {
    id,
    dependencies,
    execute: (context) => {
      calls.push(id);
      return run ? run(context) : { id };
    },
    rollback: () => undefined,
  };
}

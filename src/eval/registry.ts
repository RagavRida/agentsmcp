/**
 * Dataset Registry — discover and load eval datasets.
 *
 * Supports:
 *   - Built-in datasets (COBOL Banking, sample)
 *   - Custom datasets from JSON files
 *   - Dataset metadata and versioning
 */

import type { CorpusEntry, QAPair } from "./runner";
import { SAMPLE_CORPUS, SAMPLE_QA_PAIRS } from "./runner";
import { COBOL_BANKING_CORPUS, COBOL_BANKING_QA } from "./datasets/cobol-banking";
import { UNSEEN_CORPUS, UNSEEN_QA } from "./datasets/unseen-holdout";
import { LLM_FALLBACK_EVAL_CASES, runLLMFallbackEval, type LLMFallbackEvalResult, type LLMFallbackTestCase } from "./datasets/llm-fallback-eval";
export { LLM_FALLBACK_EVAL_CASES, runLLMFallbackEval, type LLMFallbackEvalResult, type LLMFallbackTestCase };
import * as fs from "fs";

// ── Types ──────────────────────────────────────────────────

export interface DatasetMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  domains: string[];
  corpusSize: number;
  qaSize: number;
  source: "builtin" | "file";
}

export interface Dataset {
  meta: DatasetMeta;
  corpus: CorpusEntry[];
  qaPairs: QAPair[];
}

// ── Built-in Registry ──────────────────────────────────────

const BUILTIN_DATASETS: Record<string, () => Dataset> = {
  "sample": () => ({
    meta: {
      id: "sample",
      name: "Quick Sample",
      description: "2-program sample for smoke testing the eval pipeline",
      version: "1.0.0",
      domains: ["Risk", "Payments"],
      corpusSize: SAMPLE_CORPUS.length,
      qaSize: SAMPLE_QA_PAIRS.length,
      source: "builtin",
    },
    corpus: SAMPLE_CORPUS,
    qaPairs: SAMPLE_QA_PAIRS,
  }),

  "cobol-banking": () => ({
    meta: {
      id: "cobol-banking",
      name: "COBOL Banking Suite",
      description:
        "5-program COBOL banking dataset covering Risk, Payments, " +
        "Core Banking, Settlement, and Treasury domains. " +
        "27 expected rules, 25 Q&A pairs.",
      version: "1.0.0",
      domains: ["Risk", "Payments", "CoreBanking", "Settlement", "Treasury"],
      corpusSize: COBOL_BANKING_CORPUS.length,
      qaSize: COBOL_BANKING_QA.length,
      source: "builtin",
    },
    corpus: COBOL_BANKING_CORPUS,
    qaPairs: COBOL_BANKING_QA,
  }),

  "unseen-holdout": () => ({
    meta: {
      id: "unseen-holdout",
      name: "Unseen Holdout (Generalization Test)",
      description:
        "3-program holdout dataset with unseen patterns: fraud detection " +
        "(EVALUATE/sanctions), batch reconciliation (retry logic), " +
        "and currency hedging (stop-loss). NEVER used during development.",
      version: "1.0.0",
      domains: ["Compliance", "Operations", "Treasury"],
      corpusSize: UNSEEN_CORPUS.length,
      qaSize: UNSEEN_QA.length,
      source: "builtin",
    },
    corpus: UNSEEN_CORPUS,
    qaPairs: UNSEEN_QA,
  }),
};

// ── Registry API ───────────────────────────────────────────

/** List all available datasets */
export function listDatasets(): DatasetMeta[] {
  return Object.values(BUILTIN_DATASETS).map(factory => factory().meta);
}

/** Load a dataset by ID */
export function loadDataset(id: string): Dataset {
  const factory = BUILTIN_DATASETS[id];
  if (!factory) {
    throw new Error(
      `Dataset '${id}' not found. Available: ${Object.keys(BUILTIN_DATASETS).join(", ")}`
    );
  }
  return factory();
}

/** Load a custom dataset from JSON files */
export function loadDatasetFromFiles(
  corpusFile: string,
  qaFile: string,
  meta?: Partial<DatasetMeta>
): Dataset {
  const corpus: CorpusEntry[] = JSON.parse(fs.readFileSync(corpusFile, "utf-8"));
  const qaPairs: QAPair[] = JSON.parse(fs.readFileSync(qaFile, "utf-8"));

  return {
    meta: {
      id: meta?.id ?? "custom",
      name: meta?.name ?? "Custom Dataset",
      description: meta?.description ?? `Loaded from ${corpusFile}`,
      version: meta?.version ?? "0.0.0",
      domains: meta?.domains ?? [],
      corpusSize: corpus.length,
      qaSize: qaPairs.length,
      source: "file",
    },
    corpus,
    qaPairs,
  };
}

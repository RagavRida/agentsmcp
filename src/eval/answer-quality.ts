/**
 * HONEST answer-quality evaluation.
 *
 * Replaces the previous synthesis (Correctness/EM/F1 back-computed from parser
 * F1 + MRR + safety). This generates REAL answers from the configured model
 * provider, grounded in retrieved context, and scores them with the existing
 * real DeepEval-style metrics in ./deep-eval.
 *
 * Gated on BOTH a model provider AND a retrieval index: we only report answer
 * quality when the full RAG path can actually run. Otherwise every answer
 * metric is `notMeasured` (never fabricated).
 */

import type { VectorStore } from "../vector/store";
import { detectModelConfig, generate } from "../model/provider";
import { calculateAggregateMetrics, type AggregateMetrics } from "./deep-eval";
import { notMeasured, type MetricResult } from "./index";
import type { CorpusEntry, QAPair } from "./runner";

export interface AnswerQualityResult {
  metrics: MetricResult[]; // answer_correctness, answer_em, answer_f1
  aggregate: AggregateMetrics | null;
}

const ANSWER_METRIC_NAMES = ["answer_correctness", "answer_em", "answer_f1"] as const;

export async function evaluateAnswerQuality(
  store: VectorStore | null,
  _corpus: CorpusEntry[],
  qaPairs: QAPair[],
  k = 5,
): Promise<AnswerQualityResult> {
  const cfg = detectModelConfig();

  if (cfg.provider === "none" || !store) {
    const reason =
      cfg.provider === "none"
        ? "no model provider configured (set AGENTSMCP_MODAL_ENDPOINT_URL / AGENTSMCP_VLLM_URL / OLLAMA_URL / DEEPSEEK_API_KEY / OPENAI_API_KEY)"
        : "AGENTSMCP_MODAL_EMBED_URL unset — no retrieval context available to ground answers";
    return {
      metrics: ANSWER_METRIC_NAMES.map((n) => notMeasured(n, reason)),
      aggregate: null,
    };
  }

  const results: Array<{ prediction: string; golden: string }> = [];
  for (const qa of qaPairs) {
    let context = "";
    try {
      const retrieved = await store.semanticSearch(qa.question, { limit: k });
      context = retrieved.map((r) => `[${r.domain}] ${r.description}`).join("\n");
    } catch {
      context = "";
    }

    let text = "";
    try {
      const resp = await generate(
        {
          prompt: qa.question,
          systemContext:
            "You are a COBOL mainframe analyst. Answer the question concisely using ONLY the provided context.\n\nContext:\n" +
            context,
          maxTokens: 256,
          temperature: 0.1,
        },
        cfg,
      );
      text = resp.text;
    } catch {
      text = ""; // a failed generation scores as an empty (wrong) answer
    }
    results.push({ prediction: text, golden: qa.expectedAnswer });
  }

  const aggregate = calculateAggregateMetrics(results);
  const metrics: MetricResult[] = [
    metricFromStat("answer_correctness", aggregate.correctness, aggregate.count),
    metricFromStat("answer_em", aggregate.EM, aggregate.count),
    metricFromStat("answer_f1", aggregate.f1, aggregate.count),
  ];
  return { metrics, aggregate };
}

function metricFromStat(
  name: string,
  stat: { mean: number; ci_lower: number; ci_upper: number },
  count: number,
): MetricResult {
  return {
    name,
    value: stat.mean,
    details: { ci_lower: stat.ci_lower, ci_upper: stat.ci_upper, count },
    timestamp: Date.now(),
  };
}

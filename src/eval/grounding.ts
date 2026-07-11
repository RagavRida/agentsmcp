/**
 * HONEST grounding evaluation.
 *
 * Replaces the previous hardcoded `groundingScore(0, 1000, [])` (a constant
 * 1.0). This runs the real FLARE active-retrieval engine over the corpus index
 * and feeds its actual cycle/token/logprob output into `groundingScore`.
 *
 * Gated on BOTH a vLLM logprob endpoint AND a retrieval index; otherwise
 * grounding is `notMeasured` (never fabricated).
 */

import type { VectorStore } from "../vector/store";
import { FlareEngine } from "../flare/active-rag";
import { groundingScore, notMeasured, type MetricResult } from "./index";
import type { QAPair } from "./runner";

export async function evaluateGrounding(
  store: VectorStore | null,
  qaPairs: QAPair[],
): Promise<MetricResult> {
  const vllmUrl = process.env.AGENTSMCP_VLLM_URL || process.env.VLLM_URL;

  if (!vllmUrl || !store) {
    const reason = !vllmUrl
      ? "AGENTSMCP_VLLM_URL unset — FLARE grounding requires a vLLM logprob endpoint"
      : "AGENTSMCP_MODAL_EMBED_URL unset — no retrieval index for FLARE";
    return notMeasured("grounding_score", reason);
  }

  const engine = new FlareEngine(store, { vllmUrl });

  // Prefer FLARE-routed questions; fall back to all if none are tagged.
  const flareQuestions = qaPairs.filter((qa) => qa.expectedStrategy === "FLARE");
  const target = flareQuestions.length > 0 ? flareQuestions : qaPairs;

  let totalCycles = 0;
  let totalTokens = 0;
  const retrievals: Array<{ logprob: number }> = [];
  let ran = 0;

  for (const qa of target) {
    let context = "";
    try {
      const r = await store.semanticSearch(qa.question, { limit: 5 });
      context = r.map((x) => `[${x.domain}] ${x.description}`).join("\n");
    } catch {
      context = "";
    }
    try {
      const res = await engine.generate(qa.question, context);
      totalCycles += res.flareCycles;
      totalTokens += res.totalTokens;
      for (const rt of res.retrievals) retrievals.push({ logprob: rt.logprob });
      ran++;
    } catch {
      // a failed FLARE call is skipped; if none succeed we report notMeasured
    }
  }

  if (ran === 0 || totalTokens === 0) {
    return notMeasured("grounding_score", "FLARE endpoint produced no measurable generation");
  }

  return groundingScore(totalCycles, totalTokens, retrievals);
}

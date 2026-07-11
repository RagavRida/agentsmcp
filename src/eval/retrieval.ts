/**
 * HONEST retrieval evaluation.
 *
 * Replaces the previous simulation (which scored the gold `relevantNodeIds`
 * against themselves → a tautological recall/MRR of ~1.0). This runs REAL
 * semantic search over a real vector index and scores results against the gold
 * rules.
 *
 * Id-scheme reconciliation: gold `relevantNodeIds` are descriptive synthetic
 * ids (e.g. `COMPUTE-WS-DTI`) while the indexer assigns `PROGRAM::sem_N`
 * counters, so exact-id recall is always 0. We instead score by DESCRIPTION
 * keyword overlap — the same fuzzy matcher `parserAccuracy` uses — mapping each
 * gold id to its rule description via the corpus.
 */

import type { VectorStore } from "../vector/store";
import type { CorpusEntry, QAPair } from "./runner";
import { extractKeywords, keywordOverlap, notMeasured, type MetricResult } from "./index";

const OVERLAP_THRESHOLD = 0.15; // matches parserAccuracy's fuzzy-match threshold

export interface RetrievalRow {
  question: string;
  strategy: string;
  hits: number;
  mrr: number;
}

export interface RetrievalEvalResult {
  metric: MetricResult;
  rows: RetrievalRow[];
}

/**
 * Score a single retrieval against gold descriptions by keyword overlap.
 * A retrieved doc is "relevant" if it overlaps ANY gold description above
 * threshold. Exported for unit testing without a network/embedding endpoint.
 */
export function scoreRetrievalByDescription(
  retrievedDescriptions: string[],
  goldDescriptions: string[],
): { recall: number; precision: number; mrr: number; hits: number } {
  if (goldDescriptions.length === 0) {
    return { recall: 0, precision: 0, mrr: 0, hits: 0 };
  }
  const goldKw = goldDescriptions.map(extractKeywords);
  const retrievedKw = retrievedDescriptions.map(extractKeywords);

  // recall: how many distinct gold rules were matched by some retrieved doc
  const matchedGold = goldKw.filter((gk) =>
    retrievedKw.some((rk) => keywordOverlap(gk, rk) >= OVERLAP_THRESHOLD),
  ).length;

  // precision + MRR: which retrieved docs (and at what rank) match some gold
  let relevantRetrieved = 0;
  let firstRelevantRank = 0;
  retrievedKw.forEach((rk, idx) => {
    const isRelevant = goldKw.some((gk) => keywordOverlap(gk, rk) >= OVERLAP_THRESHOLD);
    if (isRelevant) {
      relevantRetrieved++;
      if (firstRelevantRank === 0) firstRelevantRank = idx + 1;
    }
  });

  return {
    recall: matchedGold / goldDescriptions.length,
    precision: retrievedKw.length > 0 ? relevantRetrieved / retrievedKw.length : 0,
    mrr: firstRelevantRank > 0 ? 1 / firstRelevantRank : 0,
    hits: matchedGold,
  };
}

/**
 * Evaluate retrieval quality over a corpus + QA set.
 * @param store the built corpus index, or null when embeddings aren't configured
 */
export async function evaluateRetrieval(
  store: VectorStore | null,
  corpus: CorpusEntry[],
  qaPairs: QAPair[],
  k = 5,
): Promise<RetrievalEvalResult> {
  const strategyOf = makeStrategyResolver();

  if (!store) {
    return {
      metric: notMeasured(
        `search_relevance@${k}`,
        "AGENTSMCP_MODAL_EMBED_URL unset — refusing to report hashEmbed (semantically random) retrieval numbers",
      ),
      rows: qaPairs.map((qa) => ({ question: qa.question, strategy: strategyOf(qa.question), hits: 0, mrr: 0 })),
    };
  }

  // gold id -> description, from the corpus expectedRules
  const goldDescById = new Map<string, string>();
  for (const entry of corpus) {
    for (const r of entry.expectedRules) goldDescById.set(r.id, r.description);
  }

  const recallScores: number[] = [];
  const precisionScores: number[] = [];
  const mrrScores: number[] = [];
  const rows: RetrievalRow[] = [];
  let scored = 0;

  for (const qa of qaPairs) {
    const strategy = strategyOf(qa.question);
    const goldDescriptions = (qa.relevantNodeIds ?? [])
      .map((id) => goldDescById.get(id))
      .filter((d): d is string => !!d);

    if (goldDescriptions.length === 0) {
      // no gold to score against — reported but excluded from the aggregate
      rows.push({ question: qa.question, strategy, hits: 0, mrr: 0 });
      continue;
    }

    let retrievedDescriptions: string[];
    try {
      const retrieved = await store.semanticSearch(qa.question, { limit: k });
      retrievedDescriptions = retrieved.map((r) => r.description);
    } catch {
      rows.push({ question: qa.question, strategy: "ERROR", hits: 0, mrr: 0 });
      continue;
    }

    const s = scoreRetrievalByDescription(retrievedDescriptions, goldDescriptions);
    recallScores.push(s.recall);
    precisionScores.push(s.precision);
    mrrScores.push(s.mrr);
    scored++;
    rows.push({ question: qa.question, strategy, hits: s.hits, mrr: round(s.mrr) });
  }

  if (scored === 0) {
    return {
      metric: notMeasured(`search_relevance@${k}`, "no QA pairs had gold relevantNodeIds to score against"),
      rows,
    };
  }

  const meanRecall = mean(recallScores);
  const metric: MetricResult = {
    name: `search_relevance@${k}`,
    value: round(meanRecall),
    details: {
      recall_at_k: round(meanRecall),
      precision_at_k: round(mean(precisionScores)),
      mrr: round(mean(mrrScores)),
      scored_questions: scored,
      k,
      scoring: "description-keyword-overlap",
    },
    timestamp: Date.now(),
  };
  return { metric, rows };
}

// Resolve the routed strategy defensively (route table lives in memory/api).
function makeStrategyResolver(): (question: string) => string {
  let routeQuery: ((q: string) => { strategy: string }) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    routeQuery = require("../memory/api").routeQuery;
  } catch {
    routeQuery = undefined;
  }
  return (question: string) => {
    try {
      return routeQuery ? routeQuery(question).strategy : "VECTOR";
    } catch {
      return "VECTOR";
    }
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

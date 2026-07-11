/**
 * Corpus indexing for HONEST retrieval evaluation.
 *
 * Builds a real in-memory vector index over the corpus using the SAME
 * embedding path production uses (the Modal GPU endpoint). This is GATED on
 * `AGENTSMCP_MODAL_EMBED_URL`: without it, `VectorStore.embed` silently falls
 * back to the semantically-random 384-dim hashEmbed, so we refuse to index at
 * all and let callers report retrieval as `notMeasured` rather than publish
 * meaningless numbers.
 *
 * The index is built once per eval run and shared by the retrieval, answer
 * -quality, and grounding helpers (avoids re-embedding the corpus three times).
 */

import { VectorStore } from "../vector/store";
import { parseProgramInProcess } from "../distributed/worker";
import type { CorpusEntry } from "./runner";

/** True when a real embedding endpoint is configured (not the hash fallback). */
export function isEmbeddingConfigured(): boolean {
  return !!process.env.AGENTSMCP_MODAL_EMBED_URL;
}

/**
 * Parse + embed + index every corpus program into a fresh in-memory store.
 * Returns `null` when no real embedding endpoint is configured — callers MUST
 * treat null as "retrieval not measurable" and never fall back to hashEmbed.
 */
export async function buildCorpusIndex(corpus: CorpusEntry[]): Promise<VectorStore | null> {
  const modalUrl = process.env.AGENTSMCP_MODAL_EMBED_URL;
  if (!modalUrl) return null;

  const store = new VectorStore(":memory:", modalUrl);
  for (const entry of corpus) {
    let parsed;
    try {
      parsed = parseProgramInProcess({
        programId: entry.programId,
        source: entry.source,
        filename: `${entry.programId}.CBL`,
      });
    } catch {
      continue; // a program that fails to parse simply isn't indexed
    }

    const rules = parsed.extractedRules ?? [];
    if (rules.length === 0) continue;

    const descriptions = rules.map((r) => r.description);
    const embeddings = await store.embed(descriptions, "passage");
    store.upsertMany(
      rules.map((r, i) => ({
        id: `${entry.programId}::${r.id}`,
        program: entry.programId,
        nodeType: r.type,
        domain: entry.domain ?? "Unknown",
        description: r.description,
        embedding: embeddings[i],
      })),
    );
  }
  return store;
}

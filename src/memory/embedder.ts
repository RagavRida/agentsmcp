import type { VectorStoreLike } from "../vector/interface";

const DEFAULT_DIMS = 384;

/**
 * Deterministic local embedder for dev/test when no Modal GPU endpoint is set.
 */
export function hashEmbed(text: string, dims = DEFAULT_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const normalized = text.toLowerCase().trim();
  for (let i = 0; i < normalized.length; i++) {
    const idx = (normalized.charCodeAt(i) * (i + 1)) % dims;
    vec[idx] += 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export function createEmbedder(
  vectorStore: Pick<VectorStoreLike, "embed">,
): (texts: string[]) => Promise<number[][]> {
  return (texts) => vectorStore.embed(texts, "passage");
}

export function createQueryEmbedder(
  vectorStore: Pick<VectorStoreLike, "embed">,
): (texts: string[]) => Promise<number[][]> {
  return (texts) => vectorStore.embed(texts, "query");
}

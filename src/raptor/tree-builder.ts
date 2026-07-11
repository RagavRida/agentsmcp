// ============================================================
// RAPTOR — Recursive Abstractive Processing for Tree-Organized Retrieval
//
// Instead of flat vector search, we build a hierarchical tree:
//   Level 0: Individual business rules (leaf nodes)
//   Level 1: Paragraph-level summaries (cluster of rules)
//   Level 2: Program-level summaries (cluster of paragraphs)
//   Level 3: System-level overview (root)
//
// Search is top-down: O(log N) instead of O(N).
// The AI navigates from architecture → specific code.
// ============================================================

import type { VectorStoreLike } from "../vector/interface";
import { resolve as resolveStoreOp } from "../vector/interface";
import type { VectorEntry, SearchResult } from "../vector/store";

export interface RaptorNode {
  id: string;
  level: number;
  description: string;
  domain: string;
  program: string;
  childIds: string[];
  embedding?: number[];
}

export interface RaptorTree {
  root: RaptorNode;
  levels: Map<number, RaptorNode[]>;
  totalNodes: number;
  depth: number;
}

export class RaptorTreeBuilder {
  private vectorStore: VectorStoreLike;
  private summarizer: (texts: string[]) => Promise<string>;

  constructor(
    vectorStore: VectorStoreLike,
    summarizer: (texts: string[]) => Promise<string>,
  ) {
    this.vectorStore = vectorStore;
    this.summarizer = summarizer;
  }

  /**
   * Build a RAPTOR tree from flat semantic nodes.
   *
   * Algorithm:
   * 1. Level 0 = all individual nodes (already in vector store)
   * 2. Cluster Level 0 by domain + program
   * 3. Summarize each cluster → Level 1
   * 4. Embed Level 1 summaries → store with level=1
   * 5. Cluster Level 1 by program → summarize → Level 2
   * 6. Repeat until ≤ 5 root nodes → Level N
   */
  async buildTree(
    nodes: VectorEntry[],
    options?: { maxClusterSize?: number },
  ): Promise<RaptorTree> {
    const maxClusterSize = options?.maxClusterSize ?? 10;
    const levels = new Map<number, RaptorNode[]>();

    // Level 0: individual nodes
    const level0: RaptorNode[] = nodes.map((n) => ({
      id: n.id,
      level: 0,
      description: n.description,
      domain: n.domain,
      program: n.program,
      childIds: [],
      embedding: n.embedding,
    }));
    levels.set(0, level0);

    let currentLevel = level0;
    let levelNum = 0;

    // Build up the tree until we have ≤ 5 nodes at the top
    while (currentLevel.length > 5) {
      levelNum++;
      const clusters = this.clusterNodes(currentLevel, maxClusterSize);
      const nextLevel: RaptorNode[] = [];

      for (const cluster of clusters) {
        // Summarize the cluster
        const descriptions = cluster.map((n) => n.description);
        const summary = await this.summarizer(descriptions);

        // Determine the dominant domain
        const domainCounts: Record<string, number> = {};
        for (const n of cluster) {
          domainCounts[n.domain] = (domainCounts[n.domain] || 0) + 1;
        }
        const dominantDomain = Object.entries(domainCounts)
          .sort((a, b) => b[1] - a[1])[0][0];

        // Determine the program (or "MULTI" if spanning programs)
        const programs = new Set(cluster.map((n) => n.program));
        const program = programs.size === 1
          ? cluster[0].program
          : `MULTI(${[...programs].join(",")})`;

        // Embed the summary
        const [embedding] = await this.vectorStore.embed([summary], "passage");

        const node: RaptorNode = {
          id: `raptor:L${levelNum}:${nextLevel.length}`,
          level: levelNum,
          description: summary,
          domain: dominantDomain,
          program,
          childIds: cluster.map((n) => n.id),
          embedding,
        };
        nextLevel.push(node);

        // Store the summary vector
        await resolveStoreOp(this.vectorStore.upsert({
          id: node.id,
          program: node.program,
          nodeType: `RAPTOR_L${levelNum}`,
          domain: node.domain,
          description: node.description,
          embedding,
          metadata: {
            level: levelNum,
            childCount: cluster.length,
            childIds: node.childIds,
          },
        }));
      }

      levels.set(levelNum, nextLevel);
      currentLevel = nextLevel;
    }

    // Create root node if there are multiple top-level nodes
    let root: RaptorNode;
    if (currentLevel.length > 1) {
      const rootSummary = await this.summarizer(
        currentLevel.map((n) => n.description),
      );
      const [rootEmbedding] = await this.vectorStore.embed([rootSummary], "passage");

      root = {
        id: "raptor:root",
        level: levelNum + 1,
        description: rootSummary,
        domain: "System",
        program: "ALL",
        childIds: currentLevel.map((n) => n.id),
        embedding: rootEmbedding,
      };
      levels.set(levelNum + 1, [root]);
    } else {
      root = currentLevel[0];
    }

    return {
      root,
      levels,
      totalNodes: Array.from(levels.values()).reduce((sum, l) => sum + l.length, 0),
      depth: levels.size,
    };
  }

  /**
   * Search the tree top-down (hierarchical retrieval).
   *
   * 1. Compare query to root's children
   * 2. Pick the best-matching branch
   * 3. Drill into its children
   * 4. Return the leaf nodes (actual business rules)
   */
  async search(
    query: string,
    tree: RaptorTree,
    options?: { beamWidth?: number; maxResults?: number },
  ): Promise<SearchResult[]> {
    const beamWidth = options?.beamWidth ?? 3;
    const maxResults = options?.maxResults ?? 10;

    // Embed the query
    const [queryVec] = await this.vectorStore.embed([query], "query");

    // Start from the root's children
    let candidates = tree.root.childIds
      .map((id) => this.findNodeById(tree, id))
      .filter((n): n is RaptorNode => n !== undefined);

    // Drill down through the tree
    while (candidates.length > 0 && candidates[0].level > 0) {
      // Score candidates against query
      const scored = candidates
        .filter((c) => c.embedding)
        .map((c) => ({
          node: c,
          score: cosineSimilarity(queryVec, c.embedding!),
        }))
        .sort((a, b) => b.score - a.score);

      // Take top beamWidth branches
      const bestBranches = scored.slice(0, beamWidth);

      // Expand to their children
      candidates = bestBranches.flatMap((b) =>
        b.node.childIds
          .map((id) => this.findNodeById(tree, id))
          .filter((n): n is RaptorNode => n !== undefined),
      );
    }

    // Score the leaf nodes
    const leafResults: SearchResult[] = candidates
      .filter((c) => c.embedding)
      .map((c) => ({
        id: c.id,
        program: c.program,
        nodeType: `RAPTOR_L${c.level}`,
        domain: c.domain,
        description: c.description,
        score: cosineSimilarity(queryVec, c.embedding!),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return leafResults;
  }

  // ── Clustering ─────────────────────────────────────────────

  /**
   * Simple domain + program clustering.
   * Groups nodes by (domain, program) first, then splits large groups.
   */
  private clusterNodes(
    nodes: RaptorNode[],
    maxSize: number,
  ): RaptorNode[][] {
    // Group by domain + program
    const groups = new Map<string, RaptorNode[]>();
    for (const node of nodes) {
      const key = `${node.domain}::${node.program}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(node);
    }

    // Split groups that are too large
    const clusters: RaptorNode[][] = [];
    for (const group of groups.values()) {
      if (group.length <= maxSize) {
        clusters.push(group);
      } else {
        // Simple chunking for now (could use k-means on embeddings)
        for (let i = 0; i < group.length; i += maxSize) {
          clusters.push(group.slice(i, i + maxSize));
        }
      }
    }

    return clusters;
  }

  private findNodeById(tree: RaptorTree, id: string): RaptorNode | undefined {
    for (const level of tree.levels.values()) {
      const found = level.find((n) => n.id === id);
      if (found) return found;
    }
    return undefined;
  }
}

// ── Math ────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

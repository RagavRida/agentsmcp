/**
 * AgentMailbox Memory API — Cognee-inspired
 *
 * Wraps the 7-pillar pipeline behind 3 simple calls:
 *   remember(source)  → parse + embed + RAPTOR tree + graph + BYOS
 *   recall(query)      → auto-routes to best search strategy
 *   forget(program)    → cascade delete from all stores
 *
 * Plus:
 *   improve()          → re-index, re-embed, rebuild RAPTOR tree
 *
 * Inspired by cognee's remember/recall/forget API but adapted for
 * COBOL migration with deterministic parsing, semantic verification,
 * and banking-specific safety invariants.
 */

import type { SearchResult } from "../vector/store";
import type { VectorStoreLike } from "../vector/interface";
import { resolve as resolveStoreOp } from "../vector/interface";
import type { RaptorTreeBuilder, RaptorTree } from "../raptor/tree-builder";
import type { RaptorTreeStore } from "../raptor/tree-store";
import type { Neo4jSync, ImpactResult } from "../graph/neo4j-sync";
import type { TrajectoryLogger } from "../trajectory/logger";
import type { FlareEngine, FlareResult } from "../flare/active-rag";
import type { BYOSClient } from "../storage/byos";
import type { MainframeLanguage, ParseCobolResult, ParseMainframeResult } from "../parser";
import type { SessionManager } from "../session/manager";
import { runCognifyPipeline } from "../modules/cognify/pipeline";
import { MDPNavigator, planQuery, type NavigatorResult, type NavigatorStrategy, type NavigatorTool } from "./mdp-navigator";

// ── Query Router ───────────────────────────────────────────
// Rule-based query classification (no LLM call needed)
// Inspired by cognee's query_router.py

export type SearchStrategy = NavigatorStrategy;
export type RouteResult = ReturnType<typeof planQuery>;

/** @deprecated Use MDPNavigator through Memory.recall(). */
function routeQuery(query: string): RouteResult {
  return planQuery(query);
}

// ── Result Types ───────────────────────────────────────────

export interface RememberResult {
  status: "completed" | "errored";
  program: string;
  rulesExtracted: number;
  vectorsStored: number;
  graphNodesSynced: number;
  raptorTreeDepth: number;
  byosUploaded: boolean;
  elapsedMs: number;
  error?: string;
}

export interface RecallResult {
  query: string;
  strategy: SearchStrategy;
  routeConfidence: number;
  results: SearchResult[];
  flareResult?: FlareResult;
  impactResult?: ImpactResult;
  elapsedMs: number;
}

export interface ForgetResult {
  program: string;
  vectorsDeleted: number;
  graphNodesDeleted: number;
  raptorPruned: boolean;
  byosDeleted: boolean;
  trajectoryCleared: boolean;
}

// ── The Memory API ─────────────────────────────────────────

export interface MemoryConfig {
  vectorStore: VectorStoreLike;
  raptorBuilder: RaptorTreeBuilder;
  raptorTreeStore: RaptorTreeStore;
  neo4jSync?: Neo4jSync;
  trajectory?: TrajectoryLogger;
  flareEngine?: FlareEngine;
  byosClient?: BYOSClient;
  parser?: (
    source: string,
    options?: { filename?: string; language?: MainframeLanguage }
  ) => ParseCobolResult | ParseMainframeResult;
  embedder: (texts: string[]) => Promise<number[][]>;
  sessionManager?: SessionManager;
  sessionAgentId?: string;
}

export class Memory {
  private config: MemoryConfig;
  private raptorTrees = new Map<string, RaptorTree>();
  private treesLoaded = false;

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  private writeSession(sessionId: string, key: string, value: unknown): void {
    this.config.sessionManager?.set(
      sessionId,
      this.config.sessionAgentId ?? "memory-api",
      key,
      value,
      { source: "pipeline" },
    );
  }

  private readSession(sessionId: string, key: string): unknown | null {
    return this.config.sessionManager?.get(sessionId, key) ?? null;
  }

  private readSessionAll(sessionId: string): Record<string, unknown> {
    return this.config.sessionManager?.getAll(sessionId) ?? {};
  }

  private clearSession(sessionId: string): void {
    this.config.sessionManager?.clear(sessionId);
  }

  private async ensureTreesLoaded(): Promise<void> {
    if (this.treesLoaded) return;
    const trees = await this.config.raptorTreeStore.loadAll();
    for (const [program, tree] of trees) {
      this.raptorTrees.set(program, tree);
    }
    this.treesLoaded = true;
  }

  private async vectorSearch(
    queryVector: number[],
    options?: { limit?: number; domain?: string; program?: string },
  ): Promise<SearchResult[]> {
    return resolveStoreOp(this.config.vectorStore.search(queryVector, options));
  }

  private async navigateRecall(
    query: string,
    topK: number,
    program?: string,
    override?: SearchStrategy,
  ): Promise<NavigatorResult> {
    const tools: NavigatorTool[] = [
      {
        strategy: "VECTOR",
        description: "Semantic vector search over indexed business rules",
        execute: async () => {
          const [embedding] = await this.config.embedder([query]);
          return { results: await this.vectorSearch(embedding, { limit: topK, program }) };
        },
      },
      {
        strategy: "RAPTOR",
        description: "Hierarchical program and domain summary search",
        execute: async () => {
          await this.ensureTreesLoaded();
          const trees = program && this.raptorTrees.has(program)
            ? [this.raptorTrees.get(program)!]
            : [...this.raptorTrees.values()];
          if (trees.length === 0) return tools[0].execute();
          const results = (await Promise.all(trees.map((tree) =>
            this.config.raptorBuilder.search(query, tree, { maxResults: topK }),
          ))).flat().sort((a, b) => b.score - a.score).slice(0, topK);
          return { results };
        },
      },
      {
        strategy: "GRAPH",
        description: "Dependency and impact traversal through the knowledge graph",
        execute: async () => {
          const entity = query.split(/\s+/).find((part) => /^[A-Z][A-Z0-9-]{2,}$/.test(part)) ?? query;
          const impactResult = this.config.neo4jSync
            ? await this.config.neo4jSync.impactAnalysis(entity)
            : undefined;
          const [embedding] = await this.config.embedder([query]);
          return { impactResult, results: await this.vectorSearch(embedding, { limit: topK, program }) };
        },
      },
      {
        strategy: "FLARE",
        description: "Uncertainty-triggered retrieval with grounded generation",
        execute: async () => {
          const flareResult = this.config.flareEngine
            ? await this.config.flareEngine.generate(query, "You are a COBOL analysis assistant.")
            : undefined;
          const [embedding] = await this.config.embedder([query]);
          return { flareResult, results: await this.vectorSearch(embedding, { limit: topK, program }) };
        },
      },
      {
        strategy: "TRAJECTORY",
        description: "Auditable history and interaction search",
        execute: async () => {
          if (!this.config.trajectory) return { results: [] };
          const queryLower = query.toLowerCase();
          const results = this.config.trajectory.getTrajectory()
            .filter((entry: { input: string; output: string; sources: string[] }) =>
              entry.input.toLowerCase().includes(queryLower) ||
              entry.output.toLowerCase().includes(queryLower) ||
              entry.sources.some((source) => source.toLowerCase().includes(queryLower)),
            )
            .map((entry: { input: string; output: string; action: string; sources: string[] }) => ({
              id: `trajectory::${entry.input}`,
              program: entry.sources[0] ?? "UNKNOWN",
              nodeType: "TRAJECTORY",
              domain: "Audit",
              description: `[${entry.action}] ${entry.output}`,
              score: 1,
            }));
          return { results };
        },
      },
      {
        strategy: "HYBRID",
        description: "Combined vector and graph evidence",
        execute: async () => {
          const [embedding] = await this.config.embedder([query]);
          return {
            impactResult: this.config.neo4jSync
              ? await this.config.neo4jSync.impactAnalysis(query)
              : undefined,
            results: await this.vectorSearch(embedding, { limit: topK, program }),
          };
        },
      },
    ];
    return new MDPNavigator({ maxSteps: 2 }).run(query, tools, override);
  }

  // ────────────────────────────────────────────────────────
  // remember(source, opts?)
  //
  // Single call that runs the ENTIRE 7-pillar pipeline:
  //   1. Parse COBOL → semantic nodes
  //   2. Embed descriptions → vectors
  //   3. Store in VectorStore
  //   4. Build RAPTOR tree
  //   5. Sync to Neo4j graph
  //   6. Upload to BYOS
  //   7. Log trajectory
  // ────────────────────────────────────────────────────────

  async remember(
    source: string,
    opts?: {
      sessionId?: string;
      dataset?: string;
      filename?: string;
      language?: MainframeLanguage;
    }
  ): Promise<RememberResult> {
    const start = Date.now();
    const dataset = opts?.dataset ?? "main";

    try {
      return await runCognifyPipeline({
        source,
        dataset,
        sessionId: opts?.sessionId,
        filename: opts?.filename,
        language: opts?.language,
      }, this.config, (program, tree) => this.raptorTrees.set(program, tree));
    } catch (err) {
      return {
        status: "errored",
        program: "UNKNOWN",
        rulesExtracted: 0,
        vectorsStored: 0,
        graphNodesSynced: 0,
        raptorTreeDepth: 0,
        byosUploaded: false,
        elapsedMs: Date.now() - start,
        error: String(err),
      };
    }
  }

  // ────────────────────────────────────────────────────────
  // recall(query, opts?)
  //
  // Auto-routes to the best search strategy:
  //   "what does LOAN-PROC do?"       → RAPTOR (high-level summary)
  //   "what calls FRAUD-DETECTOR?"    → GRAPH (relationship traversal)
  //   "similar to overdraft logic"    → VECTOR (semantic search)
  //   "explain the interest calc"     → FLARE (confidence-grounded)
  //   "when was LOAN-PROC parsed?"    → TRAJECTORY (audit log)
  // ────────────────────────────────────────────────────────

  async recall(
    query: string,
    opts?: {
      sessionId?: string;
      strategy?: SearchStrategy; // override auto-routing
      topK?: number;
      program?: string;
    }
  ): Promise<RecallResult> {
    const start = Date.now();
    const topK = opts?.topK ?? 5;

    const route = await this.navigateRecall(query, topK, opts?.program, opts?.strategy);

    // Log to session if active
    if (opts?.sessionId) {
      this.writeSession(opts.sessionId, "lastQuery", query);
      this.writeSession(opts.sessionId, "lastStrategy", route.strategy);
    }

    // Track in trajectory
    if (this.config.trajectory) {
      this.config.trajectory.log({
        action: "VECTOR_SEARCH",
        input: query,
        output: `Routed to ${route.strategy} (confidence: ${route.confidence})`,
        sources: [opts?.program ?? "GLOBAL"],
        latencyMs: 0,
      });
    }

    return {
      query,
      strategy: route.strategy,
      routeConfidence: route.confidence,
      results: route.results,
      flareResult: route.flareResult as FlareResult | undefined,
      impactResult: route.impactResult as ImpactResult | undefined,
      elapsedMs: Date.now() - start,
    };

    /* Legacy inline dispatch retained in git history; MDPNavigator is the sole runtime path.
    let results: SearchResult[] = [];
    let flareResult: FlareResult | undefined;
    let impactResult: ImpactResult | undefined;

    switch (route.strategy) {
      case "VECTOR": {
        const queryEmb = await this.config.embedder([query]);
        results = await this.vectorSearch(queryEmb[0], { limit: topK });
        break;
      }

      case "RAPTOR": {
        await this.ensureTreesLoaded();
        if (opts?.program && this.raptorTrees.has(opts.program)) {
          results = await this.config.raptorBuilder.search(
            query,
            this.raptorTrees.get(opts.program)!,
            { maxResults: topK },
          );
        } else if (this.raptorTrees.size > 0) {
          const merged: SearchResult[] = [];
          for (const tree of this.raptorTrees.values()) {
            const partial = await this.config.raptorBuilder.search(query, tree, {
              maxResults: topK,
            });
            merged.push(...partial);
          }
          merged.sort((a, b) => b.score - a.score);
          results = merged.slice(0, topK);
        } else {
          const queryEmb = await this.config.embedder([query]);
          results = await this.vectorSearch(queryEmb[0], { limit: topK });
        }
        break;
      }

      case "GRAPH": {
        if (this.config.neo4jSync) {
          const entityMatch = query.match(/\b([A-Z][A-Z0-9-]{2,})\b/);
          const entity = entityMatch?.[1] ?? query;
          impactResult = await this.config.neo4jSync.impactAnalysis(entity);
          const queryEmb = await this.config.embedder([query]);
          results = await this.vectorSearch(queryEmb[0], { limit: topK });
        } else {
          const queryEmb = await this.config.embedder([query]);
          results = await this.vectorSearch(queryEmb[0], { limit: topK });
        }
        break;
      }

      case "FLARE": {
        if (this.config.flareEngine) {
          flareResult = await this.config.flareEngine.generate(query, "You are a COBOL analysis assistant.");
        }
        const queryEmb2 = await this.config.embedder([query]);
        results = await this.vectorSearch(queryEmb2[0], { limit: topK });
        break;
      }

      case "TRAJECTORY": {
        if (this.config.trajectory) {
          const entries = this.config.trajectory.getTrajectory();
          const queryLower = query.toLowerCase();
          const filtered = entries.filter((e: { input: string; output: string; sources: string[] }) =>
            e.input.toLowerCase().includes(queryLower) ||
            e.output.toLowerCase().includes(queryLower) ||
            e.sources.some((s: string) => s.toLowerCase().includes(queryLower))
          );
          results = filtered.map((e: { input: string; output: string; action: string; sources: string[] }) => ({
            id: `trajectory::${e.input}`,
            program: e.sources[0] ?? "UNKNOWN",
            nodeType: "TRAJECTORY",
            domain: "Audit",
            description: `[${e.action}] ${e.output}`,
            score: 1.0,
          }));
        }
        break;
      }

      case "HYBRID": {
        const queryEmb = await this.config.embedder([query]);
        results = await this.vectorSearch(queryEmb[0], { limit: topK });
        const graphImpact = this.config.neo4jSync
          ? await this.config.neo4jSync.impactAnalysis(query)
          : undefined;
        impactResult = graphImpact;
        break;
      }
    }

    return {
      query,
      strategy: route.strategy,
      routeConfidence: route.confidence,
      results,
      flareResult,
      impactResult,
      elapsedMs: Date.now() - start,
    };
    */
  }

  // ────────────────────────────────────────────────────────
  // forget(program, opts?)
  //
  // Cascade delete from ALL stores:
  //   VectorStore → delete all vectors for program
  //   RAPTOR tree → prune program's tree
  //   Neo4j       → delete all graph nodes for program
  //   BYOS        → delete S3 artifacts
  //   Trajectory  → clear audit log
  // ────────────────────────────────────────────────────────

  async forget(
    program: string,
    opts?: { dataset?: string; memoryOnly?: boolean }
  ): Promise<ForgetResult> {
    const dataset = opts?.dataset ?? "main";

    // P3: Vector Store — cascade delete all vectors for this program
    const vectorsDeleted = await resolveStoreOp(
      this.config.vectorStore.deleteByProgram(program),
    );

    // P4: RAPTOR Tree
    const raptorPruned = this.raptorTrees.delete(program);
    await this.config.raptorTreeStore.delete(program);

    // P5: Neo4j Graph — cascade delete all nodes/edges for this program
    let graphNodesDeleted = 0;
    if (this.config.neo4jSync) {
      graphNodesDeleted = await this.config.neo4jSync.deleteProgram(program);
    }

    // P6: BYOS — no generic delete on BYOSClient interface
    const byosDeleted = false;

    // P7: Trajectory
    const trajectoryCleared = false;
    // Note: TrajectoryLogger is append-only by design (audit compliance)

    // Log the deletion itself
    if (this.config.trajectory) {
      this.config.trajectory.log({
        action: "PARSE",
        input: `forget:${program}`,
        output: `Deleted ${vectorsDeleted} vectors, ${graphNodesDeleted} graph nodes`,
        sources: [program],
        latencyMs: 0,
      });
    }

    return {
      program,
      vectorsDeleted,
      graphNodesDeleted,
      raptorPruned,
      byosDeleted,
      trajectoryCleared,
    };
  }

  // ────────────────────────────────────────────────────────
  // improve(program)
  //
  // Re-process a program: re-embed, rebuild RAPTOR tree,
  // re-sync graph. Like cognee's improve() but deterministic.
  // ────────────────────────────────────────────────────────

  async improve(program: string, source: string): Promise<RememberResult> {
    await this.forget(program, { memoryOnly: true });
    return this.remember(source, { dataset: "main" });
  }

  // ── Session Memory Access ────────────────────────────────

  sessionGet(sessionId: string, key: string): unknown | null {
    return this.readSession(sessionId, key);
  }

  sessionSet(sessionId: string, key: string, value: unknown): void {
    this.writeSession(sessionId, key, value);
  }

  sessionGetAll(sessionId: string): Record<string, unknown> {
    return this.readSessionAll(sessionId);
  }

  sessionClear(sessionId: string): void {
    this.clearSession(sessionId);
  }

  // ── Utility ──────────────────────────────────────────────

  /** Expose the query router for testing/debugging */
  routeQuery(query: string): RouteResult {
    return routeQuery(query);
  }
}

// ── Factory ────────────────────────────────────────────────
export { routeQuery };

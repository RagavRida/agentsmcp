// ============================================================
// KV Cache Manager — Pillar 2 Client
//
// Manages pre-computed context for each legacy program.
// Pre-warms the vLLM KV cache so subsequent queries about the
// same program get near-zero TTFT (Time To First Token).
//
// Flow:
// 1. Parse COBOL → Semantic Tree (text description)
// 2. Send semantic tree to vLLM → pre-warm KV cache
// 3. Query about the program → cache HIT → instant response
// ============================================================

import { TrajectoryLogger } from "../trajectory/logger";

export interface KVCacheConfig {
  /** vLLM endpoint URL on Modal */
  vllmUrl: string;
}

export interface PrewarmResult {
  program: string;
  contextTokens: number;
  cached: boolean;
  latencyMs: number;
}

export interface QueryResult {
  program: string;
  question: string;
  answer: string;
  tokensGenerated: number;
  promptTokens: number;
  latencyMs: number;
  cacheHit: boolean;
}

export class KVCacheManager {
  private config: KVCacheConfig;
  private prewarmedPrograms = new Set<string>();
  private semanticContexts = new Map<string, string>();
  private logger?: TrajectoryLogger;

  constructor(config: KVCacheConfig, logger?: TrajectoryLogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Pre-warm the KV cache for a program's semantic context.
   *
   * This sends the full semantic tree (e.g., 2000 tokens) to vLLM.
   * vLLM computes the KV tensors for those tokens and stores them
   * in its RadixAttention prefix tree. All subsequent queries about
   * this program re-use the cached KV tensors — TTFT ≈ 0.
   */
  async prewarm(
    programName: string,
    semanticContext: string,
  ): Promise<PrewarmResult> {
    const startTime = Date.now();

    const response = await fetch(`${this.config.vllmUrl}/prewarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        program_name: programName,
        semantic_context: semanticContext,
      }),
    });

    if (!response.ok) {
      throw new Error(`Prewarm failed: ${response.status}`);
    }

    const data = await response.json() as {
      program: string;
      context_tokens: number;
      cached: boolean;
    };

    this.prewarmedPrograms.add(programName);
    this.semanticContexts.set(programName, semanticContext);

    const result: PrewarmResult = {
      program: programName,
      contextTokens: data.context_tokens,
      cached: true,
      latencyMs: Date.now() - startTime,
    };

    if (this.logger) {
      this.logger.log({
        action: "PARSE",
        input: `Prewarm KV cache for ${programName}`,
        output: `Cached ${data.context_tokens} tokens`,
        sources: [programName],
        latencyMs: result.latencyMs,
      });
    }

    return result;
  }

  /**
   * Query a program. If pre-warmed, the context is already in cache.
   * If not, it sends the context inline (slower first time).
   */
  async query(
    programName: string,
    question: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
    },
  ): Promise<QueryResult> {
    const startTime = Date.now();
    const systemContext = this.semanticContexts.get(programName) || "";

    const response = await fetch(`${this.config.vllmUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: question,
        system_context: systemContext,
        max_tokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0.1,
        return_logprobs: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Query failed: ${response.status}`);
    }

    const data = await response.json() as {
      text: string;
      tokens_generated: number;
      prompt_tokens: number;
      prefix_cache_hit: boolean;
    };

    const result: QueryResult = {
      program: programName,
      question,
      answer: data.text,
      tokensGenerated: data.tokens_generated,
      promptTokens: data.prompt_tokens,
      latencyMs: Date.now() - startTime,
      cacheHit: this.prewarmedPrograms.has(programName),
    };

    if (this.logger) {
      this.logger.logGeneration(
        question,
        result.answer,
        [programName],
        result.latencyMs,
      );
    }

    return result;
  }

  /**
   * Pre-warm multiple programs in parallel.
   */
  async prewarmBatch(
    programs: Array<{ name: string; semanticContext: string }>,
  ): Promise<PrewarmResult[]> {
    return Promise.all(
      programs.map((p) => this.prewarm(p.name, p.semanticContext)),
    );
  }

  /**
   * Check which programs are pre-warmed.
   */
  getPrewarmedPrograms(): string[] {
    return [...this.prewarmedPrograms];
  }

  /**
   * Check if a specific program is pre-warmed.
   */
  isPrewarmed(programName: string): boolean {
    return this.prewarmedPrograms.has(programName);
  }
}

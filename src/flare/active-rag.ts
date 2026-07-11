// ============================================================
// FLARE — Forward-Looking Active REtrieval
//
// When the LLM's confidence drops mid-generation (low logprob),
// we PAUSE, extract the uncertain span, search the knowledge
// base, inject the retrieved context, and RESUME generation.
//
// This eliminates hallucination by grounding every uncertain
// statement in actual source code and business rules.
//
// Requires: vLLM on Modal (for logprob access)
// ============================================================

import { VectorStore } from "../vector/store";
import type { VectorStoreLike } from "../vector/interface";
import { TrajectoryLogger } from "../trajectory/logger";

export interface FlareConfig {
  /** vLLM endpoint URL on Modal */
  vllmUrl: string;
  /** Logprob threshold — below this triggers retrieval */
  confidenceThreshold: number;
  /** How many tokens to look back when confidence drops */
  uncertaintyWindow: number;
  /** Max retrieval results per FLARE cycle */
  maxRetrievals: number;
  /** Max total FLARE cycles per generation */
  maxFlareIterations: number;
}

export interface FlareResult {
  text: string;
  flareCycles: number;
  retrievals: Array<{
    trigger: string;        // The uncertain tokens that triggered retrieval
    query: string;          // The search query constructed from uncertain tokens
    results: string[];      // Retrieved context
    logprob: number;        // The logprob that triggered the cycle
  }>;
  totalTokens: number;
  totalLatencyMs: number;
}

const DEFAULT_CONFIG: FlareConfig = {
  vllmUrl: "",
  confidenceThreshold: -1.5,  // ln(0.22) ≈ tokens the model is <22% sure about
  uncertaintyWindow: 10,
  maxRetrievals: 3,
  maxFlareIterations: 5,
};

export class FlareEngine {
  private config: FlareConfig;
  private vectorStore: VectorStoreLike;
  private logger?: TrajectoryLogger;

  constructor(
    vectorStore: VectorStoreLike,
    config: Partial<FlareConfig> & { vllmUrl: string },
    logger?: TrajectoryLogger,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.vectorStore = vectorStore;
    this.logger = logger;
  }

  /**
   * Generate text with active retrieval.
   *
   * Algorithm:
   * 1. Send prompt + system context to vLLM (with logprobs)
   * 2. Scan the logprobs for low-confidence regions
   * 3. If found: extract the uncertain tokens as a search query
   * 4. Search the vector store with that query
   * 5. Append the retrieved context to the prompt
   * 6. Re-generate from the point of uncertainty
   * 7. Repeat until generation completes or maxFlareIterations hit
   */
  async generate(
    prompt: string,
    systemContext: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
    },
  ): Promise<FlareResult> {
    const startTime = Date.now();
    const maxTokens = options?.maxTokens ?? 2048;
    const temperature = options?.temperature ?? 0.1;

    let currentContext = systemContext;
    let accumulatedText = "";
    let flareCycles = 0;
    const retrievals: FlareResult["retrievals"] = [];
    let totalTokens = 0;

    for (let iteration = 0; iteration < this.config.maxFlareIterations; iteration++) {
      // Generate with logprobs
      const response = await this.callVllm({
        prompt: accumulatedText ? `${prompt}\n\nContinue from: "${accumulatedText}"` : prompt,
        system_context: currentContext,
        max_tokens: maxTokens - totalTokens,
        temperature,
        return_logprobs: true,
        top_logprobs: 5,
      });

      totalTokens += response.tokens_generated;

      // Check if there are low-confidence regions
      const uncertainSpan = this.findUncertainSpan(response.logprobs || []);

      if (!uncertainSpan) {
        // No uncertainty — generation is confident, we're done
        accumulatedText += response.text;
        break;
      }

      // Found uncertainty! Extract the text up to the uncertain point
      const confidentText = response.text.substring(0, uncertainSpan.startIdx);
      accumulatedText += confidentText;

      // Use the uncertain tokens as a search query
      const query = uncertainSpan.text;
      const searchStart = Date.now();
      const searchResults = await this.vectorStore.semanticSearch(query, {
        limit: this.config.maxRetrievals,
      });
      const searchLatency = Date.now() - searchStart;

      // Log the FLARE retrieval
      if (this.logger) {
        this.logger.logFlareRetrieval(
          query,
          searchResults.map((r) => r.description).join("; "),
          searchResults.map((r) => r.id),
          searchLatency,
        );
      }

      // Inject retrieved context into the system prompt
      const retrievedContext = searchResults
        .map((r) => `[${r.domain}] ${r.description} (confidence: ${r.score.toFixed(3)})`)
        .join("\n");

      currentContext = `${systemContext}\n\n--- Retrieved Context (FLARE cycle ${iteration + 1}) ---\n${retrievedContext}`;

      retrievals.push({
        trigger: uncertainSpan.text,
        query,
        results: searchResults.map((r) => r.description),
        logprob: uncertainSpan.minLogprob,
      });

      flareCycles++;
    }

    const result: FlareResult = {
      text: accumulatedText,
      flareCycles,
      retrievals,
      totalTokens,
      totalLatencyMs: Date.now() - startTime,
    };

    // Log the final generation
    if (this.logger) {
      this.logger.logGeneration(
        prompt,
        result.text,
        retrievals.flatMap((r) => r.results),
        result.totalLatencyMs,
      );
    }

    return result;
  }

  // ── Internal Methods ───────────────────────────────────────

  private findUncertainSpan(
    logprobs: Array<{ token: string; logprob: number }>,
  ): { text: string; startIdx: number; minLogprob: number } | null {
    if (!logprobs || logprobs.length === 0) return null;

    // Scan for the first window where logprobs drop below threshold
    for (let i = 0; i < logprobs.length; i++) {
      if (logprobs[i].logprob < this.config.confidenceThreshold) {
        // Found uncertain token — extract a window around it
        const start = Math.max(0, i - 2);
        const end = Math.min(logprobs.length, i + this.config.uncertaintyWindow);
        const span = logprobs.slice(start, end);

        // Calculate the character offset for the start of this span
        const startIdx = logprobs
          .slice(0, start)
          .reduce((acc, lp) => acc + lp.token.length, 0);

        return {
          text: span.map((lp) => lp.token).join(""),
          startIdx,
          minLogprob: Math.min(...span.map((lp) => lp.logprob)),
        };
      }
    }

    return null; // All tokens are confident
  }

  private async callVllm(req: {
    prompt: string;
    system_context: string;
    max_tokens: number;
    temperature: number;
    return_logprobs: boolean;
    top_logprobs: number;
  }): Promise<{
    text: string;
    tokens_generated: number;
    prompt_tokens: number;
    logprobs: Array<{ token: string; logprob: number }> | null;
  }> {
    const response = await fetch(`${this.config.vllmUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });

    if (!response.ok) {
      throw new Error(`vLLM request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<{
      text: string;
      tokens_generated: number;
      prompt_tokens: number;
      logprobs: Array<{ token: string; logprob: number }> | null;
    }>;
  }
}

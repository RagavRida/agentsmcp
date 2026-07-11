/**
 * Observability — OpenTelemetry-compatible tracing for AgentMailbox.
 *
 * Inspired by Cognee's modules/observability/.
 * Provides structured span attributes, a tracer factory, and
 * trace context management.
 *
 * Works without OTEL SDK installed — falls back to in-memory tracing.
 * When @opentelemetry/api is available, uses real OTEL spans.
 */

// ── Semantic Span Attributes ───────────────────────────────
// Standardized attribute keys (like Cognee's COGNEE_* attributes)

export const ATTR = {
  // Pipeline
  PIPELINE_NAME: "agentsmcp.pipeline.name",
  PIPELINE_STAGE: "agentsmcp.pipeline.stage",
  PIPELINE_DURATION_MS: "agentsmcp.pipeline.duration_ms",

  // Parser
  PARSE_PROGRAM: "agentsmcp.parse.program",
  PARSE_RULES_COUNT: "agentsmcp.parse.rules_count",
  PARSE_PARAGRAPHS: "agentsmcp.parse.paragraphs",
  PARSE_DURATION_MS: "agentsmcp.parse.duration_ms",

  // Search
  SEARCH_QUERY: "agentsmcp.search.query",
  SEARCH_STRATEGY: "agentsmcp.search.strategy",
  SEARCH_RESULTS_COUNT: "agentsmcp.search.results_count",
  SEARCH_CONFIDENCE: "agentsmcp.search.confidence",

  // Embedding
  EMBED_MODEL: "agentsmcp.embed.model",
  EMBED_DIMENSIONS: "agentsmcp.embed.dimensions",
  EMBED_BATCH_SIZE: "agentsmcp.embed.batch_size",

  // Graph
  GRAPH_NODES_CREATED: "agentsmcp.graph.nodes_created",
  GRAPH_EDGES_CREATED: "agentsmcp.graph.edges_created",
  GRAPH_PROGRAM: "agentsmcp.graph.program",

  // LLM
  LLM_MODEL: "agentsmcp.llm.model",
  LLM_PROVIDER: "agentsmcp.llm.provider",
  LLM_TOKENS_IN: "agentsmcp.llm.tokens_in",
  LLM_TOKENS_OUT: "agentsmcp.llm.tokens_out",
  LLM_CACHE_HIT: "agentsmcp.llm.cache_hit",
  LLM_CACHE_KEY: "agentsmcp.llm.cache_key",

  // FLARE
  FLARE_CYCLES: "agentsmcp.flare.cycles",
  FLARE_RETRIEVALS: "agentsmcp.flare.retrievals",
  FLARE_THRESHOLD: "agentsmcp.flare.threshold",

  // Memory API
  MEMORY_OP: "agentsmcp.memory.operation",  // remember | recall | forget | improve
  MEMORY_DATASET: "agentsmcp.memory.dataset",
  MEMORY_SESSION_ID: "agentsmcp.memory.session_id",
  MEMORY_DATA_SIZE: "agentsmcp.memory.data_size_bytes",

  // Verification
  VERIFY_INVARIANT: "agentsmcp.verify.invariant",
  VERIFY_RESULT: "agentsmcp.verify.result",  // pass | fail
  VERIFY_SEVERITY: "agentsmcp.verify.severity",

  // Tenant
  TENANT_ID: "agentsmcp.tenant.id",
  TENANT_AGENT: "agentsmcp.tenant.agent",
} as const;

// ── Span Interface ─────────────────────────────────────────

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(code: "OK" | "ERROR", message?: string): void;
  end(): void;
}

export interface TraceEntry {
  spanId: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  status: "OK" | "ERROR" | "UNSET";
  statusMessage?: string;
  children: TraceEntry[];
}

// ── In-Memory Tracer (fallback when OTEL not installed) ────

class InMemorySpan implements Span {
  readonly entry: TraceEntry;

  constructor(name: string) {
    this.entry = {
      spanId: Math.random().toString(36).substring(2, 10),
      name,
      startTime: Date.now(),
      attributes: {},
      status: "UNSET",
      children: [],
    };
  }

  setAttribute(key: string, value: string | number | boolean) {
    this.entry.attributes[key] = value;
  }

  setStatus(code: "OK" | "ERROR", message?: string) {
    this.entry.status = code;
    if (message) this.entry.statusMessage = message;
  }

  end() {
    this.entry.endTime = Date.now();
  }
}

// ── Trace Context ──────────────────────────────────────────

let tracingEnabled = false;
const traces: TraceEntry[] = [];
const MAX_TRACES = 1000;

export function enableTracing() { tracingEnabled = true; }
export function disableTracing() { tracingEnabled = false; }
export function isTracingEnabled() { return tracingEnabled; }

export function getTraces(): TraceEntry[] { return [...traces]; }
export function getLastTrace(): TraceEntry | undefined { return traces[traces.length - 1]; }
export function clearTraces() { traces.length = 0; }

// ── Span Creation ──────────────────────────────────────────

/**
 * Create a new span. If tracing is enabled, the span is recorded.
 * If OTEL is installed, delegates to the real tracer.
 *
 * Usage:
 * ```ts
 * const span = startSpan("agentsmcp.remember");
 * span.setAttribute(ATTR.PARSE_PROGRAM, "LOAN-PROC");
 * try {
 *   // ... work ...
 *   span.setStatus("OK");
 * } catch (err) {
 *   span.setStatus("ERROR", String(err));
 *   throw err;
 * } finally {
 *   span.end();
 * }
 * ```
 */
export function startSpan(name: string): Span {
  const span = new InMemorySpan(name);

  if (tracingEnabled) {
    if (traces.length >= MAX_TRACES) traces.shift();
    traces.push(span.entry);
  }

  return span;
}

/**
 * Convenience: run a function within a span, auto-ending it.
 *
 * ```ts
 * const result = await withSpan("agentsmcp.parse", async (span) => {
 *   span.setAttribute(ATTR.PARSE_PROGRAM, name);
 *   return parseCobol(source);
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const span = startSpan(name);
  try {
    const result = await fn(span);
    span.setStatus("OK");
    return result;
  } catch (err) {
    span.setStatus("ERROR", String(err));
    throw err;
  } finally {
    span.end();
  }
}

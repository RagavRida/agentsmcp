/**
 * Search Errors — typed exceptions for vector, RAPTOR, and graph search.
 */

export class SearchError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

/** Embedding generation failed (Modal/GPU endpoint unreachable) */
export class EmbeddingError extends SearchError {
  readonly endpoint: string;

  constructor(endpoint: string, cause?: string) {
    super(
      `Embedding generation failed at "${endpoint}"${cause ? `: ${cause}` : ""}`,
      "EMBEDDING_FAILED"
    );
    this.name = "EmbeddingError";
    this.endpoint = endpoint;
  }
}

/** No results found for a query */
export class NoResultsError extends SearchError {
  readonly query: string;
  readonly strategy: string;

  constructor(query: string, strategy: string) {
    super(`No results found for query "${query}" using strategy ${strategy}`, "NO_RESULTS");
    this.name = "NoResultsError";
    this.query = query;
    this.strategy = strategy;
  }
}

/** RAPTOR tree not built yet for a program */
export class RaptorTreeNotFoundError extends SearchError {
  readonly program: string;

  constructor(program: string) {
    super(`RAPTOR tree not built for program "${program}". Run remember() first.`, "RAPTOR_NOT_FOUND");
    this.name = "RaptorTreeNotFoundError";
    this.program = program;
  }
}

/** FLARE retrieval exceeded max iterations */
export class FlareExhaustedError extends SearchError {
  readonly iterations: number;
  readonly maxIterations: number;

  constructor(iterations: number, maxIterations: number) {
    super(
      `FLARE exhausted after ${iterations}/${maxIterations} iterations. Query may be too complex.`,
      "FLARE_EXHAUSTED"
    );
    this.name = "FlareExhaustedError";
    this.iterations = iterations;
    this.maxIterations = maxIterations;
  }
}

/** Query routing failed — no strategy matched */
export class RouteError extends SearchError {
  readonly query: string;

  constructor(query: string) {
    super(`Could not route query: "${query}"`, "ROUTE_FAILED");
    this.name = "RouteError";
    this.query = query;
  }
}

import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { ZodError } from "zod";
import { parseCobol, type ParseCobolResult, type SemanticNodeCompact } from "../parser";
import type { SearchResult } from "../vector/store";
import { IngestionService as SourceIngestionService, createMemoryIngestionProcessor } from "../ingestion";
import { createStorageAdapterFromEnv } from "../storage/interfaces";
import { getMemory } from "../memory/service";
import { checkModelHealth, detectModelConfig } from "../model/provider";
import { getProductCapabilityMatrix } from "../product/capabilities";
import { analyzeInventoryImpact } from "../impact/analysis";
import { createEvidenceBundle } from "../evidence/export";
import {
  ErrorResponseSchema,
  EvidenceExportRequestSchema,
  ExtractRequestSchema,
  GraphQueryRequestSchema,
  ImpactAnalyzeRequestSchema,
  IngestRequestSchema,
  type BusinessRuleResult,
  type ExtractRequest,
  type GraphQueryRequest,
} from "./dto";

export interface PipelineOrchestratorLike {
  extract(request: ExtractRequest): Promise<ParseCobolResult> | ParseCobolResult;
}

export interface GraphSearchProvider {
  search(request: GraphQueryRequest): Promise<BusinessRuleResult[]> | BusinessRuleResult[];
}

export interface VectorSearchProvider {
  semanticSearch(
    query: string,
    options?: { limit?: number; domain?: string; program?: string }
  ): Promise<SearchResult[]>;
}

export interface ApiServerOptions {
  pipelineOrchestrator?: PipelineOrchestratorLike;
  graphSearchProvider?: GraphSearchProvider;
  vectorStore?: VectorSearchProvider;
  ingestionService?: Pick<SourceIngestionService, "ingest" | "inventory" | "sourceDetails" | "recordEvidenceExport">;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createApiApp(options: ApiServerOptions = {}): express.Express {
  const opts = options;
  const app = express();
  const localRules = new LocalRuleIndex();
  const webApp = resolveWebAppPaths();

  app.use(express.json({ limit: "5mb" }));
  if (webApp) {
    app.use(express.static(webApp.root, {
      index: false,
      extensions: ["html"],
      maxAge: "1y",
      etag: true,
      setHeaders(res, filePath) {
        const isHtml = filePath.endsWith(".html");
        if (isHtml) {
          res.setHeader("Cache-Control", "no-store");
          return;
        }

        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    }));
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "agentmailbox-memory-api" });
  });

  app.get("/api/v1/model/health", asyncHandler(async (_req, res) => {
    const config = detectModelConfig();
    const health = await checkModelHealth(config);
    res.status(health.status === "error" ? 503 : 200).json({
      ...health,
      baseUrl: config.baseUrl,
      openaiCompatible: config.openaiCompatible,
    });
  }));

  app.get("/api/v1/product/capabilities", (_req, res) => {
    res.json(getProductCapabilityMatrix());
  });

  app.post(
    "/api/v1/extract",
    asyncHandler(async (req, res) => {
      const parsedBody = ExtractRequestSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid extract request", parsedBody.error.flatten());
      }

      const result = await runExtraction(parsedBody.data, opts.pipelineOrchestrator);
      localRules.ingest(result);
      res.json(result);
    }),
  );

  app.post(
    "/api/v1/ingest",
    asyncHandler(async (req, res) => {
      const parsedBody = IngestRequestSchema.safeParse(req.body);
      if (!parsedBody.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid ingest request", parsedBody.error.flatten());
      }
      if (!opts.ingestionService) {
        throw new ApiError(503, "INGESTION_NOT_CONFIGURED", "No enterprise ingestion service is configured");
      }
      const result = await opts.ingestionService.ingest(parsedBody.data);
      res.status(result.failed > 0 ? 207 : 200).json(result);
    }),
  );

  app.get("/api/v1/ingest", (_req, res) => {
    res.json({
      endpoint: "/api/v1/ingest",
      method: "POST",
      description: "Ingest a versioned batch of mainframe source files",
      requiredFields: ["dataset", "files"],
    });
  });

  app.get(
    "/api/v1/ingest/inventory",
    asyncHandler(async (_req, res) => {
      if (!opts.ingestionService) {
        throw new ApiError(503, "INGESTION_NOT_CONFIGURED", "No enterprise ingestion service is configured");
      }
      res.json(await opts.ingestionService.inventory());
    }),
  );

  app.get(
    "/api/v1/ingest/sources/:sourceId",
    asyncHandler(async (req, res) => {
      if (!opts.ingestionService) {
        throw new ApiError(503, "INGESTION_NOT_CONFIGURED", "No enterprise ingestion service is configured");
      }
      const details = await opts.ingestionService.sourceDetails(req.params.sourceId);
      if (!details) {
        throw new ApiError(404, "SOURCE_NOT_FOUND", `No indexed source found for ${req.params.sourceId}`);
      }
      res.json(details);
    }),
  );

  app.get(
    "/api/v1/impact/analyze",
    asyncHandler(async (req, res) => {
      const parsedQuery = ImpactAnalyzeRequestSchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid impact analysis request", parsedQuery.error.flatten());
      }
      if (!opts.ingestionService) {
        throw new ApiError(503, "INGESTION_NOT_CONFIGURED", "No enterprise ingestion service is configured");
      }
      res.json(await analyzeInventoryImpact(opts.ingestionService, parsedQuery.data));
    }),
  );

  app.get(
    "/api/v1/evidence/export",
    asyncHandler(async (req, res) => {
      const parsedQuery = EvidenceExportRequestSchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid evidence export request", parsedQuery.error.flatten());
      }
      if (!opts.ingestionService) {
        throw new ApiError(503, "INGESTION_NOT_CONFIGURED", "No enterprise ingestion service is configured");
      }
      const bundle = await createEvidenceBundle(opts.ingestionService, parsedQuery.data, {
        version: process.env.npm_package_version,
      });
      res.setHeader("Content-Disposition", `attachment; filename="${bundle.metadata.exportId}.json"`);
      res.json(bundle);
    }),
  );

  app.get(
    "/api/v1/graph/search",
    asyncHandler(async (req, res) => {
      const parsedQuery = GraphQueryRequestSchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid graph search request", parsedQuery.error.flatten());
      }

      const search = parsedQuery.data;
      const response = await runGraphSearch(search, {
        graphSearchProvider: opts.graphSearchProvider,
        vectorStore: opts.vectorStore,
        localRules,
      });
      res.json(response);
    }),
  );

  if (webApp) {
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) {
        next();
        return;
      }

      res.sendFile(webApp.indexHtml, (err) => {
        if (err) next(err);
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function resolveWebAppPaths(): { root: string; indexHtml: string } | null {
  const root = path.resolve(__dirname, "../../ui/dist");
  const indexHtml = path.join(root, "index.html");
  return fs.existsSync(indexHtml) ? { root, indexHtml } : null;
}

export function createApiServer(options: ApiServerOptions = {}): express.Express {
  return createApiApp(options);
}

async function runExtraction(
  request: ExtractRequest,
  orchestrator?: PipelineOrchestratorLike,
): Promise<ParseCobolResult> {
  if (orchestrator) return orchestrator.extract(request);
  return parseCobol(request.code, {
    filename: request.filename,
    copybooks: request.copybooks,
  });
}

async function runGraphSearch(
  request: GraphQueryRequest,
  opts: {
    graphSearchProvider?: GraphSearchProvider;
    vectorStore?: VectorSearchProvider;
    localRules: LocalRuleIndex;
  },
) {
  if (opts.graphSearchProvider) {
    const results = await opts.graphSearchProvider.search(request);
    return {
      query: request.query,
      count: results.length,
      source: "graph-search-provider",
      results,
    };
  }

  if (opts.vectorStore) {
    const results = await opts.vectorStore.semanticSearch(request.query, {
      limit: request.limit,
      domain: request.domain,
      program: request.program,
    });
    const mapped = results.map(vectorResultToBusinessRule);
    return {
      query: request.query,
      count: mapped.length,
      source: "vector-store",
      results: mapped,
    };
  }

  const results = opts.localRules.search(request);
  return {
    query: request.query,
    count: results.length,
    source: "local-extract-cache",
    results,
  };
}

function vectorResultToBusinessRule(result: SearchResult): BusinessRuleResult {
  return {
    id: result.id,
    program: result.program,
    type: result.nodeType,
    domain: result.domain,
    description: result.description,
    score: result.score,
    metadata: result.metadata,
  };
}

class LocalRuleIndex {
  private readonly rules: BusinessRuleResult[] = [];

  ingest(result: ParseCobolResult): void {
    const program = result.programName;
    for (const rule of flattenRules(result.semanticTree)) {
      const id = rule.id || `${program}:${this.rules.length}`;
      const existingIdx = this.rules.findIndex((r) => r.id === id && r.program === program);
      const indexed: BusinessRuleResult = {
        id,
        program,
        type: rule.type,
        domain: rule.domain,
        description: rule.description,
        metadata: {
          inputs: rule.inputs,
          outputs: rule.outputs,
          sideEffects: rule.sideEffects,
        },
      };
      if (existingIdx >= 0) this.rules[existingIdx] = indexed;
      else this.rules.push(indexed);
    }
  }

  search(request: GraphQueryRequest): BusinessRuleResult[] {
    const terms = request.query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = this.rules
      .filter((rule) => !request.program || rule.program === request.program)
      .filter((rule) => !request.domain || rule.domain === request.domain)
      .map((rule) => ({
        rule,
        score: scoreRule(rule, terms),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, request.limit)
      .map(({ rule, score }) => ({ ...rule, score }));

    return scored;
  }
}

function flattenRules(node: SemanticNodeCompact): SemanticNodeCompact[] {
  const children = node.children.flatMap(flattenRules);
  return node.type === "BUSINESS_RULE" ? [node, ...children] : children;
}

function scoreRule(rule: BusinessRuleResult, terms: string[]): number {
  const haystack = [
    rule.id,
    rule.program,
    rule.type,
    rule.domain,
    rule.description,
  ].filter(Boolean).join(" ").toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${req.path}`));
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const isBodyParseError = typeof err === "object" &&
    err !== null &&
    (err as { type?: string }).type === "entity.parse.failed";
  const status = err instanceof ApiError ? err.status : isBodyParseError ? 400 : 500;
  const code = err instanceof ApiError
    ? err.code
    : isBodyParseError
      ? "INVALID_JSON"
    : err instanceof ZodError
      ? "VALIDATION_ERROR"
      : "INTERNAL_ERROR";
  const message = isBodyParseError
    ? "Malformed JSON request body"
    : err instanceof Error ? err.message : "Unknown error";
  const details = err instanceof ApiError ? err.details : undefined;
  const body = ErrorResponseSchema.parse({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  });
  res.status(status).json(body);
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? process.env.AGENTSMCP_API_PORT ?? 3100);
  const ingestionService = new SourceIngestionService({
    processor: createMemoryIngestionProcessor(getMemory()),
    manifestStorage: createStorageAdapterFromEnv({ localRoot: process.env.AGENTSMCP_INGESTION_STATE_DIR ?? ".agentmailbox/ingestion" }),
    manifestPrefix: "manifests",
  });
  createApiApp({ ingestionService }).listen(port, () => {
    process.stdout.write(`AgentMailbox Memory API listening on http://localhost:${port}\n`);
  });
}

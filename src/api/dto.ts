import { z } from "zod";

export const IngestRequestSchema = z.object({
  dataset: z.string().min(1).max(256),
  connectorRunId: z.string().max(256).optional(),
  files: z.array(z.object({
    sourceId: z.string().min(1).max(512), filename: z.string().min(1).max(512), code: z.string().min(1).max(10_000_000),
    language: z.enum(["auto", "cobol", "jcl", "pli", "rexx", "unknown"]).optional(), dataset: z.string().min(1).max(256).optional(), version: z.string().max(256).optional(), encoding: z.string().max(64).optional(), metadata: z.record(z.string()).optional(), copybooks: z.record(z.string()).optional(),
  }).strict()).min(1).max(500),
}).strict();

export const ExtractRequestSchema = z.object({
  code: z.string().min(1, "code is required"),
  filename: z.string().min(1).optional(),
  copybooks: z.record(z.string()).optional(),
}).strict();

export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

const QueryTextSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value[0];
  return value;
}, z.string().min(1));

const OptionalQueryTextSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value[0];
  if (value === undefined || value === null || value === "") return undefined;
  return value;
}, z.string().min(1).optional());

const QueryIntSchema = (def: number, min: number, max: number) =>
  z.preprocess((value) => {
    if (Array.isArray(value)) value = value[0];
    if (value === undefined || value === null || value === "") return def;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }, z.number().int().min(min).max(max));

export const GraphQueryRequestSchema = z.object({
  q: OptionalQueryTextSchema,
  query: OptionalQueryTextSchema,
  limit: QueryIntSchema(10, 1, 100).default(10),
  program: OptionalQueryTextSchema,
  domain: OptionalQueryTextSchema,
}).strict().transform((value, ctx) => {
  const query = value.query ?? value.q;
  if (!query) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "query or q is required",
      path: ["query"],
    });
    return z.NEVER;
  }
  return {
    query,
    limit: value.limit,
    program: value.program,
    domain: value.domain,
  };
});

export type GraphQueryRequest = z.infer<typeof GraphQueryRequestSchema>;

export const BusinessRuleResultSchema = z.object({
  id: z.string(),
  program: z.string().optional(),
  type: z.string(),
  domain: z.string().optional(),
  description: z.string(),
  score: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

export type BusinessRuleResult = z.infer<typeof BusinessRuleResultSchema>;

export const GraphSearchResponseSchema = z.object({
  query: z.string(),
  count: z.number().int().nonnegative(),
  source: z.string(),
  results: z.array(BusinessRuleResultSchema),
}).strict();

export type GraphSearchResponse = z.infer<typeof GraphSearchResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }).strict(),
}).strict();

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const CapabilityStatusSchema = z.enum(["live", "beta", "prototype", "roadmap"]);

export const ProductCapabilitySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: CapabilityStatusSchema,
  category: z.enum(["ingestion", "knowledge", "analysis", "ai", "operations", "governance"]),
  summary: z.string(),
  evidence: z.array(z.string()),
  nextMilestone: z.string().optional(),
}).strict();

export const ProductCapabilityMatrixSchema = z.object({
  generatedAt: z.string(),
  statuses: z.record(CapabilityStatusSchema, z.string()),
  capabilities: z.array(ProductCapabilitySchema),
}).strict();

export type ProductCapabilityMatrix = z.infer<typeof ProductCapabilityMatrixSchema>;

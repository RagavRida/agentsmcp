export { AgentMailbox, AgentMailboxConfig } from "./agentmailbox";
export { createStorage, SqliteStorage } from "./storage";
export type { Storage, StorageOptions } from "./storage";
export {
  NoopCompressor,
  ClaudeCompressor,
  type ClaudeCompressorOptions,
  OpenAICompressor,
  type OpenAICompressorOptions,
} from "./compression";
export type { Compressor } from "./compression";
export { createServer, type CreateServerOptions } from "./server";
export { assembleContext, type AssembleOptions } from "./context";
export * from "./types";
export { buildMcpServer } from "./mcp/server";
export { listToolDefs, runTool } from "./mcp/tools";
export type {
  GraphNode,
  GraphEdge,
  GraphNodeType,
  CodebaseIndexEntry,
  IndexCategory,
} from "./storage/interface";
export {
  parseCobol,
  parseJcl,
  parsePli,
  parseRexx,
  parseMainframeSource,
  parseMainframeSourceAsync,
  detectMainframeLanguage,
  type MainframeLanguage,
  type ParseCobolResult,
  type ParseJclResult,
  type ParseMainframeResult,
  type SemanticNodeCompact,
} from "./parser";

// ── 7 Pillars ──
export { VectorStore, type VectorEntry, type SearchResult } from "./vector/store";
export { VectorStoreClient } from "./vector/client";
export type { VectorStoreLike, VectorSearchOptions } from "./vector/interface";
export { resolve as resolveVectorOp } from "./vector/interface";
export { VectorDatabase, type VectorDatabaseOptions } from "./vector/database";
export {
  OP_CONNECT,
  OP_VECTOR_SEARCH,
  OP_TABLE_ADD,
  OP_COUNT,
  OP_PROGRAMS,
  OP_DELETE_PROGRAM,
  OP_DELETE_ID,
  OP_CLEAR,
  OP_CLOSE,
  OP_COUNT_BY_PROGRAM,
  OP_LIST_BY_PROGRAM,
  forkWorker,
  sendRequest,
  handleResult,
  IpcWorkerClient,
  type WorkerRequest,
  type WorkerResult,
} from "./db-workers/harness";
export { RaptorTreeBuilder, type RaptorTree, type RaptorNode } from "./raptor/tree-builder";
export { RaptorTreeStore } from "./raptor/tree-store";
export { Neo4jSync, type Neo4jConfig, type ImpactResult } from "./graph/neo4j-sync";
export { TrajectoryLogger, type TrajectoryEntry, type TrajectoryAction } from "./trajectory/logger";
export { S3BYOSClient, type BYOSConfig, type BYOSClient } from "./storage/byos";
export {
  LocalStorageAdapter,
  S3StorageAdapter,
  createStorageAdapterFromEnv,
  type StorageAdapter,
  type StorageData,
} from "./storage/interfaces";
export { CacheManager, type CacheManagerOptions } from "./cache/manager";
export { KVCacheManager, type KVCacheConfig } from "./kv-cache/manager";
export { FlareEngine, type FlareConfig, type FlareResult } from "./flare/active-rag";

// ── Memory API (Cognee-inspired) ──
export {
  Memory,
  routeQuery,
  type MemoryConfig,
  type RememberResult,
  type RecallResult,
  type ForgetResult,
  type SearchStrategy,
  getMemory,
  getVectorStore,
  getVectorStorePath,
  getRaptorTreeStore,
  useVectorWorker,
  listProgramStats,
  getChunkNeighbors,
  getSessionManager,
  distillSessionsToMemory,
  scheduleSessionDistillation,
  getAgentStorage,
  getAgentStoragePath,
  resolveAgentId,
  buildMemoryConfig,
  resetMemoryService,
  launchBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  hashEmbed,
  createEmbedder,
  createQueryEmbedder,
  type BackgroundTask,
  type BackgroundTaskStatus,
} from "./memory";
export { ContextRouter, type ContextEnvelope, type ContextField, type Visibility } from "./context-router";
export {
  buildHandoffContext,
  type BuildHandoffInput,
  type HandoffContext,
} from "./handoff/context-builder";
export {
  getContextRouter,
  resetContextRouter,
  wrapContextForSend,
  scopeSnapshotForReceiver,
  scopeReceiveResult,
  loadContextRouterProfiles,
  saveContextRouterProfiles,
  declareInterestAndPersist,
} from "./context-router-service";
export {
  createApiApp,
  createApiServer,
  ApiError,
  type ApiServerOptions,
  type PipelineOrchestratorLike,
  type GraphSearchProvider,
} from "./api/server";
export {
  ExtractRequestSchema,
  GraphQueryRequestSchema,
  GroundedChatRequestSchema,
  GroundedChatResponseSchema,
  ErrorResponseSchema,
  type ExtractRequest,
  type GraphQueryRequest,
  type GroundedChatRequest,
  type GroundedChatResponse,
  type GroundedCitation,
  type ErrorResponse,
  type GraphSearchResponse,
  type BusinessRuleResult,
} from "./api/dto";
export {
  DefaultGroundedAnswerGenerator,
  deterministicAnswer,
  type GroundedAnswerGenerator,
  type GroundedAnswerInput,
  type GroundedAnswerOutput,
} from "./api/grounded-answer";
export {
  Pipeline,
  type PipelineOptions,
  type PipelineRunResult,
  type PipelineState,
  type PipelineTaskState,
  type Task,
  type TaskExecutionView,
  type TaskStatus,
} from "./pipeline/orchestrator";
export {
  createEvalPipeline,
  runEvalPipeline,
  ParseCobolTask,
  SemanticElevationTask,
  LLMFallbackTask,
  ScoringTask,
  PARSE_COBOL_TASK_ID,
  SEMANTIC_ELEVATION_TASK_ID,
  LLM_FALLBACK_TASK_ID,
  SCORING_TASK_ID,
  type EvalPipelineContext,
  type ParseCobolOutput,
  type SemanticElevationOutput,
  type LLMFallbackOutput,
} from "./pipeline/eval-tasks";

// ── Exceptions (typed errors per subsystem) ──
export * from "./exceptions";

// ── Health Checks (on-prem monitoring) ──
export { checkHealth, type HealthStatus, type HealthCheck } from "./health";
export { validateProductionConfig } from "./config/production";

// ── Observability (OTEL-compatible tracing) ──
export { ATTR, startSpan, withSpan, enableTracing, disableTracing, getTraces, clearTraces, type Span, type TraceEntry } from "./observability";
export { MetricsRegistry, defaultMetrics } from "./observability/metrics";

// ── Session Lifecycle ──
export { SessionManager, distillExpiredSessions, type SessionManagerConfig, type DistillationConfig, type SessionEntry, type SessionRecord, type SessionSummary } from "./session";

// ── Ontology Engine (auto-discover domains) ──
export { OntologyGenerator, type Ontology, type OntologyEntity, type OntologyRelationship, type DomainCluster } from "./ontology";

// ── Eval-Optimize Loop ──
export { runOptimizeLoop, type OptimizeLoopConfig, type OptimizeLoopResult, type OptimizeLoopIteration } from "./loops/optimize-loop";
export { LoopVerifier, type LoopVerificationResult, type LoopVerifierConfig } from "./loops/verifier";
export { PromptOptimizerSkill, type OptimizerResult } from "./loops/skills/optimizer";
export { LoopMemory, type LoopMemoryIteration } from "./loops/memory";
export { classifyFailures, type FailureReport, type FailureMode } from "./loops/failure-classifier";
export * as loops from "./loops";

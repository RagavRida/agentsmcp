import { parseMainframeSource } from "../parser";
import { Neo4jSync } from "../graph/neo4j-sync";
import { RaptorTreeBuilder } from "../raptor/tree-builder";
import { RaptorTreeStore } from "../raptor/tree-store";
import { TrajectoryLogger } from "../trajectory/logger";
import { FlareEngine } from "../flare/active-rag";
import { SessionManager } from "../session/manager";
import { distillExpiredSessions } from "../session/distillation";
import { createStorage, type Storage } from "../storage";
import { VectorStore } from "../vector/store";
import { VectorStoreClient } from "../vector/client";
import type { VectorStoreLike } from "../vector/interface";
import { Memory, type MemoryConfig } from "./api";
import { createEmbedder } from "./embedder";

export type BackgroundTaskStatus = "running" | "completed" | "failed";

export interface BackgroundTask {
  id: string;
  tool: string;
  status: BackgroundTaskStatus;
  startedAt: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

let _vectorStore: VectorStoreLike | null = null;
let _memory: Memory | null = null;
let _trajectory: TrajectoryLogger | null = null;
let _agentStorage: Storage | null = null;
let _raptorTreeStore: RaptorTreeStore | null = null;
let _sessionManager: SessionManager | null = null;
let _distillTimer: NodeJS.Timeout | null = null;

const _backgroundTasks = new Map<string, BackgroundTask>();
const MAX_BACKGROUND_TASKS = 200;

function trimBackgroundTasks(): void {
  if (_backgroundTasks.size <= MAX_BACKGROUND_TASKS) return;
  const sorted = [..._backgroundTasks.entries()].sort((a, b) =>
    a[1].startedAt.localeCompare(b[1].startedAt),
  );
  const toRemove = sorted.slice(0, sorted.length - MAX_BACKGROUND_TASKS);
  for (const [id] of toRemove) _backgroundTasks.delete(id);
}

export function useVectorWorker(): boolean {
  return process.env.AGENTSMCP_USE_VECTOR_WORKER !== "false";
}

export function getAgentStoragePath(): string {
  return (
    process.env.AGENTSMCP_DB ||
    process.env.AGENTSMCP_STORAGE_URL ||
    "agentmailbox.db"
  );
}

export function getAgentStorage(): Storage {
  if (!_agentStorage) {
    _agentStorage = createStorage(getAgentStoragePath());
    void _agentStorage.init();
  }
  return _agentStorage;
}

export function resolveAgentId(fallback?: string): string {
  const id = fallback || process.env.AGENTSMCP_AGENT_ID;
  if (!id) {
    throw new Error("Agent ID is required (set AGENTSMCP_AGENT_ID or pass agentId)");
  }
  return id;
}

export function getVectorStorePath(): string {
  return process.env.AGENTSMCP_VECTOR_DB || "./agentsmcp-vectors.db";
}

export function getRaptorTreeStore(): RaptorTreeStore {
  if (!_raptorTreeStore) {
    _raptorTreeStore = new RaptorTreeStore(
      process.env.AGENTSMCP_RAPTOR_DIR ?? ".agentmailbox/raptor-trees",
    );
  }
  return _raptorTreeStore;
}

export function getSessionManager(): SessionManager {
  if (!_sessionManager) {
    _sessionManager = new SessionManager();
  }
  return _sessionManager;
}

function createFlareEngine(): FlareEngine | undefined {
  const vllmUrl =
    process.env.AGENTSMCP_VLLM_URL ||
    process.env.VLLM_URL;
  if (!vllmUrl) return undefined;

  return new FlareEngine(getVectorStore(), { vllmUrl }, getMemoryTrajectory());
}

function sessionAgentId(): string {
  return process.env.AGENTSMCP_AGENT_ID ?? "memory-api";
}

export function getVectorStore(): VectorStoreLike {
  if (!_vectorStore) {
    const dbPath = getVectorStorePath();
    _vectorStore = useVectorWorker()
      ? new VectorStoreClient(dbPath)
      : new VectorStore(dbPath);
  }
  return _vectorStore;
}

export function getMemoryTrajectory(): TrajectoryLogger {
  if (!_trajectory) {
    const logDir = process.env.AGENTSMCP_LOG_DIR || "./logs";
    const sessionId = process.env.AGENTSMCP_SESSION_ID;
    _trajectory = new TrajectoryLogger({ logDir, sessionId });

    // Hydrate from disk for TRAJECTORY recall across restarts
    if (sessionId) {
      const logPath = `${logDir}/.agent_history_${sessionId}.jsonl`;
      _trajectory.hydrate(TrajectoryLogger.loadFromFile(logPath));
    }
  }
  return _trajectory;
}

function createNeo4jSync(): Neo4jSync | undefined {
  const uri = process.env.NEO4J_URI || process.env.AGENTSMCP_NEO4J_URI;
  if (!uri) return undefined;

  return new Neo4jSync({
    uri,
    user: process.env.NEO4J_USER || process.env.AGENTSMCP_NEO4J_USER || "neo4j",
    password: process.env.NEO4J_PASSWORD || process.env.AGENTSMCP_NEO4J_PASSWORD || "",
  });
}

export function buildMemoryConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  const vectorStore = overrides.vectorStore ?? getVectorStore();
  const embedder = overrides.embedder ?? createEmbedder(vectorStore);
  const trajectory = overrides.trajectory ?? getMemoryTrajectory();
  const raptorTreeStore = overrides.raptorTreeStore ?? getRaptorTreeStore();

  const raptorBuilder =
    overrides.raptorBuilder ??
    new RaptorTreeBuilder(vectorStore, async (texts) => {
      if (texts.length === 0) return "";
      if (texts.length === 1) return texts[0];
      return `${texts[0]} (+${texts.length - 1} related rules)`;
    });

  return {
    vectorStore,
    raptorBuilder,
    raptorTreeStore,
    neo4jSync: overrides.neo4jSync ?? createNeo4jSync(),
    trajectory,
    parser: overrides.parser ?? parseMainframeSource,
    embedder,
    sessionManager: overrides.sessionManager ?? getSessionManager(),
    sessionAgentId: overrides.sessionAgentId ?? sessionAgentId(),
    flareEngine: overrides.flareEngine ?? createFlareEngine(),
    byosClient: overrides.byosClient,
  };
}

export function getMemory(overrides: Partial<MemoryConfig> = {}): Memory {
  if (!_memory) {
    _memory = new Memory(buildMemoryConfig(overrides));
  }
  return _memory;
}

/** Reset singletons — for tests only. */
export function resetMemoryService(): void {
  void _vectorStore?.close();
  _vectorStore = null;
  _memory = null;
  _trajectory = null;
  _agentStorage = null;
  _raptorTreeStore = null;
  _sessionManager?.destroy();
  _sessionManager = null;
  if (_distillTimer) {
    clearInterval(_distillTimer);
    _distillTimer = null;
  }
  _backgroundTasks.clear();
}

/**
 * Distill expired sessions into trajectory logs for permanent recall.
 * Returns the number of sessions distilled.
 */
export async function distillSessionsToMemory(): Promise<number> {
  const sessionManager = getSessionManager();
  const summaries = await distillExpiredSessions(sessionManager);
  if (summaries.length === 0) return 0;

  const trajectory = getMemoryTrajectory();
  for (const summary of summaries) {
    trajectory.log({
      action: "SESSION_DISTILL",
      input: summary.sessionId,
      output: summary.keyInsights.slice(0, 10).join("; ") || "no insights",
      sources: summary.programs,
      latencyMs: 0,
      metadata: {
        agentId: summary.agentId,
        queries: summary.queries,
        distilledAt: summary.distilledAt,
      },
    });
  }

  return summaries.length;
}

/** Schedule periodic session distillation (MCP server startup). */
export function scheduleSessionDistillation(intervalMs = 5 * 60 * 1000): void {
  if (_distillTimer) return;
  _distillTimer = setInterval(() => {
    void distillSessionsToMemory().catch(() => undefined);
  }, intervalMs);
  if (_distillTimer.unref) _distillTimer.unref();
}

export function launchBackgroundTask(
  tool: string,
  fn: () => Promise<unknown>,
): string {
  const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const task: BackgroundTask = {
    id,
    tool,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  _backgroundTasks.set(id, task);
  trimBackgroundTasks();

  fn()
    .then((result) => {
      task.status = "completed";
      task.completedAt = new Date().toISOString();
      task.result = result;
    })
    .catch((err) => {
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.error = err instanceof Error ? err.message : String(err);
    });

  return id;
}

export function getBackgroundTask(taskId: string): BackgroundTask | undefined {
  return _backgroundTasks.get(taskId);
}

export function listBackgroundTasks(limit = 20): BackgroundTask[] {
  return [..._backgroundTasks.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

/** Shared helpers for MCP tools using vector storage. */
export async function listProgramStats(detailed = false): Promise<{
  totalPrograms: number;
  totalVectors: number;
  programs: Array<{ program: string; entryCount: number; samples?: unknown[] }>;
}> {
  const store = getVectorStore();
  const programs = await resolveStore(store.programs());
  const totalVectors = await resolveStore(store.count());

  const stats = await Promise.all(
    programs.map(async (program) => {
      const entryCount = await resolveStore(store.countByProgram(program));
      const entry: { program: string; entryCount: number; samples?: unknown[] } = {
        program,
        entryCount,
      };
      if (detailed && entryCount > 0) {
        const samples = await store.listByProgram(program, 3);
        entry.samples = samples.map((s) => ({
          id: s.id,
          nodeType: s.nodeType,
          description: s.description,
        }));
      }
      return entry;
    }),
  );

  return { totalPrograms: programs.length, totalVectors, programs: stats };
}

export async function getChunkNeighbors(
  targetId: string,
  neighborCount: number,
  includeTarget: boolean,
): Promise<unknown> {
  const program = targetId.split("::")[0];
  if (!program) {
    return { error: "Invalid targetId format. Expected 'PROGRAM::NODE_ID'." };
  }

  const store = getVectorStore();
  const allResults = await store.listByProgram(program, 500);
  const targetIdx = allResults.findIndex((r) => r.id === targetId);
  if (targetIdx === -1) {
    return { error: `Target '${targetId}' not found in program '${program}'.` };
  }

  const startIdx = Math.max(0, targetIdx - neighborCount);
  const endIdx = Math.min(allResults.length - 1, targetIdx + neighborCount);
  const neighbors = allResults.slice(startIdx, endIdx + 1);
  const result = includeTarget
    ? neighbors
    : neighbors.filter((r) => r.id !== targetId);

  return {
    targetId,
    program,
    totalInProgram: allResults.length,
    neighbors: result.map((r) => ({
      id: r.id,
      nodeType: r.nodeType,
      domain: r.domain,
      description: r.description,
      isTarget: r.id === targetId,
    })),
    count: result.length,
  };
}

async function resolveStore<T>(value: T | Promise<T>): Promise<T> {
  return value instanceof Promise ? value : Promise.resolve(value);
}

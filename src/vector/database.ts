import { existsSync } from "fs";
import { resolve } from "path";
import {
  OP_CLEAR,
  OP_CLOSE,
  OP_CONNECT,
  OP_COUNT,
  OP_COUNT_BY_PROGRAM,
  OP_DELETE_ID,
  OP_DELETE_PROGRAM,
  OP_LIST_BY_PROGRAM,
  OP_PROGRAMS,
  OP_TABLE_ADD,
  OP_VECTOR_SEARCH,
  forkWorker,
  type IpcWorkerClient,
} from "../db-workers/harness";
import type { SearchResult, VectorEntry } from "./store";

export interface VectorSearchOptions {
  limit?: number;
  domain?: string;
  program?: string;
}

export interface VectorDatabaseOptions {
  dbPath: string;
  workerPath?: string;
  requestTimeoutMs?: number;
}

export class VectorDatabase {
  private readonly dbPath: string;
  private readonly workerPath: string;
  private readonly requestTimeoutMs?: number;
  private client: IpcWorkerClient | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(options: VectorDatabaseOptions) {
    this.dbPath = options.dbPath;
    this.workerPath = options.workerPath ?? defaultVectorWorkerPath();
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      this.client = forkWorker(this.workerPath, {
        timeoutMs: this.requestTimeoutMs,
      });
      await this.client.sendRequest(OP_CONNECT, { dbPath: this.dbPath });
    })();
    return this.connectPromise;
  }

  async upsert(entry: VectorEntry): Promise<void> {
    await this.upsertMany([entry]);
  }

  async upsertMany(entries: VectorEntry[]): Promise<void> {
    await this.request(OP_TABLE_ADD, { entries });
  }

  async search(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): Promise<SearchResult[]> {
    return this.request<SearchResult[]>(OP_VECTOR_SEARCH, { queryVector, options });
  }

  async count(): Promise<number> {
    return this.request<number>(OP_COUNT);
  }

  async programs(): Promise<string[]> {
    return this.request<string[]>(OP_PROGRAMS);
  }

  async countByProgram(program: string): Promise<number> {
    return this.request<number>(OP_COUNT_BY_PROGRAM, { program });
  }

  async listByProgram(program: string, limit = 500): Promise<SearchResult[]> {
    return this.request<SearchResult[]>(OP_LIST_BY_PROGRAM, { program, limit });
  }

  async deleteByProgram(program: string): Promise<number> {
    return this.request<number>(OP_DELETE_PROGRAM, { program });
  }

  async deleteById(id: string): Promise<boolean> {
    return this.request<boolean>(OP_DELETE_ID, { id });
  }

  async clear(): Promise<number> {
    return this.request<number>(OP_CLEAR);
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendRequest(OP_CLOSE);
    } finally {
      await this.client.close();
      this.client = null;
      this.connectPromise = null;
    }
  }

  get workerPid(): number | undefined {
    return this.client?.processId;
  }

  private async request<TResult = unknown>(
    op: string,
    payload?: unknown,
  ): Promise<TResult> {
    await this.connect();
    if (!this.client) throw new Error("Vector worker failed to start");
    return this.client.sendRequest<TResult>(op, payload);
  }
}

function defaultVectorWorkerPath(): string {
  const compiled = resolve(__dirname, "../db-workers/vector-worker.js");
  if (existsSync(compiled)) return compiled;
  return resolve(__dirname, "../db-workers/vector-worker.ts");
}

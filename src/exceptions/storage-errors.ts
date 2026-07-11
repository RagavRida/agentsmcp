/**
 * Storage Errors — typed exceptions for database/storage operations.
 */

export class StorageError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

/** Storage backend not initialized (init() not called) */
export class StorageNotInitializedError extends StorageError {
  constructor(backend: string) {
    super(`Storage backend "${backend}" not initialized. Call init() first.`, "NOT_INITIALIZED");
    this.name = "StorageNotInitializedError";
  }
}

/** Database connection failed */
export class ConnectionError extends StorageError {
  readonly url: string;

  constructor(url: string, cause?: string) {
    super(`Failed to connect to storage at "${url}"${cause ? `: ${cause}` : ""}`, "CONNECTION_FAILED");
    this.name = "ConnectionError";
    this.url = url;
  }
}

/** Agent not found in registry */
export class AgentNotFoundError extends StorageError {
  readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent "${agentId}" not found in registry`, "AGENT_NOT_FOUND");
    this.name = "AgentNotFoundError";
    this.agentId = agentId;
  }
}

/** Thread not found */
export class ThreadNotFoundError extends StorageError {
  readonly threadId: string;

  constructor(threadId: string) {
    super(`Thread "${threadId}" not found`, "THREAD_NOT_FOUND");
    this.name = "ThreadNotFoundError";
    this.threadId = threadId;
  }
}

/** BYOS upload/download failed */
export class BYOSError extends StorageError {
  readonly key: string;
  readonly operation: "PUT" | "GET" | "DELETE" | "LIST";

  constructor(operation: "PUT" | "GET" | "DELETE" | "LIST", key: string, cause?: string) {
    super(`BYOS ${operation} failed for key "${key}"${cause ? `: ${cause}` : ""}`, "BYOS_ERROR");
    this.name = "BYOSError";
    this.key = key;
    this.operation = operation;
  }
}

/** Neo4j graph operation failed */
export class GraphSyncError extends StorageError {
  readonly program: string;

  constructor(program: string, cause?: string) {
    super(`Neo4j sync failed for program "${program}"${cause ? `: ${cause}` : ""}`, "GRAPH_SYNC_ERROR");
    this.name = "GraphSyncError";
    this.program = program;
  }
}

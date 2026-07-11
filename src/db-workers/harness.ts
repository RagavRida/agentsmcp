import { fork, type ChildProcess } from "child_process";
import { existsSync } from "fs";

export const OP_CONNECT = "OP_CONNECT";
export const OP_VECTOR_SEARCH = "OP_VECTOR_SEARCH";
export const OP_TABLE_ADD = "OP_TABLE_ADD";
export const OP_COUNT = "OP_COUNT";
export const OP_PROGRAMS = "OP_PROGRAMS";
export const OP_DELETE_PROGRAM = "OP_DELETE_PROGRAM";
export const OP_DELETE_ID = "OP_DELETE_ID";
export const OP_CLEAR = "OP_CLEAR";
export const OP_CLOSE = "OP_CLOSE";
export const OP_COUNT_BY_PROGRAM = "OP_COUNT_BY_PROGRAM";
export const OP_LIST_BY_PROGRAM = "OP_LIST_BY_PROGRAM";

export interface WorkerRequest<TPayload = unknown> {
  id: string;
  op: string;
  payload?: TPayload;
}

export interface WorkerResult<TResult = unknown> {
  id: string;
  ok: boolean;
  result?: TResult;
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
}

export interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  timer: NodeJS.Timeout;
}

export type PendingRequests = Map<string, PendingRequest>;

export interface SendRequestOptions {
  timeoutMs?: number;
}

export interface ForkWorkerOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function forkWorker(workerPath: string, options: ForkWorkerOptions = {}): IpcWorkerClient {
  const execArgv = workerPath.endsWith(".ts") && existsSync(workerPath)
    ? ["-r", "ts-node/register"]
    : [];
  const child = fork(workerPath, {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv,
    env: { ...process.env, ...options.env },
  });
  return new IpcWorkerClient(child, options);
}

export function sendRequest<TResult = unknown, TPayload = unknown>(
  child: ChildProcess,
  pending: PendingRequests,
  op: string,
  payload?: TPayload,
  options: SendRequestOptions = {},
): Promise<TResult> {
  if (!child.connected) {
    return Promise.reject(new Error("DB worker IPC channel is not connected"));
  }

  const id = makeRequestId();
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise<TResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DB worker request timed out: ${op}`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (value) => resolve(value as TResult),
      reject,
      timer,
    });

    child.send({ id, op, payload } satisfies WorkerRequest<TPayload>, (err) => {
      if (!err) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    });
  });
}

export function handleResult(message: unknown, pending: PendingRequests): boolean {
  if (!isWorkerResult(message)) return false;

  const request = pending.get(message.id);
  if (!request) return false;

  pending.delete(message.id);
  clearTimeout(request.timer);

  if (message.ok) {
    request.resolve(message.result);
  } else {
    const err = new Error(message.error?.message ?? "DB worker request failed");
    err.name = message.error?.name ?? "DbWorkerError";
    if (message.error?.stack) err.stack = message.error.stack;
    request.reject(err);
  }

  return true;
}

export type WorkerHandler = (
  op: string,
  payload: unknown,
  request: WorkerRequest,
) => Promise<unknown> | unknown;

export function registerWorkerHandler(handler: WorkerHandler): void {
  process.on("message", async (message: unknown) => {
    if (!isWorkerRequest(message)) return;

    try {
      const result = await handler(message.op, message.payload, message);
      process.send?.({
        id: message.id,
        ok: true,
        result,
      } satisfies WorkerResult);
    } catch (err) {
      process.send?.({
        id: message.id,
        ok: false,
        error: serializeError(err),
      } satisfies WorkerResult);
    }
  });
}

export class IpcWorkerClient {
  private readonly child: ChildProcess;
  private readonly pending: PendingRequests = new Map();
  private readonly timeoutMs?: number;
  private closed = false;

  constructor(child: ChildProcess, options: SendRequestOptions = {}) {
    this.child = child;
    this.timeoutMs = options.timeoutMs;
    this.child.on("message", (message) => handleResult(message, this.pending));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      const err = new Error(
        `DB worker exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`
      );
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(err);
      }
      this.pending.clear();
    });
  }

  sendRequest<TResult = unknown, TPayload = unknown>(
    op: string,
    payload?: TPayload,
  ): Promise<TResult> {
    if (this.closed) {
      return Promise.reject(new Error("DB worker is closed"));
    }
    return sendRequest<TResult, TPayload>(this.child, this.pending, op, payload, {
      timeoutMs: this.timeoutMs,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("DB worker client closed"));
    }
    this.pending.clear();
    if (this.child.connected) this.child.disconnect();
    if (!this.child.killed) this.child.kill();
  }

  get processId(): number | undefined {
    return this.child.pid;
  }
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  return !!value &&
    typeof value === "object" &&
    typeof (value as WorkerRequest).id === "string" &&
    typeof (value as WorkerRequest).op === "string";
}

function isWorkerResult(value: unknown): value is WorkerResult {
  return !!value &&
    typeof value === "object" &&
    typeof (value as WorkerResult).id === "string" &&
    typeof (value as WorkerResult).ok === "boolean";
}

function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function serializeError(err: unknown): WorkerResult["error"] {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

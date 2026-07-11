import { cpus } from "os";
import { resolve } from "path";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
  type MessagePort,
} from "worker_threads";

export const PARSE_PROGRAM = "PARSE_PROGRAM";

export interface ParseProgramJob {
  type: typeof PARSE_PROGRAM;
  programId: string;
  source: string;
  filename?: string;
}

export interface ParsedProgramResult {
  programId: string;
  ast?: unknown;
  semanticTree?: unknown;
  extractedRules: Array<{ id: string; type: string; description: string }>;
  timingMs: number;
  workerThreadId?: number;
  error?: string;
}

export interface WorkerPoolOptions {
  size?: number;
  workerPath?: string;
  jobTimeoutMs?: number;
}

interface WorkerRequest {
  id: number;
  job: ParseProgramJob;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: ParsedProgramResult;
  error?: string;
}

interface PendingJob {
  request: WorkerRequest;
  resolve: (result: ParsedProgramResult) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  current?: PendingJob;
}

export class CobolWorkerPool {
  private readonly size: number;
  private readonly workerPath: string;
  private readonly jobTimeoutMs: number;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingJob[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: WorkerPoolOptions = {}) {
    this.size = Math.max(1, options.size ?? defaultWorkerCount());
    this.workerPath = resolve(options.workerPath ?? __filename);
    this.jobTimeoutMs = options.jobTimeoutMs ?? 120_000;

    for (let i = 0; i < this.size; i++) {
      this.slots.push(this.createSlot());
    }
  }

  parseProgram(job: Omit<ParseProgramJob, "type">): Promise<ParsedProgramResult> {
    if (this.closed) {
      return Promise.reject(new Error("CobolWorkerPool is closed"));
    }

    return new Promise((resolvePromise, reject) => {
      const pending: PendingJob = {
        request: {
          id: this.nextId++,
          job: {
            ...job,
            type: PARSE_PROGRAM,
          },
        },
        resolve: resolvePromise,
        reject,
      };
      this.queue.push(pending);
      this.drainQueue();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0)) {
      pending.reject(new Error("CobolWorkerPool closed before job started"));
    }
    await Promise.allSettled(this.slots.map((slot) => slot.worker.terminate()));
  }

  private createSlot(): WorkerSlot {
    const slot: WorkerSlot = {
      worker: new Worker(workerBootstrap(), {
        eval: true,
        workerData: {
          modulePath: this.workerPath,
        },
      }),
      busy: false,
    };

    slot.worker.on("message", (message: WorkerResponse) => {
      this.handleWorkerResponse(slot, message);
    });
    slot.worker.on("error", (err) => {
      this.handleWorkerFailure(slot, err);
    });
    slot.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.handleWorkerFailure(slot, new Error(`Worker exited with code ${code}`));
      }
    });

    return slot;
  }

  private drainQueue(): void {
    if (this.closed) return;

    for (const slot of this.slots) {
      if (slot.busy) continue;
      const pending = this.queue.shift();
      if (!pending) return;

      slot.busy = true;
      slot.current = pending;
      pending.timeout = setTimeout(() => {
        this.handleWorkerFailure(
          slot,
          new Error(`Worker job ${pending.request.id} timed out after ${this.jobTimeoutMs}ms`)
        );
      }, this.jobTimeoutMs);
      slot.worker.postMessage(pending.request);
    }
  }

  private handleWorkerResponse(slot: WorkerSlot, message: WorkerResponse): void {
    const current = slot.current;
    if (!current || current.request.id !== message.id) return;

    this.clearCurrent(slot);
    if (message.ok && message.result) {
      current.resolve(message.result);
    } else {
      current.reject(new Error(message.error ?? "Worker job failed"));
    }
    this.drainQueue();
  }

  private handleWorkerFailure(slot: WorkerSlot, err: Error): void {
    const current = slot.current;
    this.clearCurrent(slot);
    if (current) {
      current.reject(err);
    }

    const index = this.slots.indexOf(slot);
    if (!this.closed && index >= 0) {
      void slot.worker.terminate().catch(() => undefined);
      this.slots[index] = this.createSlot();
    }
    this.drainQueue();
  }

  private clearCurrent(slot: WorkerSlot): void {
    if (slot.current?.timeout) {
      clearTimeout(slot.current.timeout);
    }
    slot.current = undefined;
    slot.busy = false;
  }
}

export async function parseProgramsConcurrently(
  programs: Array<Omit<ParseProgramJob, "type">>,
  options: WorkerPoolOptions = {}
): Promise<ParsedProgramResult[]> {
  if (programs.length === 0) return [];

  const pool = new CobolWorkerPool({
    ...options,
    size: Math.min(options.size ?? defaultWorkerCount(), programs.length),
  });
  try {
    return await Promise.all(
      programs.map((program) =>
        pool.parseProgram(program).catch((err) => ({
          programId: program.programId,
          extractedRules: [],
          timingMs: 0,
          error: err instanceof Error ? err.message : String(err),
        }))
      )
    );
  } finally {
    await pool.close();
  }
}

export function parseProgramInProcess(job: Omit<ParseProgramJob, "type">): ParsedProgramResult {
  const start = Date.now();
  const { COBOLParser, SemanticElevator } = loadParserClasses();
  const parser = new COBOLParser();
  const ast = parser.parse(job.source);
  const elevator = new SemanticElevator();
  const semanticTree = elevator.elevate(ast);
  return {
    programId: job.programId,
    ast,
    semanticTree,
    extractedRules: extractBusinessRules(semanticTree),
    timingMs: Date.now() - start,
  };
}

export function resolveWorkerCount(value?: number): number {
  const configured = value ?? parseOptionalInt(process.env.AGENTSMCP_PARSE_WORKERS);
  if (configured !== undefined) return Math.max(1, Math.floor(configured));
  return 1;
}

function defaultWorkerCount(): number {
  const cpuCount = cpus().length || 2;
  return Math.max(1, Math.min(cpuCount - 1, 4));
}

function parseOptionalInt(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function workerBootstrap(): string {
  return `
const { workerData } = require("worker_threads");
const modulePath = workerData.modulePath;
if (/\\.tsx?$/.test(modulePath)) {
  try {
    require("ts-node/register/transpile-only");
  } catch (err) {
    require("ts-node/register");
  }
}
require(modulePath);
`;
}

function startWorker(port: MessagePort): void {
  port.on("message", async (request: WorkerRequest) => {
    try {
      if (!request || request.job?.type !== PARSE_PROGRAM) {
        throw new Error(`Unsupported worker job: ${request?.job?.type ?? "unknown"}`);
      }

      const result = parseProgramInProcess(request.job);
      port.postMessage({
        id: request.id,
        ok: true,
        result,
      } satisfies WorkerResponse);
    } catch (err) {
      port.postMessage({
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies WorkerResponse);
    }
  });
}

function loadParserClasses(): {
  COBOLParser: new () => { parse(source: string): unknown };
  SemanticElevator: new () => { elevate(ast: unknown): unknown };
} {
  const path = require("path");
  const fs = require("fs");
  const cjsDist = path.resolve(__dirname, "../../parser/dist-cjs");
  const srcDir = path.resolve(__dirname, "../../parser/src");
  const parserRoot = fs.existsSync(path.join(cjsDist, "types.js")) ? cjsDist : srcDir;
  const cobolParser = require(path.join(parserRoot, "cobol-parser"));
  const semanticElevator = require(path.join(parserRoot, "semantic-elevator"));
  return {
    COBOLParser: cobolParser.COBOLParser,
    SemanticElevator: semanticElevator.SemanticElevator,
  };
}

function extractBusinessRules(semanticTree: unknown): Array<{ id: string; type: string; description: string }> {
  return collectSemanticNodes(semanticTree, "BUSINESS_RULE")
    .map((node) => {
      const description = stringValue(node.description);
      const sourceAST = isRecord(node.sourceAST) ? node.sourceAST : {};
      return {
        id: description.split(":")[0]?.trim() || description || "unknown",
        type: stringValue(sourceAST.type) || "RULE",
        description,
      };
    });
}

function collectSemanticNodes(node: unknown, type: string): Array<Record<string, unknown>> {
  const current = node as { type?: string; children?: unknown[] };
  const result: Array<Record<string, unknown>> = [];
  if (current?.type === type) result.push(current as Record<string, unknown>);
  for (const child of current?.children ?? []) {
    result.push(...collectSemanticNodes(child, type));
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

if (!isMainThread && parentPort && workerData?.modulePath) {
  startWorker(parentPort);
}

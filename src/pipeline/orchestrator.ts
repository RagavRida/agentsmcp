import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";

export type TaskStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface TaskExecutionView {
  get<T = unknown>(taskId: string): T | undefined;
  require<T = unknown>(taskId: string): T;
  all(): Record<string, unknown>;
}

export interface Task<TContext = unknown, TOutput = unknown> {
  id: string;
  dependencies?: string[];
  execute(context: TContext, results: TaskExecutionView): Promise<TOutput> | TOutput;
  rollback?(context: TContext, results: TaskExecutionView): Promise<void> | void;
}

export interface PipelineTaskState {
  id: string;
  status: TaskStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
}

export interface PipelineState {
  runId: string;
  updatedAt: string;
  tasks: Record<string, PipelineTaskState>;
  outputs: Record<string, unknown>;
}

export interface PipelineOptions {
  runId?: string;
  stateFile?: string;
  rollbackOnFailure?: boolean;
}

export interface PipelineRunResult {
  runId: string;
  status: "COMPLETED" | "FAILED";
  completed: string[];
  failed?: string;
  outputs: Record<string, unknown>;
  stateFile?: string;
}

export class Pipeline<TContext = unknown> {
  private readonly tasks = new Map<string, Task<TContext>>();
  private readonly dependencies = new Map<string, string[]>();
  private state?: PipelineState;
  private readonly stateFile?: string;
  private readonly rollbackOnFailure: boolean;
  private readonly runId: string;

  constructor(tasks: Array<Task<TContext>>, options: PipelineOptions = {}) {
    if (tasks.length === 0) {
      throw new Error("Pipeline requires at least one task");
    }

    this.stateFile = options.stateFile ? resolve(options.stateFile) : undefined;
    this.rollbackOnFailure = options.rollbackOnFailure ?? false;
    this.runId = options.runId ?? `pipeline-${Date.now().toString(36)}`;

    for (const task of tasks) {
      if (this.tasks.has(task.id)) {
        throw new Error(`Duplicate pipeline task id: ${task.id}`);
      }
      this.tasks.set(task.id, task);
      this.dependencies.set(task.id, [...(task.dependencies ?? [])]);
    }

    this.validateDag();
  }

  async run(context: TContext): Promise<PipelineRunResult> {
    await this.loadState();
    const state = this.currentState();
    const order = this.topologicalOrder();
    const results = this.createResultsView(state.outputs);

    for (const taskId of order) {
      const taskState = state.tasks[taskId];
      if (taskState.status === "COMPLETED") continue;

      const missingDependency = (this.dependencies.get(taskId) ?? [])
        .find((dependency) => state.tasks[dependency]?.status !== "COMPLETED");
      if (missingDependency) {
        throw new Error(
          `Task "${taskId}" cannot run before dependency "${missingDependency}" completes`
        );
      }

      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown pipeline task: ${taskId}`);

      await this.markRunning(taskId);
      try {
        const output = await task.execute(context, results);
        state.outputs[taskId] = output;
        await this.markCompleted(taskId);
      } catch (err) {
        await this.markFailed(taskId, err);
        if (this.rollbackOnFailure) {
          await this.rollbackCompleted(context, order, taskId);
        }
        return {
          runId: state.runId,
          status: "FAILED",
          completed: order.filter((id) => state.tasks[id]?.status === "COMPLETED"),
          failed: taskId,
          outputs: state.outputs,
          stateFile: this.stateFile,
        };
      }
    }

    return {
      runId: state.runId,
      status: "COMPLETED",
      completed: order,
      outputs: state.outputs,
      stateFile: this.stateFile,
    };
  }

  getState(): PipelineState | undefined {
    return this.state ? cloneState(this.state) : undefined;
  }

  private async loadState(): Promise<void> {
    if (!this.stateFile) {
      this.state = this.createInitialState();
      return;
    }

    try {
      const raw = await readFile(this.stateFile, "utf-8");
      const parsed = JSON.parse(raw) as PipelineState;
      this.state = this.normalizeState(parsed);
    } catch (err) {
      if (isEnoent(err)) {
        this.state = this.createInitialState();
        await this.persistState();
        return;
      }
      throw err;
    }
  }

  private currentState(): PipelineState {
    if (!this.state) {
      this.state = this.createInitialState();
    }
    return this.state;
  }

  private createInitialState(): PipelineState {
    const tasks: Record<string, PipelineTaskState> = {};
    for (const taskId of this.tasks.keys()) {
      tasks[taskId] = {
        id: taskId,
        status: "PENDING",
        attempts: 0,
      };
    }
    return {
      runId: this.runId,
      updatedAt: new Date().toISOString(),
      tasks,
      outputs: {},
    };
  }

  private normalizeState(state: PipelineState): PipelineState {
    const normalized = state && typeof state === "object"
      ? {
          runId: state.runId || this.runId,
          updatedAt: state.updatedAt || new Date().toISOString(),
          tasks: { ...(state.tasks ?? {}) },
          outputs: { ...(state.outputs ?? {}) },
        }
      : this.createInitialState();

    for (const taskId of this.tasks.keys()) {
      const existing = normalized.tasks[taskId];
      normalized.tasks[taskId] = {
        id: taskId,
        attempts: existing?.attempts ?? 0,
        status: resetResumableStatus(existing?.status ?? "PENDING"),
        startedAt: existing?.startedAt,
        completedAt: existing?.completedAt,
        failedAt: existing?.failedAt,
        error: existing?.error,
      };
      if (normalized.tasks[taskId].status !== "COMPLETED") {
        delete normalized.outputs[taskId];
      }
    }

    for (const taskId of Object.keys(normalized.tasks)) {
      if (!this.tasks.has(taskId)) {
        delete normalized.tasks[taskId];
        delete normalized.outputs[taskId];
      }
    }

    return normalized;
  }

  private async markRunning(taskId: string): Promise<void> {
    const state = this.currentState();
    state.tasks[taskId] = {
      ...state.tasks[taskId],
      status: "RUNNING",
      attempts: (state.tasks[taskId]?.attempts ?? 0) + 1,
      startedAt: new Date().toISOString(),
      failedAt: undefined,
      error: undefined,
    };
    await this.persistState();
  }

  private async markCompleted(taskId: string): Promise<void> {
    const state = this.currentState();
    state.tasks[taskId] = {
      ...state.tasks[taskId],
      status: "COMPLETED",
      completedAt: new Date().toISOString(),
      failedAt: undefined,
      error: undefined,
    };
    await this.persistState();
  }

  private async markFailed(taskId: string, err: unknown): Promise<void> {
    const state = this.currentState();
    state.tasks[taskId] = {
      ...state.tasks[taskId],
      status: "FAILED",
      failedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
    await this.persistState();
  }

  private async rollbackCompleted(
    context: TContext,
    order: string[],
    failedTaskId: string
  ): Promise<void> {
    const state = this.currentState();
    const failedIndex = order.indexOf(failedTaskId);
    const completedBeforeFailure = order
      .slice(0, failedIndex)
      .reverse()
      .filter((taskId) => state.tasks[taskId]?.status === "COMPLETED");

    const results = this.createResultsView(state.outputs);
    for (const taskId of completedBeforeFailure) {
      const task = this.tasks.get(taskId);
      if (!task?.rollback) continue;
      await task.rollback(context, results);
      state.tasks[taskId] = {
        ...state.tasks[taskId],
        status: "PENDING",
        completedAt: undefined,
      };
      delete state.outputs[taskId];
      await this.persistState();
    }
  }

  private createResultsView(outputs: Record<string, unknown>): TaskExecutionView {
    return {
      get: <T = unknown>(taskId: string): T | undefined => outputs[taskId] as T | undefined,
      require: <T = unknown>(taskId: string): T => {
        if (!(taskId in outputs)) {
          throw new Error(`Pipeline task output "${taskId}" is not available`);
        }
        return outputs[taskId] as T;
      },
      all: () => ({ ...outputs }),
    };
  }

  private async persistState(): Promise<void> {
    if (!this.stateFile || !this.state) return;
    this.state.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2), "utf-8");
  }

  private validateDag(): void {
    for (const [taskId, dependencies] of this.dependencies) {
      for (const dependency of dependencies) {
        if (!this.tasks.has(dependency)) {
          throw new Error(`Task "${taskId}" depends on unknown task "${dependency}"`);
        }
      }
    }
    this.topologicalOrder();
  }

  private topologicalOrder(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (taskId: string): void => {
      if (visited.has(taskId)) return;
      if (visiting.has(taskId)) {
        throw new Error(`Pipeline DAG contains a cycle at task "${taskId}"`);
      }
      visiting.add(taskId);
      for (const dependency of this.dependencies.get(taskId) ?? []) {
        visit(dependency);
      }
      visiting.delete(taskId);
      visited.add(taskId);
      order.push(taskId);
    };

    for (const taskId of this.tasks.keys()) {
      visit(taskId);
    }

    return order;
  }
}

function resetResumableStatus(status: TaskStatus): TaskStatus {
  return status === "COMPLETED" ? "COMPLETED" : "PENDING";
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function cloneState(state: PipelineState): PipelineState {
  return JSON.parse(JSON.stringify(state)) as PipelineState;
}

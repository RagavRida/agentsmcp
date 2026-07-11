/**
 * Health Checks — system health monitoring for on-prem deployment.
 *
 * Inspired by Cognee's api/v1/health/ module.
 * Returns structured health status for each subsystem.
 */

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  uptime: number;
  checks: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  latencyMs: number;
  detail?: string;
}

const startTime = Date.now();

/**
 * Run all health checks and return aggregate status.
 *
 * Checks:
 *   - SQLite connectivity (storage)
 *   - GPU/Modal endpoint reachability (embeddings)
 *   - Neo4j connectivity (graph)
 *   - BYOS S3 connectivity (object storage)
 *   - vLLM endpoint (inference)
 */
export async function checkHealth(opts?: {
  storageUrl?: string;
  modalUrl?: string;
  neo4jUrl?: string;
  byosEndpoint?: string;
  vllmUrl?: string;
}): Promise<HealthStatus> {
  const checks: HealthCheck[] = [];

  // 1. SQLite / Storage
  checks.push(await checkStorage(opts?.storageUrl));

  // 2. Embedding endpoint
  if (opts?.modalUrl || process.env.AGENTSMCP_MODAL_EMBED_URL) {
    checks.push(await checkEndpoint(
      "embedding_endpoint",
      opts?.modalUrl || process.env.AGENTSMCP_MODAL_EMBED_URL!
    ));
  }

  // 3. Neo4j (dedicated driver-based check)
  checks.push(await checkNeo4j());

  // 4. BYOS / S3
  if (opts?.byosEndpoint || process.env.BYOS_ENDPOINT) {
    checks.push(await checkEndpoint(
      "byos_s3",
      opts?.byosEndpoint || process.env.BYOS_ENDPOINT!
    ));
  }

  // 5. vLLM inference
  if (opts?.vllmUrl || process.env.VLLM_URL) {
    checks.push(await checkEndpoint(
      "vllm_inference",
      opts?.vllmUrl || process.env.VLLM_URL!
    ));
  }

  // Always check memory/CPU, vector store, and background tasks
  checks.push(checkMemory());
  checks.push(await checkVectorStore());
  checks.push(checkBackgroundTasks());

  // Aggregate
  const hasFail = checks.some(c => c.status === "fail");
  const hasWarn = checks.some(c => c.status === "warn");

  return {
    status: hasFail ? "unhealthy" : hasWarn ? "degraded" : "healthy",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? "0.0.0",
    uptime: Date.now() - startTime,
    checks,
  };
}

async function checkStorage(url?: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    if (url) {
      // For SQLite, just check the file exists
      const fs = await import("fs");
      const dbPath = url.replace("file:", "").replace(/\?.*$/, "");
      if (dbPath && dbPath !== ":memory:") {
        fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
      }
    }

    // Report SQLite worker thread status if applicable
    let workerDetail = "";
    try {
      const svc = require("../memory/service") as Record<string, unknown>;
      const getSqliteHarness = svc.getSqliteHarness as (() => any) | undefined;
      const harness = getSqliteHarness?.();
      if (harness) {
        const alive = typeof harness.isAlive === "function" ? harness.isAlive() : true;
        const threadId = typeof harness.threadId === "number" ? harness.threadId : null;
        const lastCrash = typeof harness.lastCrash === "number" ? harness.lastCrash : null;
        workerDetail = ` | worker_thread=${alive ? "alive" : "dead"}`;
        if (threadId != null) workerDetail += ` tid=${threadId}`;
        if (lastCrash != null) workerDetail += ` last_crash=${new Date(lastCrash).toISOString()}`;
        if (!alive) {
          return {
            name: "storage",
            status: "warn",
            latencyMs: Date.now() - start,
            detail: `SQLite worker thread is dead${workerDetail}`,
          };
        }
      }
    } catch {
      // getSqliteHarness may not exist; fall through
    }

    return { name: "storage", status: "pass", latencyMs: Date.now() - start, detail: `ok${workerDetail}` };
  } catch (err) {
    return { name: "storage", status: "fail", latencyMs: Date.now() - start, detail: String(err) };
  }
}

async function checkEndpoint(name: string, url: string): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url.replace(/\/$/, "") + "/health", {
      method: "GET",
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);

    if (res && res.ok) {
      return { name, status: "pass", latencyMs: Date.now() - start };
    } else if (res) {
      return { name, status: "warn", latencyMs: Date.now() - start, detail: `HTTP ${res.status}` };
    } else {
      return { name, status: "fail", latencyMs: Date.now() - start, detail: "unreachable" };
    }
  } catch (err) {
    return { name, status: "fail", latencyMs: Date.now() - start, detail: String(err) };
  }
}

function checkMemory(): HealthCheck {
  const start = Date.now();
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const pct = (usage.heapUsed / usage.heapTotal) * 100;

  return {
    name: "memory",
    status: pct > 90 ? "warn" : "pass",
    latencyMs: Date.now() - start,
    detail: `${heapUsedMB}MB / ${heapTotalMB}MB (${pct.toFixed(0)}%)`,
  };
}

async function checkVectorStore(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const { getVectorStore, useVectorWorker } = await import("../memory/service");
    const store = getVectorStore();
    const count = await store.count();
    const mode = useVectorWorker() ? "subprocess worker" : "in-process";

    // Report worker PID and last crash time
    const workerPid =
      "workerPid" in store && typeof store.workerPid === "number"
        ? ` pid=${store.workerPid}`
        : "";
    const lastCrash =
      "lastCrash" in store && typeof store.lastCrash === "number"
        ? ` last_crash=${new Date(store.lastCrash as number).toISOString()}`
        : "";

    return {
      name: "vector_store",
      status: "pass",
      latencyMs: Date.now() - start,
      detail: `${mode}${workerPid}${lastCrash}, ${count} vectors`,
    };
  } catch (err) {
    return {
      name: "vector_store",
      status: "fail",
      latencyMs: Date.now() - start,
      detail: String(err),
    };
  }
}

function checkBackgroundTasks(): HealthCheck {
  const start = Date.now();
  try {
    const { listBackgroundTasks } = require("../memory/service") as {
      listBackgroundTasks: (limit?: number) => Array<{ status: string }>;
    };
    const tasks = listBackgroundTasks(100);
    const running = tasks.filter((t) => t.status === "running").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    const pending = tasks.filter((t) => t.status === "pending").length;
    return {
      name: "background_tasks",
      status: failed > 0 ? "warn" : "pass",
      latencyMs: Date.now() - start,
      detail: `${running} running, ${pending} pending, ${failed} failed, ${tasks.length} recent`,
    };
  } catch (err) {
    return {
      name: "background_tasks",
      status: "warn",
      latencyMs: Date.now() - start,
      detail: String(err),
    };
  }
}

/**
 * Dedicated Neo4j connectivity check using the driver directly,
 * rather than just pinging a /health HTTP endpoint.
 */
export async function checkNeo4j(): Promise<HealthCheck> {
  const start = Date.now();
  const uri = process.env.NEO4J_URI;
  if (!uri) {
    return {
      name: "neo4j",
      status: "pass",
      latencyMs: Date.now() - start,
      detail: "not configured (NEO4J_URI unset)",
    };
  }

  try {
    const neo4j = await import("neo4j-driver").catch(() => null);
    if (!neo4j) {
      return {
        name: "neo4j",
        status: "warn",
        latencyMs: Date.now() - start,
        detail: "neo4j-driver not installed",
      };
    }

    const user = process.env.NEO4J_USER ?? "neo4j";
    const password = process.env.NEO4J_PASSWORD ?? "";
    const driver = neo4j.default.driver(uri, neo4j.default.auth.basic(user, password));
    const session = driver.session();

    try {
      const result = await session.run("RETURN 1 AS n");
      const n = result.records[0]?.get("n")?.toNumber?.() ?? result.records[0]?.get("n");
      if (n === 1) {
        return {
          name: "neo4j",
          status: "pass",
          latencyMs: Date.now() - start,
          detail: `connected to ${uri}`,
        };
      }
      return {
        name: "neo4j",
        status: "warn",
        latencyMs: Date.now() - start,
        detail: `unexpected response: ${JSON.stringify(n)}`,
      };
    } finally {
      await session.close();
      await driver.close();
    }
  } catch (err) {
    return {
      name: "neo4j",
      status: "fail",
      latencyMs: Date.now() - start,
      detail: String(err),
    };
  }
}

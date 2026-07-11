export interface UsageEntry {
  tool: string;
  latencyMs: number;
  timestamp: string;
  success: boolean;
}

const _usageLog: UsageEntry[] = [];
const MAX_USAGE_LOG = 500;

export function logToolUsage(tool: string, latencyMs: number, success: boolean): void {
  _usageLog.push({
    tool,
    latencyMs,
    timestamp: new Date().toISOString(),
    success,
  });
  if (_usageLog.length > MAX_USAGE_LOG) _usageLog.shift();
}

export function getUsageStats(recentTaskErrors?: Array<{ ts: string; error: string }>): {
  totalCalls: number;
  toolCounts: Record<string, number>;
  avgLatencyMs: Record<string, number>;
  errorRate: number;
  recentErrors: Array<{ ts: string; error: string }>;
} {
  const toolCounts: Record<string, number> = {};
  const toolLatencies: Record<string, number[]> = {};
  let errorCount = 0;

  for (const entry of _usageLog) {
    toolCounts[entry.tool] = (toolCounts[entry.tool] ?? 0) + 1;
    if (!toolLatencies[entry.tool]) toolLatencies[entry.tool] = [];
    toolLatencies[entry.tool].push(entry.latencyMs);
    if (!entry.success) errorCount++;
  }

  const avgLatencyMs: Record<string, number> = {};
  for (const [tool, latencies] of Object.entries(toolLatencies)) {
    avgLatencyMs[tool] = Math.round(
      latencies.reduce((a, b) => a + b, 0) / latencies.length,
    );
  }

  const recentErrors = [...(recentTaskErrors ?? [])].sort((a, b) =>
    b.ts.localeCompare(a.ts),
  );

  return {
    totalCalls: _usageLog.length,
    toolCounts,
    avgLatencyMs,
    errorRate: _usageLog.length > 0 ? errorCount / _usageLog.length : 0,
    recentErrors: recentErrors.slice(0, 10),
  };
}

export function resetUsageStats(): void {
  _usageLog.length = 0;
}

/** Full usage stats including failed background tasks. */
export function getMcpUsageStats(): ReturnType<typeof getUsageStats> {
  const recentErrors: Array<{ ts: string; error: string }> = [];
  try {
    const { listBackgroundTasks } = require("../memory/service") as {
      listBackgroundTasks: (limit?: number) => Array<{
        status: string;
        error?: string;
        completedAt?: string;
        tool: string;
      }>;
    };
    for (const task of listBackgroundTasks(50)) {
      if (task.status === "failed" && task.error && task.completedAt) {
        recentErrors.push({
          ts: task.completedAt,
          error: `${task.tool}: ${task.error}`,
        });
      }
    }
  } catch {
    // memory service may be unavailable in some test contexts
  }
  return getUsageStats(recentErrors);
}

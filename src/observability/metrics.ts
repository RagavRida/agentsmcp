import type { NextFunction, Request, Response } from "express";

export class MetricsRegistry {
  private requests = 0;
  private failures = 0;
  private totalLatencyMs = 0;
  private modelCalls = 0;
  private modelFailures = 0;
  private modelLatencyMs = 0;

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const started = Date.now();
      this.requests++;
      res.once("finish", () => {
        const latency = Date.now() - started;
        this.totalLatencyMs += latency;
        if (res.statusCode >= 500) this.failures++;
      });
      next();
    };
  }

  recordModelCall(latencyMs: number, failed = false): void {
    this.modelCalls++;
    this.modelLatencyMs += latencyMs;
    if (failed) this.modelFailures++;
  }

  toPrometheus(): string {
    const avgRequest = this.requests ? this.totalLatencyMs / this.requests : 0;
    const avgModel = this.modelCalls ? this.modelLatencyMs / this.modelCalls : 0;
    return [
      "# HELP agentsmcp_http_requests_total Total HTTP requests.",
      "# TYPE agentsmcp_http_requests_total counter",
      `agentsmcp_http_requests_total ${this.requests}`,
      "# HELP agentsmcp_http_failures_total HTTP responses with status 500 or higher.",
      "# TYPE agentsmcp_http_failures_total counter",
      `agentsmcp_http_failures_total ${this.failures}`,
      "# HELP agentsmcp_http_latency_ms_avg Average HTTP request latency in milliseconds.",
      "# TYPE agentsmcp_http_latency_ms_avg gauge",
      `agentsmcp_http_latency_ms_avg ${avgRequest.toFixed(2)}`,
      "# HELP agentsmcp_model_calls_total Total model calls.",
      "# TYPE agentsmcp_model_calls_total counter",
      `agentsmcp_model_calls_total ${this.modelCalls}`,
      "# HELP agentsmcp_model_failures_total Failed model calls.",
      "# TYPE agentsmcp_model_failures_total counter",
      `agentsmcp_model_failures_total ${this.modelFailures}`,
      "# HELP agentsmcp_model_latency_ms_avg Average model latency in milliseconds.",
      "# TYPE agentsmcp_model_latency_ms_avg gauge",
      `agentsmcp_model_latency_ms_avg ${avgModel.toFixed(2)}`,
      "",
    ].join("\n");
  }
}

export const defaultMetrics = new MetricsRegistry();

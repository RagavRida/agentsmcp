/**
 * Unit tests for Observability — span creation, trace context, ATTR constants.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  startSpan, withSpan, enableTracing, disableTracing,
  isTracingEnabled, getTraces, getLastTrace, clearTraces, ATTR,
} from "../../src/observability";

describe("Observability", () => {
  beforeEach(() => {
    clearTraces();
    disableTracing();
  });

  // ── ATTR Constants ──────────────────────────────

  it("ATTR has pipeline attributes", () => {
    expect(ATTR.PIPELINE_NAME).toBe("agentsmcp.pipeline.name");
    expect(ATTR.PARSE_PROGRAM).toBe("agentsmcp.parse.program");
    expect(ATTR.SEARCH_STRATEGY).toBe("agentsmcp.search.strategy");
  });

  it("ATTR has banking-specific attributes", () => {
    expect(ATTR.VERIFY_INVARIANT).toBe("agentsmcp.verify.invariant");
    expect(ATTR.VERIFY_RESULT).toBe("agentsmcp.verify.result");
    expect(ATTR.MEMORY_OP).toBe("agentsmcp.memory.operation");
  });

  // ── Trace Context ──────────────────────────────

  it("tracing starts disabled", () => {
    expect(isTracingEnabled()).toBe(false);
  });

  it("enable/disable tracing", () => {
    enableTracing();
    expect(isTracingEnabled()).toBe(true);
    disableTracing();
    expect(isTracingEnabled()).toBe(false);
  });

  // ── Span Creation ──────────────────────────────

  it("startSpan creates a span", () => {
    enableTracing();
    const span = startSpan("test.span");
    span.setAttribute(ATTR.PARSE_PROGRAM, "LOAN-PROC");
    span.setStatus("OK");
    span.end();

    const traces = getTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].name).toBe("test.span");
    expect(traces[0].attributes[ATTR.PARSE_PROGRAM]).toBe("LOAN-PROC");
    expect(traces[0].status).toBe("OK");
    expect(traces[0].endTime).toBeDefined();
  });

  it("spans not recorded when tracing disabled", () => {
    disableTracing();
    const span = startSpan("invisible");
    span.end();
    expect(getTraces()).toHaveLength(0);
  });

  it("getLastTrace returns most recent span", () => {
    enableTracing();
    startSpan("first").end();
    startSpan("second").end();

    expect(getLastTrace()?.name).toBe("second");
  });

  it("clearTraces removes all traces", () => {
    enableTracing();
    startSpan("a").end();
    startSpan("b").end();
    clearTraces();
    expect(getTraces()).toHaveLength(0);
  });

  // ── withSpan utility ───────────────────────────

  it("withSpan auto-ends and sets OK", async () => {
    enableTracing();
    const result = await withSpan("auto.span", async (span) => {
      span.setAttribute("key", "value");
      return 42;
    });

    expect(result).toBe(42);
    const trace = getLastTrace()!;
    expect(trace.status).toBe("OK");
    expect(trace.endTime).toBeDefined();
  });

  it("withSpan catches errors and sets ERROR", async () => {
    enableTracing();
    await expect(
      withSpan("error.span", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const trace = getLastTrace()!;
    expect(trace.status).toBe("ERROR");
    expect(trace.statusMessage).toContain("boom");
  });
});

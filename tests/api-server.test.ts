import type { Server } from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiApp, type PipelineOrchestratorLike } from "../src/api/server";
import type { ParseCobolResult } from "../src/parser";

const SAMPLE_RESULT: ParseCobolResult = {
  programName: "LOAN-CALC",
  semanticTree: {
    id: "root",
    type: "PROGRAM",
    description: "Loan calculation program",
    domain: "Risk",
    inputs: [],
    outputs: [],
    sideEffects: [],
    children: [
      {
        id: "rule-interest",
        type: "BUSINESS_RULE",
        description: "Calculate monthly interest from principal and rate",
        domain: "Risk",
        inputs: ["WS-PRINCIPAL", "WS-RATE"],
        outputs: ["WS-INTEREST"],
        sideEffects: [],
        children: [],
      },
    ],
  },
  graph: {
    nodes: [{ id: "rule-interest", label: "Interest Rule", type: "BUSINESS_RULE" }],
    edges: [],
  },
  businessRules: [],
  dataAccess: [],
  controlFlow: [],
  dataTransforms: [],
  stats: {
    paragraphs: 1,
    variables: 3,
    graphNodes: 1,
    graphEdges: 0,
    llmCalls: 0,
    codeSentExternally: "0 bytes",
  },
};

describe("AgentMailbox Memory API", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it("extracts COBOL through the configured orchestrator and searches extracted rules", async () => {
    const orchestrator: PipelineOrchestratorLike = {
      extract: vi.fn(async () => SAMPLE_RESULT),
    };
    const url = await start(createApiApp({ pipelineOrchestrator: orchestrator }));

    const extract = await fetch(`${url}/api/v1/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "IDENTIFICATION DIVISION.", filename: "LOAN.CBL" }),
    });

    expect(extract.status).toBe(200);
    const extracted = await extract.json();
    expect(extracted.programName).toBe("LOAN-CALC");
    expect(orchestrator.extract).toHaveBeenCalledWith({
      code: "IDENTIFICATION DIVISION.",
      filename: "LOAN.CBL",
    });

    const search = await fetch(`${url}/api/v1/graph/search?q=interest&limit=5`);
    expect(search.status).toBe(200);
    const body = await search.json();
    expect(body.source).toBe("local-extract-cache");
    expect(body.count).toBe(1);
    expect(body.results[0]).toMatchObject({
      id: "rule-interest",
      program: "LOAN-CALC",
      type: "BUSINESS_RULE",
    });
  });

  it("uses an injected graph search provider when configured", async () => {
    const graphSearchProvider = {
      search: vi.fn(async () => [
        {
          id: "external-rule",
          program: "PAY-BATCH",
          type: "BUSINESS_RULE",
          domain: "Payments",
          description: "Check batch imbalance",
          score: 0.99,
        },
      ]),
    };
    const url = await start(createApiApp({ graphSearchProvider }));

    const res = await fetch(`${url}/api/v1/graph/search?query=batch&program=PAY-BATCH`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("graph-search-provider");
    expect(body.results[0].id).toBe("external-rule");
    expect(graphSearchProvider.search).toHaveBeenCalledWith({
      query: "batch",
      limit: 10,
      program: "PAY-BATCH",
      domain: undefined,
    });
  });

  it("returns structured validation errors", async () => {
    const url = await start(createApiApp());

    const res = await fetch(`${url}/api/v1/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Invalid extract request");
  });

  it("returns structured not found errors", async () => {
    const url = await start(createApiApp());

    const res = await fetch(`${url}/api/v1/missing`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "No route for GET /api/v1/missing",
    });
  });

  it("returns structured malformed JSON errors", async () => {
    const url = await start(createApiApp());

    const res = await fetch(`${url}/api/v1/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatchObject({
      code: "INVALID_JSON",
      message: "Malformed JSON request body",
    });
  });

  it("describes the ingest endpoint for browser GET requests", async () => {
    const url = await start(createApiApp());
    const response = await fetch(`${url}/api/v1/ingest`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ endpoint: "/api/v1/ingest", method: "POST" });
  });

  it("exposes an honest product capability matrix", async () => {
    const url = await start(createApiApp());
    const response = await fetch(`${url}/api/v1/product/capabilities`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      capabilities: Array<{ id: string; status: string; evidence: string[] }>;
    };
    expect(body.capabilities.some((item) => item.status === "roadmap")).toBe(true);
    expect(body.capabilities.find((item) => item.id === "mainframe-parser-registry")).toMatchObject({
      status: "live",
    });
    expect(body.capabilities.every((item) => item.evidence.length > 0)).toBe(true);
  });

  async function start(app: ReturnType<typeof createApiApp>): Promise<string> {
    return new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server!.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }
});

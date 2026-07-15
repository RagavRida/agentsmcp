import type { Server } from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiApp, type PipelineOrchestratorLike } from "../src/api/server";
import { IngestionService } from "../src/ingestion";
import { LocalStorageAdapter } from "../src/storage/interfaces";
import type { ParseCobolResult } from "../src/parser";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  it("ingests repository batches and exposes inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmailbox-ingest-"));
    try {
      const ingestionService = new IngestionService({
        manifestStorage: new LocalStorageAdapter(root),
        processor: {
          async process(file) {
            return {
              program: file.filename.replace(/\W+/g, "-").toUpperCase(),
              rulesExtracted: 2,
              businessRules: [
                {
                  id: "rule-interest",
                  type: "BUSINESS_RULE",
                  domain: "core-banking",
                  description: "Calculates monthly interest from balance and rate.",
                },
              ],
            };
          },
        },
      });
      const url = await start(createApiApp({ ingestionService }));
      const payload = {
        dataset: "core-banking",
        connectorRunId: "run-001",
        files: [
          {
            sourceId: "core/LOAN.CBL",
            filename: "LOAN.CBL",
            code: "IDENTIFICATION DIVISION. PROGRAM-ID. LOAN.",
            language: "cobol",
            version: "abc123",
          },
        ],
      };

      const first = await fetch(`${url}/api/v1/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ indexed: 1, skipped: 0, failed: 0 });

      const second = await fetch(`${url}/api/v1/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ indexed: 0, skipped: 1, failed: 0 });

      const inventory = await fetch(`${url}/api/v1/ingest/inventory`);
      expect(inventory.status).toBe(200);
      expect(await inventory.json()).toMatchObject({
        datasets: ["core-banking"],
        totalFiles: 1,
        files: [
          {
            sourceId: "core/LOAN.CBL",
            filename: "LOAN.CBL",
            status: "skipped",
            dataset: "core-banking",
            program: "LOAN-CBL",
            language: "cobol",
          },
        ],
      });

      const details = await fetch(`${url}/api/v1/ingest/sources/${encodeURIComponent("core/LOAN.CBL")}`);
      expect(details.status).toBe(200);
      expect(await details.json()).toMatchObject({
        sourceId: "core/LOAN.CBL",
        program: "LOAN-CBL",
        rulesExtracted: 2,
        businessRules: [
          {
            id: "rule-interest",
            description: "Calculates monthly interest from balance and rate.",
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

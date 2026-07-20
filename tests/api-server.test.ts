import type { Server } from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiApp, type PipelineOrchestratorLike } from "../src/api/server";
import { IngestionService, KnowledgeEnrichmentService } from "../src/ingestion";
import { LocalStorageAdapter } from "../src/storage/interfaces";
import type { ParseCobolResult } from "../src/parser";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectSourceArtifactsFromDirectory, isImportableSourcePath } from "../src/ingestion/connectors";

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
      tenantId: undefined,
      limit: 10,
      program: "PAY-BATCH",
      domain: undefined,
    });
  });

  it("answers chat queries only when grounded citations exist", async () => {
    const graphSearchProvider = {
      search: vi.fn(async () => [
        {
          id: "rule-interest",
          program: "LOAN-CALC",
          type: "BUSINESS_RULE",
          domain: "Risk",
          description: "Calculate monthly interest from principal and rate",
          score: 0.91,
          metadata: { sourceId: "core/LOAN.CBL" },
        },
      ]),
    };
    const url = await start(createApiApp({ graphSearchProvider }));

    const res = await fetch(`${url}/api/v1/chat/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How is interest calculated?", limit: 5 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      query: "How is interest calculated?",
      sourceIds: ["core/LOAN.CBL"],
      citations: [
        expect.objectContaining({
          id: "rule-interest",
          program: "LOAN-CALC",
          sourceId: "core/LOAN.CBL",
        }),
      ],
    });
    expect(body.unansweredReason).toBeUndefined();
    expect(body.answer).toContain("Calculate monthly interest");
    expect(body.confidence).toBeGreaterThan(0);
  });

  it("refuses chat answers when no grounded evidence is available", async () => {
    const graphSearchProvider = {
      search: vi.fn(async () => []),
    };
    const groundedAnswerGenerator = {
      generate: vi.fn(async () => ({ answer: "should not be called", provider: "deterministic" as const })),
    };
    const url = await start(createApiApp({ graphSearchProvider, groundedAnswerGenerator }));

    const res = await fetch(`${url}/api/v1/chat/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "What is the premium holiday policy?" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      citations: [],
      confidence: 0,
      sourceIds: [],
      unansweredReason: "NO_GROUNDED_EVIDENCE",
    });
    expect(body.answer).toContain("I do not have grounded source evidence");
    expect(groundedAnswerGenerator.generate).not.toHaveBeenCalled();
  });

  it("filters graph search and grounded chat by tenant", async () => {
    const graphSearchProvider = {
      search: vi.fn(async () => [
        {
          id: "tenant-a-rule",
          program: "A-PROG",
          type: "BUSINESS_RULE",
          description: "Tenant A interest rule",
          metadata: { tenantId: "tenant-a", sourceId: "a/LOAN.CBL" },
        },
        {
          id: "tenant-b-rule",
          program: "B-PROG",
          type: "BUSINESS_RULE",
          description: "Tenant B interest rule",
          metadata: { tenantId: "tenant-b", sourceId: "b/LOAN.CBL" },
        },
      ]),
    };
    const groundedAnswerGenerator = {
      generate: vi.fn(async ({ results }) => ({
        answer: results[0].description,
        provider: "deterministic" as const,
      })),
    };
    const url = await start(createApiApp({ graphSearchProvider, groundedAnswerGenerator }));

    const search = await fetch(`${url}/api/v1/graph/search?query=interest`, {
      headers: { "X-AgentMailbox-Tenant": "tenant-a" },
    });
    expect(search.status).toBe(200);
    const searchBody = await search.json();
    expect(searchBody.results).toHaveLength(1);
    expect(searchBody.results[0].id).toBe("tenant-a-rule");

    const chat = await fetch(`${url}/api/v1/chat/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentMailbox-Tenant": "tenant-b" },
      body: JSON.stringify({ query: "interest" }),
    });
    expect(chat.status).toBe(200);
    const chatBody = await chat.json();
    expect(chatBody.citations).toHaveLength(1);
    expect(chatBody.citations[0].id).toBe("tenant-b-rule");
    expect(chatBody.answer).toContain("Tenant B interest rule");
    expect(groundedAnswerGenerator.generate).toHaveBeenCalledWith(expect.objectContaining({
      results: [expect.objectContaining({ id: "tenant-b-rule" })],
      citations: [expect.objectContaining({ id: "tenant-b-rule" })],
    }));
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

  it("describes configured repository connectors", async () => {
    const url = await start(createApiApp());
    const response = await fetch(`${url}/api/v1/connectors`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connectors: expect.arrayContaining([
        expect.objectContaining({ id: "browser-folder", status: "live" }),
        expect.objectContaining({ id: "zip", status: "live" }),
        expect.objectContaining({ id: "git", endpoint: "/api/v1/connectors/git" }),
        expect.objectContaining({ id: "sftp", endpoint: "/api/v1/connectors/sftp" }),
        expect.objectContaining({ id: "document", endpoint: "/api/v1/enrichment/inputs", status: "beta" }),
        expect.objectContaining({ id: "expert-interview", endpoint: "/api/v1/enrichment/inputs", status: "beta" }),
        expect.objectContaining({ id: "scheduler-history", endpoint: "/api/v1/enrichment/inputs", status: "beta" }),
        expect.objectContaining({ id: "telemetry", endpoint: "/api/v1/enrichment/inputs", status: "beta" }),
      ]),
      limits: expect.objectContaining({ maxFiles: 500, maxKnowledgeInputs: 200 }),
    });
  });

  it("collects source artifacts from directories without indexing generated folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmailbox-connectors-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, ".git"), { recursive: true });
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, "src", "CLAIMS.CBL"), "IDENTIFICATION DIVISION. PROGRAM-ID. CLAIMS.");
      await writeFile(join(root, "src", "README.md"), "# generated docs");
      await writeFile(join(root, ".git", "config"), "ignored");
      await writeFile(join(root, "node_modules", "pkg", "FAKE.CBL"), "ignored");

      expect(isImportableSourcePath("src/CLAIMS.CBL")).toBe(true);
      expect(isImportableSourcePath("node_modules/pkg/FAKE.CBL")).toBe(false);
      expect(isImportableSourcePath("src/README.md")).toBe(false);

      const artifacts = await collectSourceArtifactsFromDirectory(root, {
        dataset: "claims",
        tenantId: "tenant-a",
        connectorRunId: "folder-001",
      });
      expect(artifacts).toMatchObject({
        dataset: "claims",
        connectorRunId: "folder-001",
        files: [
          expect.objectContaining({
            sourceId: "claims/src/CLAIMS.CBL",
            filename: "src/CLAIMS.CBL",
            tenantId: "tenant-a",
            language: "auto",
          }),
        ],
      });
      expect(artifacts.files).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures external knowledge inputs with provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmailbox-enrichment-"));
    try {
      const enrichmentService = new KnowledgeEnrichmentService({
        storage: new LocalStorageAdapter(root),
      });
      const url = await start(createApiApp({ enrichmentService }));
      const response = await fetch(`${url}/api/v1/enrichment/inputs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AgentMailbox-Tenant": "tenant-a" },
        body: JSON.stringify({
          dataset: "claims",
          connectorRunId: "expert-001",
          connector: "expert-interview",
          inputs: [
            {
              inputId: "claims/interviews/retired-sme",
              title: "Retired SME claims interview",
              kind: "expert_interview",
              subject: "Claims adjudication timing",
              content: "The night batch intentionally delays disputed claims until supervisor review is complete.",
              relatedSourceIds: ["claims/ADJUDICATE.CBL"],
              provenance: {
                sourceSystem: "SME interview",
                capturedBy: "analyst@example.com",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ingested: 1,
        records: [
          expect.objectContaining({
            inputId: "claims/interviews/retired-sme",
            kind: "expert_interview",
            tenantId: "tenant-a",
            connector: "expert-interview",
            provenance: expect.objectContaining({ sourceSystem: "SME interview" }),
          }),
        ],
      });

      const inventory = await fetch(`${url}/api/v1/enrichment/inventory`, {
        headers: { "X-AgentMailbox-Tenant": "tenant-a" },
      });
      expect(inventory.status).toBe(200);
      expect(await inventory.json()).toMatchObject({
        totalInputs: 1,
        byKind: expect.objectContaining({ expert_interview: 1 }),
        records: [
          expect.objectContaining({
            title: "Retired SME claims interview",
            contentPreview: expect.stringContaining("night batch"),
          }),
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
          {
            sourceId: "core/LOAN-REPORT.CBL",
            filename: "LOAN-REPORT.CBL",
            code: "IDENTIFICATION DIVISION. PROGRAM-ID. LOANRPT.",
            language: "cobol",
            version: "abc124",
          },
        ],
      };

      const first = await fetch(`${url}/api/v1/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ indexed: 2, skipped: 0, failed: 0 });

      const second = await fetch(`${url}/api/v1/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, connector: "browser-folder" }),
      });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ indexed: 0, skipped: 2, failed: 0 });

      const connectorRuns = await fetch(`${url}/api/v1/connectors/runs`);
      expect(connectorRuns.status).toBe(200);
      expect(await connectorRuns.json()).toMatchObject({
        runs: [
          expect.objectContaining({
            connectorRunId: "run-001",
            connector: "browser-folder",
            dataset: "core-banking",
            status: "completed",
            totalFiles: 2,
            indexed: 0,
            skipped: 2,
            failed: 0,
          }),
        ],
      });

      const inventory = await fetch(`${url}/api/v1/ingest/inventory`);
      expect(inventory.status).toBe(200);
      expect(await inventory.json()).toMatchObject({
        datasets: ["core-banking"],
        totalFiles: 2,
        files: expect.arrayContaining([
          expect.objectContaining({
            sourceId: "core/LOAN.CBL",
            filename: "LOAN.CBL",
            status: "skipped",
            dataset: "core-banking",
            program: "LOAN-CBL",
            language: "cobol",
          }),
        ]),
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

      const impact = await fetch(`${url}/api/v1/impact/analyze?sourceId=${encodeURIComponent("core/LOAN.CBL")}&ruleId=rule-interest`);
      expect(impact.status).toBe(200);
      expect(await impact.json()).toMatchObject({
        target: "rule-interest",
        affectedDatasets: ["core-banking"],
        affectedSources: expect.arrayContaining([
          expect.objectContaining({
            sourceId: "core/LOAN.CBL",
            relationship: "selected_source",
          }),
        ]),
        affectedRules: expect.arrayContaining([
          expect.objectContaining({
            id: "rule-interest",
            sourceId: "core/LOAN.CBL",
          }),
        ]),
      });

      const evidence = await fetch(`${url}/api/v1/evidence/export?sourceId=${encodeURIComponent("core/LOAN.CBL")}&ruleId=rule-interest`);
      expect(evidence.status).toBe(200);
      expect(evidence.headers.get("content-disposition")).toContain("attachment");
      const bundle = await evidence.json();
      expect(bundle).toMatchObject({
        metadata: {
          format: "json",
          request: {
            sourceId: "core/LOAN.CBL",
            ruleId: "rule-interest",
          },
        },
        source: {
          sourceId: "core/LOAN.CBL",
          program: "LOAN-CBL",
        },
        impact: {
          target: "rule-interest",
        },
        audit: {
          chainOfCustody: expect.arrayContaining(["source details document"]),
        },
      });
      expect(bundle.metadata.contentHash).toMatch(/^[a-f0-9]{64}$/);
      const audit = JSON.parse(await readFile(join(root, "ingestion/evidence/audit.json"), "utf8"));
      expect(audit[0]).toMatchObject({
        exportId: bundle.metadata.exportId,
        sourceId: "core/LOAN.CBL",
        ruleId: "rule-interest",
        contentHash: bundle.metadata.contentHash,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records failed Git connector attempts in run history", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmailbox-git-failure-"));
    try {
      const ingestionService = new IngestionService({
        manifestStorage: new LocalStorageAdapter(root),
        processor: {
          async process() {
            throw new Error("should not process files when clone is rejected");
          },
        },
      });
      const url = await start(createApiApp({ ingestionService }));
      const response = await fetch(`${url}/api/v1/connectors/git`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AgentMailbox-Tenant": "tenant-a" },
        body: JSON.stringify({
          dataset: "core-banking",
          connectorRunId: "git-failure-001",
          repoUrl: "ftp://user:secret@example.invalid/repo.git",
        }),
      });
      expect(response.status).toBe(500);

      const runs = await fetch(`${url}/api/v1/connectors/runs`, {
        headers: { "X-AgentMailbox-Tenant": "tenant-a" },
      });
      expect(await runs.json()).toMatchObject({
        runs: [
          expect.objectContaining({
            connectorRunId: "git-failure-001",
            connector: "git",
            status: "failed",
            dataset: "core-banking",
            tenantId: "tenant-a",
            error: "Unsupported Git repository URL. Use HTTPS, SSH, or a configured test file URL.",
          }),
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scopes ingestion inventory, details, impact, and evidence by tenant", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmailbox-tenant-"));
    try {
      const ingestionService = new IngestionService({
        manifestStorage: new LocalStorageAdapter(root),
        processor: {
          async process(file) {
            return {
              program: file.filename.replace(/\W+/g, "-").toUpperCase(),
              rulesExtracted: 1,
              businessRules: [
                {
                  id: `rule-${file.filename}`,
                  type: "BUSINESS_RULE",
                  description: `Rule for ${file.filename}`,
                },
              ],
            };
          },
        },
      });
      const url = await start(createApiApp({ ingestionService }));
      const payload = (filename: string) => ({
        dataset: "core",
        files: [{ sourceId: "shared/LOAN.CBL", filename, code: `IDENTIFICATION DIVISION. PROGRAM-ID. ${filename}.`, language: "cobol" }],
      });

      await fetch(`${url}/api/v1/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AgentMailbox-Tenant": "tenant-a" },
        body: JSON.stringify(payload("A-LOAN.CBL")),
      });
      await fetch(`${url}/api/v1/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AgentMailbox-Tenant": "tenant-b" },
        body: JSON.stringify(payload("B-LOAN.CBL")),
      });

      const inventoryA = await fetch(`${url}/api/v1/ingest/inventory`, {
        headers: { "X-AgentMailbox-Tenant": "tenant-a" },
      });
      expect(await inventoryA.json()).toMatchObject({
        totalFiles: 1,
        files: [expect.objectContaining({ filename: "A-LOAN.CBL", tenantId: "tenant-a" })],
      });

      const detailsA = await fetch(`${url}/api/v1/ingest/sources/${encodeURIComponent("shared/LOAN.CBL")}`, {
        headers: { "X-AgentMailbox-Tenant": "tenant-a" },
      });
      expect(detailsA.status).toBe(200);
      expect(await detailsA.json()).toMatchObject({ filename: "A-LOAN.CBL", tenantId: "tenant-a" });

      const impactB = await fetch(`${url}/api/v1/impact/analyze?sourceId=${encodeURIComponent("shared/LOAN.CBL")}`, {
        headers: { "X-AgentMailbox-Tenant": "tenant-b" },
      });
      expect(await impactB.json()).toMatchObject({
        affectedSources: [expect.objectContaining({ filename: "B-LOAN.CBL" })],
      });

      const evidenceA = await fetch(`${url}/api/v1/evidence/export?sourceId=${encodeURIComponent("shared/LOAN.CBL")}`, {
        headers: { "X-AgentMailbox-Tenant": "tenant-a" },
      });
      expect(evidenceA.status).toBe(200);
      const bundle = await evidenceA.json();
      expect(bundle.metadata.request.tenantId).toBe("tenant-a");
      expect(bundle.source.filename).toBe("A-LOAN.CBL");
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
    expect(body.capabilities.some((item) => item.status === "live" || item.status === "beta")).toBe(true);
    expect(body.capabilities.find((item) => item.id === "mainframe-parser-registry")).toMatchObject({
      status: "live",
    });
    expect(body.capabilities.find((item) => item.id === "impact-analysis")).toMatchObject({
      status: "beta",
      evidence: expect.arrayContaining(["src/impact/analysis.ts", "ui/src/App.tsx"]),
    });
    expect(body.capabilities.find((item) => item.id === "audit-compliance-exports")).toMatchObject({
      status: "beta",
      evidence: expect.arrayContaining(["src/evidence/export.ts", "tests/api-server.test.ts"]),
    });
    expect(body.capabilities.find((item) => item.id === "expert-telemetry-enrichment")).toMatchObject({
      status: "beta",
      evidence: expect.arrayContaining(["src/ingestion/enrichment-service.ts", "ui/src/App.tsx"]),
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

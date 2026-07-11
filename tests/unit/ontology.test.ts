/**
 * Unit tests for OntologyGenerator — entity discovery, relationships, domain clustering.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OntologyGenerator } from "../../src/ontology";

describe("OntologyGenerator", () => {
  let gen: OntologyGenerator;

  beforeEach(() => {
    gen = new OntologyGenerator();
  });

  it("starts empty", () => {
    const stats = gen.getStats();
    expect(stats.entities).toBe(0);
    expect(stats.relationships).toBe(0);
    expect(stats.programs).toBe(0);
    expect(stats.version).toBe(0);
  });

  it("ingests a parsed COBOL result", () => {
    gen.ingest({
      programId: "LOAN-PROC",
      semanticNodes: [
        { id: "CALC-INT", type: "COMPUTE", description: "Calculate interest", domain: "Risk" },
        { id: "CHECK-BAL", type: "IF", description: "Check balance", domain: "Risk" },
      ],
    });

    const stats = gen.getStats();
    expect(stats.entities).toBeGreaterThan(0);
    expect(stats.programs).toBe(1);
    expect(stats.version).toBe(1);
  });

  it("creates PROGRAM entity", () => {
    gen.ingest({
      programId: "LOAN-PROC",
      semanticNodes: [
        { id: "CALC", type: "COMPUTE", description: "Calculate", domain: "Risk" },
      ],
    });

    const entity = gen.getEntity("prog::LOAN-PROC");
    expect(entity).toBeDefined();
    expect(entity!.type).toBe("PROGRAM");
    expect(entity!.programs.has("LOAN-PROC")).toBe(true);
  });

  it("creates RULE entities for semantic nodes", () => {
    gen.ingest({
      programId: "PAY",
      semanticNodes: [
        { id: "FEE-CALC", type: "COMPUTE", description: "Calculate fee" },
      ],
    });

    const entity = gen.getEntity("rule::PAY::FEE-CALC");
    expect(entity).toBeDefined();
    expect(entity!.type).toBe("RULE");
    expect(entity!.name).toBe("FEE-CALC");
  });

  it("creates BELONGS_TO relationships", () => {
    gen.ingest({
      programId: "X",
      semanticNodes: [
        { id: "A", type: "T", description: "d" },
      ],
    });

    const ontology = gen.getOntology();
    const belongsTo = ontology.relationships.filter(r => r.type === "BELONGS_TO");
    expect(belongsTo.length).toBeGreaterThan(0);
    expect(belongsTo[0].target).toBe("prog::X");
  });

  it("creates COPYBOOK entities and COPIES relationships", () => {
    gen.ingest({
      programId: "MAIN",
      semanticNodes: [{ id: "A", type: "T", description: "d" }],
      copybooks: ["COMMON-DEFS", "FEE-TABLE"],
    });

    const copy1 = gen.getEntity("copy::COMMON-DEFS");
    expect(copy1).toBeDefined();
    expect(copy1!.type).toBe("COPYBOOK");

    const ontology = gen.getOntology();
    const copies = ontology.relationships.filter(r => r.type === "COPIES");
    expect(copies).toHaveLength(2);
  });

  it("creates DATA_ITEM entities", () => {
    gen.ingest({
      programId: "P",
      semanticNodes: [{ id: "A", type: "T", description: "d" }],
      dataItems: [
        { name: "WS-BALANCE", type: "PIC 9(9)V99", usage: "COMP-3" },
      ],
    });

    const item = gen.getEntity("data::P::WS-BALANCE");
    expect(item).toBeDefined();
    expect(item!.type).toBe("DATA_ITEM");
    expect(item!.properties.usage).toBe("COMP-3");
  });

  it("creates control flow relationships", () => {
    gen.ingest({
      programId: "P",
      semanticNodes: [
        { id: "A", type: "T", description: "d" },
        { id: "B", type: "T", description: "d" },
      ],
      controlFlow: [
        { from: "A", to: "B", type: "CALL" },
      ],
    });

    const ontology = gen.getOntology();
    const calls = ontology.relationships.filter(r => r.type === "CALLS");
    expect(calls).toHaveLength(1);
  });

  it("increments relationship weight on repeated ingestion", () => {
    const input = {
      programId: "P",
      semanticNodes: [
        { id: "A", type: "T", description: "d" },
        { id: "B", type: "T", description: "d" },
      ],
      controlFlow: [{ from: "A", to: "B", type: "CALL" }],
    };

    gen.ingest(input);
    gen.ingest(input);

    const ontology = gen.getOntology();
    const calls = ontology.relationships.filter(r => r.type === "CALLS");
    expect(calls[0].weight).toBe(2);
  });

  // ── Domain Clustering ───────────────────────────

  it("auto-clusters domains from node domains", () => {
    gen.ingest({
      programId: "P",
      semanticNodes: [
        { id: "A", type: "T", description: "Check balance", domain: "Risk" },
        { id: "B", type: "T", description: "Verify limit", domain: "Risk" },
        { id: "C", type: "T", description: "Process payment", domain: "Payments" },
        { id: "D", type: "T", description: "Send payment", domain: "Payments" },
      ],
    });

    const domains = gen.getDomains();
    expect(domains.length).toBeGreaterThanOrEqual(2);

    const names = domains.map(d => d.name);
    expect(names).toContain("Risk");
    expect(names).toContain("Payments");
  });

  // ── Cross-program Dependencies ──────────────────

  it("detects cross-program dependencies via shared copybooks", () => {
    gen.ingest({
      programId: "PROG-A",
      semanticNodes: [{ id: "X", type: "T", description: "d" }],
      copybooks: ["SHARED-DEFS"],
    });

    gen.ingest({
      programId: "PROG-B",
      semanticNodes: [{ id: "Y", type: "T", description: "d" }],
      copybooks: ["SHARED-DEFS"],
    });

    const deps = gen.getCrossProgramDeps();
    expect(deps.length).toBeGreaterThan(0);
    expect(deps[0].sharedEntities).toContain("copy::SHARED-DEFS");
  });

  // ── Version Tracking ────────────────────────────

  it("increments version on each ingest", () => {
    gen.ingest({ programId: "A", semanticNodes: [{ id: "X", type: "T", description: "d" }] });
    gen.ingest({ programId: "B", semanticNodes: [{ id: "Y", type: "T", description: "d" }] });
    expect(gen.getStats().version).toBe(2);
  });
});

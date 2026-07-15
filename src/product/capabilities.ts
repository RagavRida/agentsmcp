export type CapabilityStatus = "live" | "beta" | "prototype" | "roadmap";

export interface ProductCapability {
  id: string;
  title: string;
  status: CapabilityStatus;
  category: "ingestion" | "knowledge" | "analysis" | "ai" | "operations" | "governance";
  summary: string;
  evidence: string[];
  nextMilestone?: string;
}

export interface ProductCapabilityMatrix {
  generatedAt: string;
  statuses: Record<CapabilityStatus, string>;
  capabilities: ProductCapability[];
}

const CAPABILITIES: ProductCapability[] = [
  {
    id: "mainframe-parser-registry",
    title: "Mainframe language parsing",
    status: "live",
    category: "ingestion",
    summary: "Parses COBOL, JCL, PL/I, REXX, embedded SQL, CICS, and copybooks into structured program artifacts.",
    evidence: ["parser/src/registry.ts", "tests/unit/mainframe-parsers.test.ts"],
  },
  {
    id: "business-rule-extraction",
    title: "Business rule extraction",
    status: "live",
    category: "knowledge",
    summary: "Extracts deterministic business rules and semantic nodes from parsed legacy code, with LLM fallback support for unknown fragments.",
    evidence: ["src/parser/llm-fallback.ts", "src/memory/api.ts", "tests/llm-fallback.test.ts"],
  },
  {
    id: "knowledge-graph-memory",
    title: "Knowledge graph and memory layer",
    status: "beta",
    category: "knowledge",
    summary: "Stores program knowledge across graph, vector, RAPTOR-style tree, and mailbox context surfaces.",
    evidence: ["src/graph/neo4j-sync.ts", "src/vector/store.ts", "src/raptor/tree-store.ts"],
    nextMilestone: "Persist graph and vector indexes through the production ingestion workflow by default.",
  },
  {
    id: "repository-ingestion",
    title: "Mainframe repository ingestion",
    status: "beta",
    category: "ingestion",
    summary: "Accepts versioned source batches through the ingestion API and records ingestion manifests.",
    evidence: ["src/ingestion/service.ts", "src/api/server.ts", "tests/integration/memory.test.ts"],
    nextMilestone: "Add first-class ZIP, mounted folder, Git, and SFTP connector flows in the UI.",
  },
  {
    id: "impact-analysis",
    title: "Impact analysis",
    status: "prototype",
    category: "analysis",
    summary: "Dependency graph primitives exist, but the end-to-end change-impact workflow is not product complete yet.",
    evidence: ["src/graph/neo4j-sync.ts", "src/flare/active-rag.ts", "ui/src/App.tsx"],
    nextMilestone: "Build a dedicated impact-analysis screen with upstream/downstream evidence and affected job summaries.",
  },
  {
    id: "ai-chat-grounding",
    title: "Grounded AI chat",
    status: "prototype",
    category: "ai",
    summary: "The UI supports knowledge chat and graph search, but answer citation and refusal policies need full product enforcement.",
    evidence: ["ui/src/App.tsx", "src/eval/grounding.ts", "src/model/provider.ts"],
    nextMilestone: "Require source evidence on every generated answer and expose no-grounding states in the UI.",
  },
  {
    id: "agent-context-handoff",
    title: "Focused agent context handoff",
    status: "live",
    category: "ai",
    summary: "Builds compact task-specific handoff packets so one agent receives only the context needed for the next task.",
    evidence: ["src/handoff/context-builder.ts", "tests/handoff.test.ts"],
  },
  {
    id: "production-onprem-stack",
    title: "On-prem production stack",
    status: "beta",
    category: "operations",
    summary: "Runs with PostgreSQL, Neo4j, MinIO, HTTPS proxy, local Colima support, and Modal/on-prem model endpoints.",
    evidence: ["infra/colima/docker-compose.colima.yml", "infra/docker/docker-compose.onprem.yml", "infra/modal/modal_vllm.py"],
    nextMilestone: "Add production Modal endpoint authentication and remove remaining dependency audit findings.",
  },
  {
    id: "audit-compliance-exports",
    title: "Audit and compliance exports",
    status: "roadmap",
    category: "governance",
    summary: "Audit storage and backup foundations exist, but DORA-ready evidence bundles and compliance exports are not complete.",
    evidence: ["src/cloud/audit.ts", "infra/backup-postgres.sh", "infra/test-postgres-restore.sh"],
    nextMilestone: "Generate rule catalogs, impact reports, and evidence bundles from source-linked graph data.",
  },
  {
    id: "expert-telemetry-enrichment",
    title: "Expert interviews and telemetry enrichment",
    status: "roadmap",
    category: "knowledge",
    summary: "The platform does not yet ingest expert interview notes, runtime telemetry, scheduler history, or external documentation as first-class knowledge inputs.",
    evidence: ["src/ingestion/contracts.ts"],
    nextMilestone: "Add document, interview, scheduler, and telemetry connectors with provenance.",
  },
];

export function getProductCapabilityMatrix(now = new Date()): ProductCapabilityMatrix {
  return {
    generatedAt: now.toISOString(),
    statuses: {
      live: "Available in the product today and covered by tests or deployed paths.",
      beta: "Implemented foundation exists, but enterprise hardening or workflow polish remains.",
      prototype: "Demonstrable capability exists, but it is not yet an end-to-end production workflow.",
      roadmap: "Planned capability; do not market as shipped.",
    },
    capabilities: CAPABILITIES,
  };
}

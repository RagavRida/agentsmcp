import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import {
  Activity, ArrowUp, Bot, ChevronDown, ChevronRight, CircleHelp, Database,
  FileCode2, FileInput, Files, GitBranch, LayoutGrid, Maximize2, Menu,
  Minus, MoreHorizontal, Network, Plus, Search, Settings2, Sparkles, X, ZoomIn,
} from "lucide-react";

type View = "chat" | "programs" | "dataflow" | "relationships" | "explanation" | "knowledge" | "connectors" | "model" | "settings";
type GraphMode = "Graph" | "Flow" | "Files";
type Node = { id: string; x: number; y: number; label: string; type: string; description: string; program: string };
type Citation = { id: string; label: string; program?: string; type: string; domain?: string; sourceId?: string; score?: number };
type Message = { role: "assistant" | "user"; text: string; detail?: string; source?: string; citations?: Citation[] };
type CapabilityStatus = "live" | "beta" | "prototype" | "roadmap";
type ProductCapability = {
  id: string;
  title: string;
  status: CapabilityStatus;
  category: string;
  summary: string;
  evidence: string[];
  nextMilestone?: string;
};
type ProductCapabilityMatrix = {
  generatedAt: string;
  statuses: Record<CapabilityStatus, string>;
  capabilities: ProductCapability[];
};
type IngestionInventory = {
  datasets: string[];
  totalFiles: number;
  indexed: number;
  skipped: number;
  failed: number;
  files: Array<{ sourceId: string; filename: string; status: "indexed" | "skipped" | "failed"; tenantId?: string; dataset?: string; connector?: string; language?: string; program?: string; error?: string; lastSeenAt?: string }>;
};
type IngestionSourceDetails = IngestionInventory["files"][number] & {
  rulesExtracted?: number;
  businessRules: Array<{ id: string; type: string; domain?: string; description: string }>;
};
type ImpactAnalysisResult = {
  target: string;
  riskLevel: "low" | "medium" | "high";
  affectedSources: Array<{ sourceId: string; filename: string; program?: string; dataset: string; relationship: string; score: number; evidence: string[] }>;
  affectedRules: Array<{ id: string; sourceId: string; program?: string; domain?: string; description: string; score: number; evidence: string[] }>;
  affectedDatasets: string[];
  affectedPrograms: string[];
  totalAffected: number;
  evidence: string[];
};
type EvidenceBundle = {
  metadata: {
    exportId: string;
    generatedAt: string;
    format: "json";
    contentHash: string;
    request: { sourceId?: string; ruleId?: string; target?: string };
  };
  impact: ImpactAnalysisResult;
};
type UploadFile = File & { webkitRelativePath?: string };
type ConnectorResponse = { connector?: string; indexed: number; skipped: number; failed: number; files?: unknown[] };
type ModelHealth = {
  provider: string;
  model: string;
  status: "ok" | "error" | "not_configured";
  latencyMs?: number;
  error?: string;
  baseUrl?: string;
  openaiCompatible?: boolean;
};

const API_BASE = (window as Window & { AGENTMAILBOX_API?: string }).AGENTMAILBOX_API ?? "";
const MAX_IMPORT_FILES = 500;
const IGNORED_REPO_SEGMENTS = new Set([".git", "node_modules", "dist", "build", "target", ".next", ".cache", "coverage"]);
const SOURCE_EXTENSIONS = new Set([
  ".cbl", ".cob", ".cobol", ".cpy", ".copy", ".jcl", ".job", ".pli", ".pl1", ".rexx", ".rex", ".sql", ".txt",
]);
const nodes: Node[] = [
  { id: "WS-PGMNAME", x: 410, y: 115, label: "WS-PGMNAME", type: "Variable", description: "Program identifier referenced by the claims processing workflow.", program: "READCUST" },
  { id: "LOCKUP-ACCT", x: 245, y: 230, label: "Lookup ACCT", type: "Data access", description: "Account lookup used by customer validation.", program: "READCUST" },
  { id: "STEP-05R", x: 420, y: 305, label: "Step-05R", type: "Job step", description: "Reads customer data before the downstream claim decision.", program: "READCUST" },
  { id: "XREFFILE-STATUS", x: 625, y: 250, label: "XREFFILE-STATUS", type: "Dataset", description: "Cross-reference status written by the validation step.", program: "READCUST" },
  { id: "TIMING", x: 535, y: 445, label: "TIMING", type: "Control flow", description: "Timing branch used for the current job execution.", program: "READCUST" },
  { id: "CVTRA-12", x: 590, y: 105, label: "CVTRA-12", type: "Copybook", description: "Shared transaction definitions from the copybook estate.", program: "READCUST" },
  { id: "001-FILES", x: 270, y: 455, label: "001-files", type: "File", description: "Input file collection attached to the job.", program: "READCUST" },
  { id: "LK-M03B", x: 665, y: 155, label: "LK-M03B", type: "Paragraph", description: "Downstream paragraph invoked by the workflow.", program: "READCUST" },
];
const edges = [["WS-PGMNAME", "CVTRA-12"], ["WS-PGMNAME", "STEP-05R"], ["CVTRA-12", "LK-M03B"], ["LK-M03B", "XREFFILE-STATUS"], ["STEP-05R", "LOCKUP-ACCT"], ["STEP-05R", "XREFFILE-STATUS"], ["STEP-05R", "TIMING"], ["LOCKUP-ACCT", "001-FILES"], ["XREFFILE-STATUS", "TIMING"]];

const initialMessages: Message[] = [
  { role: "assistant", text: "The copybook CV CUS01Y is used in the job READCUST, specifically within STEP05.", detail: "This step executes CBUSC01C, which handles customer data and reads the customer dataset." },
  { role: "user", text: "How is interest calculated?" },
  { role: "assistant", text: "(Balance × Interest Rate) ÷ 1200", detail: "Interest uses the account balance and annual rate. The division by 1200 converts the yearly percentage into a monthly amount.", source: "COMPUTE-INTEREST · LOAN-CALC.cbl: 84" },
];
const fallbackCapabilityMatrix: ProductCapabilityMatrix = {
  generatedAt: new Date(0).toISOString(),
  statuses: {
    live: "Available in the product today and covered by tests or deployed paths.",
    beta: "Implemented foundation exists, but enterprise hardening or workflow polish remains.",
    prototype: "Demonstrable capability exists, but it is not yet an end-to-end production workflow.",
    roadmap: "Planned capability; do not market as shipped.",
  },
  capabilities: [
    { id: "mainframe-parser-registry", title: "Mainframe language parsing", status: "live", category: "ingestion", summary: "Parses COBOL, JCL, PL/I, REXX, embedded SQL, CICS, and copybooks into structured program artifacts.", evidence: ["parser/src/registry.ts", "tests/unit/mainframe-parsers.test.ts"] },
    { id: "business-rule-extraction", title: "Business rule extraction", status: "live", category: "knowledge", summary: "Extracts deterministic business rules and semantic nodes from parsed legacy code, with LLM fallback support for unknown fragments.", evidence: ["src/parser/llm-fallback.ts", "src/memory/api.ts", "tests/llm-fallback.test.ts"] },
    { id: "knowledge-graph-memory", title: "Knowledge graph and memory layer", status: "beta", category: "knowledge", summary: "Stores program knowledge across graph, vector, RAPTOR-style tree, and mailbox context surfaces.", evidence: ["src/graph/neo4j-sync.ts", "src/vector/store.ts", "src/raptor/tree-store.ts"], nextMilestone: "Persist graph and vector indexes through the production ingestion workflow by default." },
    { id: "repository-ingestion", title: "Mainframe repository ingestion", status: "beta", category: "ingestion", summary: "Accepts versioned source batches through the ingestion API, records ingestion manifests, and supports browser folder import for repository source trees.", evidence: ["src/ingestion/service.ts", "src/api/server.ts", "ui/src/App.tsx", "tests/integration/memory.test.ts"], nextMilestone: "Add first-class Git URL, ZIP archive, mounted folder, and SFTP connector flows." },
    { id: "impact-analysis", title: "Impact analysis", status: "beta", category: "analysis", summary: "Users can run source and rule-level impact analysis from the repository inventory, with affected files, rules, programs, datasets, and evidence terms.", evidence: ["src/impact/analysis.ts", "src/api/server.ts", "ui/src/App.tsx"], nextMilestone: "Enrich impact results with Neo4j dependency chains and scheduler/runtime telemetry." },
    { id: "ai-chat-grounding", title: "Grounded AI chat", status: "beta", category: "ai", summary: "Chat answers use tenant-scoped evidence, constrained model generation when configured, citation validation, deterministic fallback, and no-grounding refusal.", evidence: ["src/api/grounded-answer.ts", "src/api/server.ts", "ui/src/App.tsx", "tests/grounded-answer.test.ts", "tests/api-server.test.ts"], nextMilestone: "Add tenant-scoped prompt audit records and per-answer model usage telemetry." },
    { id: "agent-context-handoff", title: "Focused agent context handoff", status: "live", category: "ai", summary: "Builds compact task-specific handoff packets so one agent receives only the context needed for the next task.", evidence: ["src/handoff/context-builder.ts", "tests/handoff.test.ts"] },
    { id: "production-onprem-stack", title: "On-prem production stack", status: "beta", category: "operations", summary: "Runs with PostgreSQL, Neo4j, MinIO, HTTPS proxy, local Colima support, and Modal/on-prem model endpoints.", evidence: ["infra/colima/docker-compose.colima.yml", "infra/docker/docker-compose.onprem.yml", "infra/modal/modal_vllm.py"], nextMilestone: "Add production Modal endpoint authentication and remove remaining dependency audit findings." },
    { id: "audit-compliance-exports", title: "Audit and compliance exports", status: "beta", category: "governance", summary: "Exports source-linked JSON evidence bundles with inventory metadata, extracted rules, impact analysis, capability status, hashes, and persisted audit records.", evidence: ["src/evidence/export.ts", "src/ingestion/service.ts", "tests/api-server.test.ts"], nextMilestone: "Add signed PDF/Markdown evidence packs and tenant-scoped audit history search." },
    { id: "expert-telemetry-enrichment", title: "Expert interviews and telemetry enrichment", status: "roadmap", category: "knowledge", summary: "The platform does not yet ingest expert interview notes, runtime telemetry, scheduler history, or external documentation as first-class knowledge inputs.", evidence: ["src/ingestion/contracts.ts"], nextMilestone: "Add document, interview, scheduler, and telemetry connectors with provenance." },
  ],
};

function App() {
  const [view, setView] = useState<View>("chat");
  const [graphMode, setGraphMode] = useState<GraphMode>("Graph");
  const [selectedId, setSelectedId] = useState("WS-PGMNAME");
  const [scale, setScale] = useState(1);
  const [messages, setMessages] = useState(initialMessages);
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [capabilityMatrix, setCapabilityMatrix] = useState<ProductCapabilityMatrix>(fallbackCapabilityMatrix);
  const [inventory, setInventory] = useState<IngestionInventory | null>(null);
  const [apiKey, setApiKey] = useState(() => window.localStorage.getItem("agentmailbox.apiKey") ?? "");
  const [tenantId, setTenantId] = useState(() => window.localStorage.getItem("agentmailbox.tenantId") ?? "");
  const [selectedFiles, setSelectedFiles] = useState<UploadFile[]>([]);
  const [sourceDetails, setSourceDetails] = useState<IngestionSourceDetails | null>(null);
  const [detailsStatus, setDetailsStatus] = useState("");
  const [impactResult, setImpactResult] = useState<ImpactAnalysisResult | null>(null);
  const [impactStatus, setImpactStatus] = useState("");
  const [evidenceBundle, setEvidenceBundle] = useState<EvidenceBundle | null>(null);
  const [evidenceStatus, setEvidenceStatus] = useState("");
  const [connectorDataset, setConnectorDataset] = useState("mainframe-repo");
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [sftpHost, setSftpHost] = useState("");
  const [sftpPort, setSftpPort] = useState("22");
  const [sftpUsername, setSftpUsername] = useState("");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpRemotePath, setSftpRemotePath] = useState("");
  const [connectorStatus, setConnectorStatus] = useState("");
  const [modelHealth, setModelHealth] = useState<ModelHealth | null>(null);
  const [modelStatus, setModelStatus] = useState("");
  const [metricsText, setMetricsText] = useState("");
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0];
  const connectedIds = useMemo(() => new Set([selectedId, ...edges.filter(([a, b]) => a === selectedId || b === selectedId).flat()]), [selectedId]);
  const capabilityCounts = useMemo(() => capabilityMatrix.capabilities.reduce<Record<CapabilityStatus, number>>((counts, capability) => {
    counts[capability.status] += 1;
    return counts;
  }, { live: 0, beta: 0, prototype: 0, roadmap: 0 }), [capabilityMatrix]);

  useEffect(() => {
    let active = true;
    void fetch(`${API_BASE}/api/v1/product/capabilities`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Capability API unavailable")))
      .then((payload: ProductCapabilityMatrix) => {
        if (active) setCapabilityMatrix(payload);
      })
      .catch(() => {
        if (active) setCapabilityMatrix(fallbackCapabilityMatrix);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    void refreshInventory();
  }, []);

  useEffect(() => {
    if (view === "model") void loadModelOps();
  }, [view]);

  async function refreshInventory() {
    try {
      const response = await fetch(`${API_BASE}/api/v1/ingest/inventory`, {
        headers: requestHeaders(),
      });
      if (!response.ok) return;
      setInventory(await response.json());
    } catch {
      // Inventory is optional until the ingestion service is configured.
    }
  }

  function submitSearch(event?: FormEvent) {
    event?.preventDefault();
    const cleanQuery = query.trim();
    if (!cleanQuery) return;
    setMessages((current) => [...current, { role: "user", text: cleanQuery }]);
    setQuery("");
    void search(cleanQuery);
  }

  async function search(cleanQuery: string) {
    try {
      const response = await fetch(`${API_BASE}/api/v1/chat/answer`, {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({ query: cleanQuery, limit: 6 }),
      });
      const payload = await response.json();
      if (response.ok) {
        const citation = payload.citations?.[0] as Citation | undefined;
        const match = citation ? nodes.find((node) => node.id === citation.id || node.program === citation.program) : undefined;
        if (match) setSelectedId(match.id);
        setMessages((current) => [...current, {
          role: "assistant",
          text: payload.answer,
          source: citation ? `${citation.program ?? citation.sourceId ?? citation.id} · ${citation.type}` : undefined,
          citations: payload.citations,
        }]);
        return;
      }
    } catch {
      // The demo graph remains useful when the API is unavailable during local setup.
    }
    const term = cleanQuery.toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length > 2);
    const match = nodes.find((node) => term.some((item) => `${node.label} ${node.description} ${node.type} ${node.program}`.toLowerCase().includes(item)));
    if (match) {
      setSelectedId(match.id);
      setMessages((current) => [...current, { role: "assistant", text: `Demo graph context: ${match.description}`, source: `${match.program} · ${match.type}` }]);
    } else {
      setMessages((current) => [...current, { role: "assistant", text: "No indexed rule matches that query yet. Import a program to build grounded knowledge for this workspace." }]);
    }
  }

  async function extract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const filename = String(form.get("filename") ?? "SOURCE.CBL").trim() || "SOURCE.CBL";
    const code = String(form.get("code") ?? "").trim();
    const dataset = String(form.get("dataset") ?? "local-upload").trim() || "local-upload";
    setImportStatus("Ingesting source batch...");
    try {
      if (apiKey) window.localStorage.setItem("agentmailbox.apiKey", apiKey);
      if (tenantId) window.localStorage.setItem("agentmailbox.tenantId", tenantId);
      const sourceFiles = selectedFiles.filter(shouldImportSourceFile).slice(0, MAX_IMPORT_FILES);
      const skippedFiles = selectedFiles.length - sourceFiles.length;
      const uploadedFiles = await Promise.all(sourceFiles.map(async (file) => {
        const sourcePath = file.webkitRelativePath || file.name;
        return {
          sourceId: `${dataset}/${sourcePath}`,
          filename: sourcePath,
          code: await file.text(),
          language: "auto",
        };
      }));
      const files = uploadedFiles.length > 0 ? uploadedFiles : [{ sourceId: `${dataset}/${filename}`, filename, code, language: "auto" }];
      if (files.length === 0 || files.every((file) => !file.code.trim())) {
        setImportStatus("Choose repository files or paste source before ingesting.");
        return;
      }
      const response = await fetch(`${API_BASE}/api/v1/ingest`, {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({
          dataset,
          connectorRunId: `ui-${Date.now()}`,
          files,
        }),
      });
      if (!response.ok) throw new Error("Ingestion failed");
      const result = await response.json();
      await refreshInventory();
      setSourceDetails(null);
      setImportStatus(`Indexed ${result.indexed}, skipped ${result.skipped + skippedFiles}, failed ${result.failed}.`);
    } catch {
      setImportStatus("The ingestion API is unavailable or unauthorized. Check the server and API key.");
    }
  }

  function selectImportFiles(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFiles(Array.from(event.currentTarget.files ?? []) as UploadFile[]);
    setImportStatus("");
  }

  async function openSourceDetails(sourceId: string) {
    setDetailsStatus("Loading source details...");
    try {
      const response = await fetch(`${API_BASE}/api/v1/ingest/sources/${encodeURIComponent(sourceId)}`, {
        headers: requestHeaders(),
      });
      if (!response.ok) throw new Error("Source details unavailable");
      setSourceDetails(await response.json());
      setImpactResult(null);
      setEvidenceBundle(null);
      setDetailsStatus("");
    } catch {
      setSourceDetails(null);
      setDetailsStatus("No extracted rule catalog is available for that source yet.");
    }
  }

  async function analyzeImpact(sourceId: string, ruleId?: string) {
    setImpactStatus("Analyzing downstream impact...");
    try {
      const params = new URLSearchParams({ sourceId, maxResults: "20" });
      if (ruleId) params.set("ruleId", ruleId);
      const response = await fetch(`${API_BASE}/api/v1/impact/analyze?${params.toString()}`, {
        headers: requestHeaders(),
      });
      if (!response.ok) throw new Error("Impact analysis failed");
      setImpactResult(await response.json());
      setEvidenceBundle(null);
      setImpactStatus("");
    } catch {
      setImpactResult(null);
      setImpactStatus("Impact analysis is unavailable for this deployment or API key.");
    }
  }

  async function exportEvidence(sourceId: string, ruleId?: string) {
    setEvidenceStatus("Creating evidence bundle...");
    try {
      const params = new URLSearchParams({ sourceId, maxResults: "20" });
      if (ruleId) params.set("ruleId", ruleId);
      const response = await fetch(`${API_BASE}/api/v1/evidence/export?${params.toString()}`, {
        headers: requestHeaders(),
      });
      if (!response.ok) throw new Error("Evidence export failed");
      const bundle = await response.json();
      setEvidenceBundle(bundle);
      setEvidenceStatus(`Evidence bundle ${bundle.metadata.exportId} is ready.`);
      downloadJson(bundle, `${bundle.metadata.exportId}.json`);
    } catch {
      setEvidenceBundle(null);
      setEvidenceStatus("Evidence export is unavailable for this deployment or API key.");
    }
  }

  async function ingestZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setConnectorStatus("Reading ZIP archive in the browser...");
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files)
        .filter((entry) => !entry.dir && shouldImportSourcePath(entry.name))
        .slice(0, MAX_IMPORT_FILES);
      const files = await Promise.all(entries.map(async (entry) => ({
        sourceId: `${connectorDataset}/${entry.name}`,
        filename: entry.name,
        code: await entry.async("string"),
        language: "auto",
      })));
      if (files.length === 0) {
        setConnectorStatus("No supported source files were found in that ZIP archive.");
        return;
      }
      await ingestConnectorFiles(files, `zip-${Date.now()}`);
    } catch {
      setConnectorStatus("ZIP import failed. Check that the archive is valid and under the configured API limit.");
    }
  }

  async function ingestConnectorFiles(files: Array<{ sourceId: string; filename: string; code: string; language: string }>, connectorRunId: string) {
    const response = await fetch(`${API_BASE}/api/v1/ingest`, {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({ dataset: connectorDataset, connectorRunId, files }),
    });
    if (!response.ok) throw new Error("Connector ingestion failed");
    const result = await response.json() as ConnectorResponse;
    await refreshInventory();
    setConnectorStatus(`Indexed ${result.indexed}, skipped ${result.skipped}, failed ${result.failed}.`);
  }

  async function connectGit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnectorStatus("Cloning repository and scanning source files...");
    try {
      const response = await fetch(`${API_BASE}/api/v1/connectors/git`, {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({
          dataset: connectorDataset,
          repoUrl: gitRepoUrl.trim(),
          branch: gitBranch.trim() || undefined,
          maxFiles: MAX_IMPORT_FILES,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "Git connector failed");
      await refreshInventory();
      setConnectorStatus(`Git connector indexed ${payload.indexed}, skipped ${payload.skipped}, failed ${payload.failed}.`);
    } catch (error) {
      setConnectorStatus(error instanceof Error ? error.message : "Git connector failed. Check repository access and server Git configuration.");
    }
  }

  async function connectSftp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnectorStatus("Connecting to SFTP and scanning remote source files...");
    try {
      const response = await fetch(`${API_BASE}/api/v1/connectors/sftp`, {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({
          dataset: connectorDataset,
          host: sftpHost.trim(),
          port: Number(sftpPort || 22),
          username: sftpUsername.trim(),
          password: sftpPassword,
          remotePath: sftpRemotePath.trim(),
          maxFiles: MAX_IMPORT_FILES,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "SFTP connector failed");
      await refreshInventory();
      setConnectorStatus(`SFTP connector indexed ${payload.indexed}, skipped ${payload.skipped}, failed ${payload.failed}.`);
    } catch (error) {
      setConnectorStatus(error instanceof Error ? error.message : "SFTP connector failed. Check credentials and remote path.");
    }
  }

  async function loadModelOps() {
    setModelStatus("Checking model and telemetry endpoints...");
    try {
      const healthResponse = await fetch(`${API_BASE}/api/v1/model/health`, { headers: requestHeaders() });
      const health = await healthResponse.json();
      setModelHealth(health);
    } catch {
      setModelHealth(null);
    }
    try {
      const metricsResponse = await fetch(`${API_BASE}/metrics`, { headers: requestHeaders() });
      setMetricsText(metricsResponse.ok ? await metricsResponse.text() : "");
    } catch {
      setMetricsText("");
    }
    setModelStatus("");
  }

  const nav = [
    { label: "Chat", view: "chat" as View, icon: Bot, count: 3 },
    { label: "Graphs", view: "programs" as View, icon: Network, expandable: true },
    { label: "Programs", view: "programs" as View, icon: FileCode2, child: true },
    { label: "Data flow", view: "dataflow" as View, icon: GitBranch, child: true },
    { label: "File relationships", view: "relationships" as View, icon: Files, child: true },
    { label: "AI explanation", view: "explanation" as View, icon: Sparkles, child: true },
    { label: "Knowledge base", view: "knowledge" as View, icon: Database, expandable: true },
    { label: "Connectors", view: "connectors" as View, icon: FileInput, child: true },
  ];
  const currentTitle = view === "chat"
    ? "Claims processing workflow"
    : view === "connectors"
      ? "Source connectors"
      : view === "model"
        ? "Model operations"
    : view === "settings"
      ? "Capabilities"
      : nav.find((item) => item.view === view)?.label ?? "Workspace";
  const graphEyebrow = view === "settings" ? "Product truth" : view === "programs" ? "Repository inventory" : view === "connectors" ? "Repository access" : view === "model" ? "Operations" : "Dependency map";
  const graphTitle = view === "settings" ? "Capability matrix" : view === "programs" ? "Programs inventory" : view === "connectors" ? "Connect source repositories" : view === "model" ? "Model and audit telemetry" : "Claims processing workflow";
  const graphMeta = view === "settings" ? "Live product status labels" : view === "programs" ? "Indexed source estate" : view === "connectors" ? "Folder, ZIP, Git URL, and SFTP ingestion" : view === "model" ? "Provider health and Prometheus metrics" : "Live relationship view · updated just now";

  return <div className="app-shell">
    <button className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={18} /></button>
    <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
      <div className="brand"><span className="brand-mark">N</span><span>AgentMailbox</span><button className="mobile-close" aria-label="Close navigation" onClick={() => setMobileNav(false)}><X size={17} /></button></div>
      <button className="workspace-switcher"><span className="status-dot" /> <span>Legacy estate</span><ChevronDown size={15} /></button>
      <div className="nav-label">Workspace</div>
      <nav className="nav-list">{nav.map(({ label, view: navView, icon: Icon, child, count, expandable }) => <button key={`${label}-${navView}`} className={`nav-item ${child ? "nav-child" : ""} ${view === navView ? "is-active" : ""}`} onClick={() => { setView(navView); setMobileNav(false); }}><Icon size={child ? 15 : 16} strokeWidth={1.8} /><span>{label}</span>{count && <span className="nav-count">{count}</span>}{expandable && <ChevronDown className="nav-end-icon" size={14} />}</button>)}</nav>
      <div className="sidebar-spacer" />
      <nav className="nav-list sidebar-lower"><div className="nav-label">Admin</div><button className={`nav-item ${view === "model" ? "is-active" : ""}`} onClick={() => setView("model")}><Activity size={16} /><span>Model ops</span><ChevronRight className="nav-end-icon" size={14} /></button><button className={`nav-item ${view === "settings" ? "is-active" : ""}`} onClick={() => setView("settings")}><Settings2 size={16} /><span>Capabilities</span><ChevronRight className="nav-end-icon" size={14} /></button><button className="nav-item is-disabled"><CircleHelp size={16} /><span>Support</span></button></nav>
      <div className="sidebar-footer"><span className="status-dot" /><div><strong>Index connected</strong><small>Local workspace</small></div><button className="icon-button" aria-label="More workspace actions"><MoreHorizontal size={17} /></button></div>
    </aside>
    {mobileNav && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <main className="main-panel">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button desktop-only" aria-label="Toggle navigation"><LayoutGrid size={16} /></button><span>Workspace</span><ChevronRight size={14} /><strong>{currentTitle}</strong></div><div className="top-actions"><span className="index-health"><span className="status-dot" /> Live index <span className="health-divider" /> {inventory ? `${inventory.totalFiles} files` : "8 entities"}</span><button className="outline-button" onClick={() => setImportOpen(true)}><FileInput size={15} /> Import source</button><button className="avatar" aria-label="Open account menu">R</button></div></header>
      <section className="workspace">
        <section className="chat-column"><div className="section-heading"><div><div className="eyebrow">Knowledge chat</div><h1>Understand your estate</h1><p>Ask questions grounded in parsed source and dependency context.</p></div><button className="icon-button" aria-label="More chat options"><MoreHorizontal size={18} /></button></div><div className="conversation" id="message-list">{messages.map((message, index) => <article className={`message ${message.role}`} key={`${message.text}-${index}`}>{message.role === "assistant" && <div className="message-meta"><span className="mini-mark"><Bot size={14} /></span><span>AgentMailbox</span><time>Now</time></div>}<p>{message.text}</p>{message.detail && <p className="message-detail">{message.detail}</p>}{message.source && <div className="source-chip"><span><FileCode2 size={12} /> {message.source}</span><ChevronRight size={14} /></div>}{message.citations && message.citations.length > 0 && <div className="citation-list">{message.citations.slice(0, 4).map((citation) => <span key={`${citation.id}-${citation.sourceId ?? citation.program ?? ""}`}><FileCode2 size={11} /> {citation.program ?? citation.sourceId ?? citation.id}</span>)}</div>}{message.role === "assistant" && index === 0 && <button className="inline-action" onClick={() => setSelectedId("STEP-05R")}><Sparkles size={13} /> Highlight related nodes</button>}{message.role === "user" && <time>Now</time>}</article>)}</div><form className="composer" onSubmit={submitSearch}><div className="composer-label"><Search size={15} /><span>Ask the knowledge layer</span></div><textarea value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitSearch(); }} rows={2} placeholder="Ask about a program, rule, or dependency…" aria-label="Ask AgentMailbox" /><div className="composer-footer"><span>⌘ Enter to search</span><button className="send-button" aria-label="Search knowledge graph"><ArrowUp size={17} /></button></div></form></section>
        <section className="graph-column"><div className="graph-header"><div><div className="eyebrow">{graphEyebrow}</div><h2>{graphTitle}</h2><span className="graph-meta"><Activity size={13} /> {graphMeta}</span></div><div className="graph-header-actions"><button className="icon-button" aria-label="Graph options"><MoreHorizontal size={18} /></button></div></div>{view === "connectors" ? <ConnectorPanel dataset={connectorDataset} gitRepoUrl={gitRepoUrl} gitBranch={gitBranch} sftpHost={sftpHost} sftpPort={sftpPort} sftpUsername={sftpUsername} sftpPassword={sftpPassword} sftpRemotePath={sftpRemotePath} status={connectorStatus} onDatasetChange={setConnectorDataset} onGitRepoUrlChange={setGitRepoUrl} onGitBranchChange={setGitBranch} onSftpHostChange={setSftpHost} onSftpPortChange={setSftpPort} onSftpUsernameChange={setSftpUsername} onSftpPasswordChange={setSftpPassword} onSftpRemotePathChange={setSftpRemotePath} onZip={ingestZip} onGit={connectGit} onSftp={connectSftp} onFolder={() => setImportOpen(true)} /> : view === "model" ? <ModelOpsPanel health={modelHealth} status={modelStatus} metricsText={metricsText} onRefresh={loadModelOps} /> : view === "settings" ? <CapabilityMatrix matrix={capabilityMatrix} counts={capabilityCounts} /> : view === "programs" ? <ProgramInventory inventory={inventory} details={sourceDetails} detailsStatus={detailsStatus} impact={impactResult} impactStatus={impactStatus} evidence={evidenceBundle} evidenceStatus={evidenceStatus} onImport={() => setImportOpen(true)} onSelectSource={openSourceDetails} onAnalyzeImpact={analyzeImpact} onExportEvidence={exportEvidence} /> : <><div className="graph-toolbar"><div className="segmented" role="tablist">{(["Graph", "Flow", "Files"] as GraphMode[]).map((mode) => <button key={mode} className={graphMode === mode ? "is-active" : ""} onClick={() => setGraphMode(mode)} role="tab" aria-selected={graphMode === mode}>{mode}</button>)}</div><div className="graph-tools"><button className="icon-button" aria-label="Zoom in" onClick={() => setScale((current) => Math.min(1.35, current + .1))}><Plus size={16} /></button><button className="icon-button" aria-label="Zoom out" onClick={() => setScale((current) => Math.max(.75, current - .1))}><Minus size={16} /></button><button className="icon-button" aria-label="Fit graph" onClick={() => setScale(1)}><Maximize2 size={15} /></button></div></div><div className="graph-canvas"><svg viewBox="0 0 760 620" role="img" aria-label="Interactive business dependency graph"><g transform={`scale(${scale})`}>{edges.map(([from, to]) => { const a = nodes.find((node) => node.id === from)!; const b = nodes.find((node) => node.id === to)!; return <line key={`${from}-${to}`} className={connectedIds.has(from) && connectedIds.has(to) ? "graph-line is-connected" : "graph-line"} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />; })}{nodes.map((node) => <g key={node.id} className={`graph-node ${node.id === selectedId ? "is-selected" : ""}`} transform={`translate(${node.x} ${node.y})`} onClick={() => setSelectedId(node.id)} tabIndex={0} role="button" aria-label={`Select ${node.label}`}><circle r={node.id === selectedId ? 9 : 5} /><text x="13" y="4">{node.label}</text></g>)}</g></svg><div className="graph-legend"><span><i className="legend-dot green" /> Selected path</span><span><i className="legend-dot gray" /> Related entity</span></div><div className="graph-zoom">{Math.round(scale * 100)}%</div></div><aside className="node-inspector"><div className="inspector-heading"><span className="eyebrow">Selected entity</span><button className="icon-button" aria-label="Close inspector"><X size={15} /></button></div><div className="inspector-title"><span className="selected-dot" /><strong>{selected.label}</strong></div><p>{selected.description}</p><div className="inspector-grid"><div><span>Type</span><strong>{selected.type}</strong></div><div><span>Program</span><strong>{selected.program}</strong></div><div><span>Connections</span><strong>{connectedIds.size - 1} related</strong></div></div><DependencyChain selected={selected} connectedIds={connectedIds} /><button className="dark-button" onClick={() => { setQuery(`Explain ${selected.label}`); setView("chat"); }}>Open explanation <ArrowUp size={15} /></button></aside></>}</section>
      </section>
    </main>
    {importOpen && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="import-title"><form onSubmit={extract}><div className="modal-header"><div><div className="eyebrow">Add to knowledge layer</div><h2 id="import-title">Connect repository source</h2><p>Choose a repository folder or selected source files to ingest into the tenant-scoped knowledge layer.</p></div><button type="button" className="icon-button" onClick={() => setImportOpen(false)} aria-label="Close import dialog"><X size={18} /></button></div><label>API key<input name="apiKey" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Bearer key for this deployment" /></label><label>Tenant / node set<input name="tenantId" value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="PAYROLL, GL, CLAIMS, tenant-id" /></label><label>Dataset<input name="dataset" defaultValue="local-upload" required /></label><label>Repository folder<input className="file-picker" type="file" multiple onChange={selectImportFiles} {...{ webkitdirectory: "true", directory: "true" }} /></label><label>Source files<input className="file-picker" type="file" multiple onChange={selectImportFiles} accept=".cbl,.cob,.cobol,.cpy,.copy,.jcl,.job,.pli,.pl1,.rexx,.rex,.sql,.txt" /></label>{selectedFiles.length > 0 && <div className="file-selection"><strong>{selectedFiles.filter(shouldImportSourceFile).slice(0, MAX_IMPORT_FILES).length} importable files</strong><span>{selectedFiles.slice(0, 3).map((file) => file.webkitRelativePath || file.name).join(", ")}{selectedFiles.length > 3 ? "..." : ""}</span></div>}<label>Fallback filename<input name="filename" defaultValue="LOAN-CALC.cbl" required={selectedFiles.length === 0} /></label><label>Paste source<textarea name="code" rows={10} placeholder="Paste COBOL, JCL, PL/I, or REXX source when not selecting files..." required={selectedFiles.length === 0} /></label>{inventory && <div className="inventory-strip"><span>{inventory.totalFiles} files</span><span>{inventory.indexed} indexed</span><span>{inventory.failed} failed</span></div>}{importStatus && <div className={`modal-status ${importStatus.startsWith("The") ? "is-error" : ""}`}>{importStatus}</div>}<div className="modal-actions"><button type="button" className="outline-button" onClick={() => setImportOpen(false)}>Cancel</button><button className="dark-button" type="submit">Ingest source <ArrowUp size={15} /></button></div></form></div></div>}
  </div>;

  function requestHeaders(json = false): HeadersInit {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(tenantId.trim() ? { "X-AgentMailbox-Tenant": tenantId.trim() } : {}),
    };
  }
}

function shouldImportSourcePath(path: string): boolean {
  const segments = path.split(/[\\/]+/);
  if (segments.some((segment) => IGNORED_REPO_SEGMENTS.has(segment))) return false;
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(lower.slice(dot));
}

function shouldImportSourceFile(file: UploadFile): boolean {
  return shouldImportSourcePath(file.webkitRelativePath || file.name);
}

export default App;

function ConnectorPanel(props: {
  dataset: string;
  gitRepoUrl: string;
  gitBranch: string;
  sftpHost: string;
  sftpPort: string;
  sftpUsername: string;
  sftpPassword: string;
  sftpRemotePath: string;
  status: string;
  onDatasetChange: (value: string) => void;
  onGitRepoUrlChange: (value: string) => void;
  onGitBranchChange: (value: string) => void;
  onSftpHostChange: (value: string) => void;
  onSftpPortChange: (value: string) => void;
  onSftpUsernameChange: (value: string) => void;
  onSftpPasswordChange: (value: string) => void;
  onSftpRemotePathChange: (value: string) => void;
  onZip: (event: ChangeEvent<HTMLInputElement>) => void;
  onGit: (event: FormEvent<HTMLFormElement>) => void;
  onSftp: (event: FormEvent<HTMLFormElement>) => void;
  onFolder: () => void;
}) {
  return <div className="ops-panel">
    <section className="connector-hero">
      <div>
        <span className="eyebrow">Enterprise source access</span>
        <h3>Connect the estate without hardcoded paths</h3>
        <p>Every connector feeds the same tenant-scoped ingestion pipeline, so inventory, rules, impact analysis, graph search, and evidence exports stay consistent.</p>
      </div>
      <label className="compact-field">Dataset / node set<input value={props.dataset} onChange={(event) => props.onDatasetChange(event.target.value)} /></label>
    </section>
    <div className="connector-grid">
      <article className="connector-card">
        <div><span className="eyebrow">Browser</span><h3>Repository folder</h3><p>Select a local clone when the source is already mounted on the analyst workstation.</p></div>
        <button className="dark-button" onClick={props.onFolder}><FileInput size={14} /> Open folder import</button>
      </article>
      <article className="connector-card">
        <div><span className="eyebrow">Browser</span><h3>ZIP archive</h3><p>Extracts source in the browser, filters generated/vendor folders, and sends only supported source files.</p></div>
        <label className="zip-drop"><FileInput size={15} /> Choose ZIP<input type="file" accept=".zip" onChange={props.onZip} /></label>
      </article>
      <form className="connector-card" onSubmit={props.onGit}>
        <div><span className="eyebrow">Server</span><h3>Git URL</h3><p>Server-side shallow clone for enterprise Git providers, SSH remotes, and authenticated network paths.</p></div>
        <label>Repository URL<input value={props.gitRepoUrl} onChange={(event) => props.onGitRepoUrlChange(event.target.value)} placeholder="https://github.enterprise/app/mainframe.git" required /></label>
        <label>Branch<input value={props.gitBranch} onChange={(event) => props.onGitBranchChange(event.target.value)} placeholder="main, release/2026-q3" /></label>
        <button className="dark-button" type="submit"><GitBranch size={14} /> Connect Git</button>
      </form>
      <form className="connector-card" onSubmit={props.onSftp}>
        <div><span className="eyebrow">Server</span><h3>SFTP / mainframe drop</h3><p>Reads source from secure transfer directories used by mainframe build and release flows.</p></div>
        <div className="field-row"><label>Host<input value={props.sftpHost} onChange={(event) => props.onSftpHostChange(event.target.value)} placeholder="sftp.enterprise.local" required /></label><label>Port<input value={props.sftpPort} onChange={(event) => props.onSftpPortChange(event.target.value)} inputMode="numeric" required /></label></div>
        <label>Username<input value={props.sftpUsername} onChange={(event) => props.onSftpUsernameChange(event.target.value)} required /></label>
        <label>Password<input value={props.sftpPassword} onChange={(event) => props.onSftpPasswordChange(event.target.value)} type="password" required /></label>
        <label>Remote path<input value={props.sftpRemotePath} onChange={(event) => props.onSftpRemotePathChange(event.target.value)} placeholder="/u/app/source" required /></label>
        <button className="dark-button" type="submit"><Database size={14} /> Connect SFTP</button>
      </form>
    </div>
    {props.status && <div className="connector-status">{props.status}</div>}
  </div>;
}

function ModelOpsPanel({ health, status, metricsText, onRefresh }: { health: ModelHealth | null; status: string; metricsText: string; onRefresh: () => void }) {
  const modelMetrics = metricsText.split("\n").filter((line) => /model|llm|token|latency|request/i.test(line) && !line.startsWith("#")).slice(0, 8);
  return <div className="ops-panel">
    <section className="connector-hero">
      <div>
        <span className="eyebrow">On-prem model connection</span>
        <h3>Provider health and usage audit</h3>
        <p>The UI reads the same model health endpoint used by deployment checks and Prometheus metrics exposed by the production server.</p>
      </div>
      <button className="outline-button" onClick={onRefresh}><Activity size={14} /> Refresh</button>
    </section>
    <div className="model-grid">
      <article className="model-card">
        <span className="eyebrow">Provider</span>
        <h3>{health?.provider ?? "Unknown"}</h3>
        <p>{health?.baseUrl ?? "No model base URL reported by this deployment."}</p>
      </article>
      <article className="model-card">
        <span className="eyebrow">Model</span>
        <h3>{health?.model ?? "Unknown"}</h3>
        <p>{health?.openaiCompatible ? "OpenAI-compatible chat completions API" : "Native provider API or not configured"}</p>
      </article>
      <article className="model-card">
        <span className="eyebrow">Status</span>
        <h3 className={`model-status-${health?.status ?? "error"}`}>{health?.status ?? "unavailable"}</h3>
        <p>{health?.latencyMs ? `${health.latencyMs} ms health check` : health?.error ?? "Refresh to verify the current endpoint."}</p>
      </article>
    </div>
    <section className="metrics-panel">
      <div><span className="eyebrow">Audit trail</span><h3>Runtime metrics</h3></div>
      {status && <p>{status}</p>}
      {modelMetrics.length === 0 ? <p>No model-specific metrics are exposed yet. The `/metrics` endpoint is reachable when the production server is running.</p> : <pre>{modelMetrics.join("\n")}</pre>}
    </section>
  </div>;
}

function DependencyChain({ selected, connectedIds }: { selected: Node; connectedIds: Set<string> }) {
  const connected = nodes.filter((node) => node.id !== selected.id && connectedIds.has(node.id));
  return <div className="dependency-chain">
    <span className="eyebrow">Dependency chain</span>
    {connected.length === 0 ? <p>No adjacent entities are highlighted.</p> : connected.map((node) => <div key={node.id} className="chain-row"><span>{selected.label}</span><ChevronRight size={13} /><strong>{node.label}</strong></div>)}
  </div>;
}

function CapabilityMatrix({ matrix, counts }: { matrix: ProductCapabilityMatrix; counts: Record<CapabilityStatus, number> }) {
  return <div className="capability-panel">
    <div className="capability-summary">
      {(["live", "beta", "prototype", "roadmap"] as CapabilityStatus[]).map((status) => <div key={status} className={`capability-count status-${status}`}><span>{status}</span><strong>{counts[status]}</strong></div>)}
    </div>
    <div className="capability-note"><strong>Product truth layer</strong><span>Every outward claim should map to one of these statuses. Roadmap items are intentionally visible so demos stay honest.</span></div>
    <div className="capability-list">{matrix.capabilities.map((capability) => <article className="capability-card" key={capability.id}><div className="capability-card-head"><div><span className="eyebrow">{capability.category}</span><h3>{capability.title}</h3></div><span className={`status-pill status-${capability.status}`}>{capability.status}</span></div><p>{capability.summary}</p>{capability.nextMilestone && <div className="next-milestone"><span>Next</span>{capability.nextMilestone}</div>}<div className="evidence-row">{capability.evidence.slice(0, 3).map((item) => <code key={item}>{item}</code>)}</div></article>)}</div>
  </div>;
}

function ProgramInventory({ inventory, details, detailsStatus, impact, impactStatus, evidence, evidenceStatus, onImport, onSelectSource, onAnalyzeImpact, onExportEvidence }: { inventory: IngestionInventory | null; details: IngestionSourceDetails | null; detailsStatus: string; impact: ImpactAnalysisResult | null; impactStatus: string; evidence: EvidenceBundle | null; evidenceStatus: string; onImport: () => void; onSelectSource: (sourceId: string) => void; onAnalyzeImpact: (sourceId: string, ruleId?: string) => void; onExportEvidence: (sourceId: string, ruleId?: string) => void }) {
  const files = inventory?.files ?? [];
  if (!inventory || files.length === 0) {
    return <div className="inventory-panel">
      <div className="empty-inventory">
        <FileInput size={28} />
        <h3>No repository files indexed yet</h3>
        <p>Import COBOL, JCL, PL/I, or REXX source to create the first grounded knowledge layer for this workspace.</p>
        <button className="dark-button" onClick={onImport}>Import source <ArrowUp size={15} /></button>
      </div>
    </div>;
  }
  return <div className="inventory-panel">
    <div className="inventory-summary">
      <div><span>Total files</span><strong>{inventory.totalFiles}</strong></div>
      <div><span>Indexed</span><strong>{inventory.indexed}</strong></div>
      <div><span>Skipped</span><strong>{inventory.skipped}</strong></div>
      <div><span>Failed</span><strong>{inventory.failed}</strong></div>
    </div>
    <div className="inventory-datasets">
      {inventory.datasets.map((dataset) => <span key={dataset}>{dataset}</span>)}
    </div>
    <div className="inventory-table" role="table" aria-label="Indexed program inventory">
      <div className="inventory-row inventory-head" role="row">
        <span>Status</span><span>Program</span><span>File</span><span>Language</span><span>Dataset</span>
      </div>
      {files.map((file) => <button className={`inventory-row inventory-row-button ${details?.sourceId === file.sourceId ? "is-selected" : ""}`} role="row" key={file.sourceId} onClick={() => onSelectSource(file.sourceId)}>
        <span><i className={`status-chip status-${file.status}`}>{file.status}</i></span>
        <strong>{file.program ?? "Pending parse"}</strong>
        <code title={file.sourceId}>{file.filename}</code>
        <span>{file.language ?? "auto"}</span>
        <span>{file.dataset ?? file.sourceId.split("/")[0]}</span>
        {file.error && <p>{file.error}</p>}
      </button>)}
    </div>
    {detailsStatus && <div className="details-status">{detailsStatus}</div>}
    {details && <section className="source-details">
      <div className="source-details-head">
        <div><span className="eyebrow">Extracted knowledge</span><h3>{details.program ?? details.filename}</h3></div>
        <div className="source-detail-actions"><span>{details.rulesExtracted ?? details.businessRules.length} rules</span><button className="outline-button" onClick={() => onAnalyzeImpact(details.sourceId)}><GitBranch size={14} /> Analyze impact</button><button className="outline-button" onClick={() => onExportEvidence(details.sourceId)}><FileInput size={14} /> Export evidence</button></div>
      </div>
      {details.businessRules.length === 0 ? <p className="details-empty">This source was indexed, but no explicit business-rule nodes were persisted for drill-down yet.</p> : <div className="rule-list">
        {details.businessRules.map((rule) => <article className="rule-card" key={`${details.sourceId}-${rule.id}`}>
          <div><strong>{rule.id}</strong><span>{rule.domain ?? "unknown domain"} · {rule.type}</span></div>
          <p>{rule.description}</p>
          <button className="inline-action" onClick={() => onAnalyzeImpact(details.sourceId, rule.id)}><GitBranch size={13} /> Analyze rule impact</button>
          <button className="inline-action" onClick={() => onExportEvidence(details.sourceId, rule.id)}><FileInput size={13} /> Export rule evidence</button>
        </article>)}
      </div>}
    </section>}
    {impactStatus && <div className="details-status">{impactStatus}</div>}
    {impact && <section className="impact-panel">
      <div className="source-details-head">
        <div><span className="eyebrow">Impact analysis</span><h3>{impact.target}</h3></div>
        <span className={`risk-pill risk-${impact.riskLevel}`}>{impact.riskLevel} risk</span>
      </div>
      <div className="impact-summary">
        <div><span>Affected files</span><strong>{impact.affectedSources.length}</strong></div>
        <div><span>Affected rules</span><strong>{impact.affectedRules.length}</strong></div>
        <div><span>Programs</span><strong>{impact.affectedPrograms.length}</strong></div>
        <div><span>Datasets</span><strong>{impact.affectedDatasets.length}</strong></div>
      </div>
      <div className="impact-columns">
        <div><h4>Files to review</h4>{impact.affectedSources.length === 0 ? <p>No affected source files were found.</p> : impact.affectedSources.map((source) => <article className="impact-item" key={source.sourceId}><strong>{source.filename}</strong><span>{source.relationship} · {source.dataset}</span><small>{source.evidence.join("; ")}</small></article>)}</div>
        <div><h4>Rules to verify</h4>{impact.affectedRules.length === 0 ? <p>No related business rules were found.</p> : impact.affectedRules.map((rule) => <article className="impact-item" key={`${rule.sourceId}-${rule.id}`}><strong>{rule.id}</strong><span>{rule.program ?? rule.sourceId}</span><small>{rule.description}</small></article>)}</div>
      </div>
    </section>}
    {evidenceStatus && <div className="details-status">{evidenceStatus}</div>}
    {evidence && <section className="evidence-panel">
      <div><span className="eyebrow">Evidence bundle</span><h3>{evidence.metadata.exportId}</h3></div>
      <code>{evidence.metadata.contentHash}</code>
      <p>Includes source details, extracted rules, impact analysis, product capability status, chain of custody, and limitations.</p>
    </section>}
  </div>;
}

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

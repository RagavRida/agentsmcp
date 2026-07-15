import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowUp, Bot, ChevronDown, ChevronRight, CircleHelp, Database,
  FileCode2, FileInput, Files, GitBranch, LayoutGrid, Maximize2, Menu,
  Minus, MoreHorizontal, Network, Plus, Search, Settings2, Sparkles, X, ZoomIn,
} from "lucide-react";

type View = "chat" | "programs" | "dataflow" | "relationships" | "explanation" | "knowledge" | "settings";
type GraphMode = "Graph" | "Flow" | "Files";
type Node = { id: string; x: number; y: number; label: string; type: string; description: string; program: string };
type Message = { role: "assistant" | "user"; text: string; detail?: string; source?: string };
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
  files: Array<{ sourceId: string; filename: string; status: "indexed" | "skipped" | "failed"; dataset?: string; connector?: string; language?: string; program?: string; error?: string; lastSeenAt?: string }>;
};
type UploadFile = File & { webkitRelativePath?: string };

const API_BASE = (window as Window & { AGENTMAILBOX_API?: string }).AGENTMAILBOX_API ?? "";
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
    live: "Available in the product today.",
    beta: "Implemented foundation exists, but hardening remains.",
    prototype: "Demonstrable, not yet a full production workflow.",
    roadmap: "Planned; do not market as shipped.",
  },
  capabilities: [
    { id: "mainframe-parser-registry", title: "Mainframe language parsing", status: "live", category: "ingestion", summary: "COBOL, JCL, PL/I, REXX, SQL, CICS, and copybook parsing foundations are available.", evidence: ["parser/src/registry.ts"] },
    { id: "business-rule-extraction", title: "Business rule extraction", status: "live", category: "knowledge", summary: "Deterministic rule extraction and LLM fallback support are available.", evidence: ["src/parser/llm-fallback.ts"] },
    { id: "impact-analysis", title: "Impact analysis", status: "prototype", category: "analysis", summary: "Dependency primitives exist, but the full workflow is still being built.", evidence: ["src/graph/neo4j-sync.ts"], nextMilestone: "Build a dedicated impact-analysis screen." },
    { id: "audit-compliance-exports", title: "Audit and compliance exports", status: "roadmap", category: "governance", summary: "Evidence bundles and compliance exports are planned.", evidence: ["infra/backup-postgres.sh"], nextMilestone: "Generate source-linked evidence bundles." },
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
  const [selectedFiles, setSelectedFiles] = useState<UploadFile[]>([]);
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

  async function refreshInventory() {
    try {
      const response = await fetch(`${API_BASE}/api/v1/ingest/inventory`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
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
      const response = await fetch(`${API_BASE}/api/v1/graph/search?query=${encodeURIComponent(cleanQuery)}&limit=8`);
      const payload = await response.json();
      const result = payload.results?.[0];
      if (response.ok && result) {
        const match = nodes.find((node) => node.id === result.id);
        if (match) setSelectedId(match.id);
        setMessages((current) => [...current, { role: "assistant", text: result.description, source: `${result.program} · ${result.type}` }]);
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
      const uploadedFiles = await Promise.all(selectedFiles.map(async (file) => {
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
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          dataset,
          connectorRunId: `ui-${Date.now()}`,
          files,
        }),
      });
      if (!response.ok) throw new Error("Ingestion failed");
      const result = await response.json();
      await refreshInventory();
      setImportStatus(`Indexed ${result.indexed}, skipped ${result.skipped}, failed ${result.failed}.`);
    } catch {
      setImportStatus("The ingestion API is unavailable or unauthorized. Check the server and API key.");
    }
  }

  function selectImportFiles(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFiles(Array.from(event.currentTarget.files ?? []) as UploadFile[]);
    setImportStatus("");
  }

  const nav = [
    { label: "Chat", view: "chat" as View, icon: Bot, count: 3 },
    { label: "Graphs", view: "programs" as View, icon: Network, expandable: true },
    { label: "Programs", view: "programs" as View, icon: FileCode2, child: true },
    { label: "Data flow", view: "dataflow" as View, icon: GitBranch, child: true },
    { label: "File relationships", view: "relationships" as View, icon: Files, child: true },
    { label: "AI explanation", view: "explanation" as View, icon: Sparkles, child: true },
    { label: "Knowledge base", view: "knowledge" as View, icon: Database, expandable: true },
  ];
  const currentTitle = view === "chat"
    ? "Claims processing workflow"
    : view === "settings"
      ? "Capabilities"
      : nav.find((item) => item.view === view)?.label ?? "Workspace";

  return <div className="app-shell">
    <button className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={18} /></button>
    <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
      <div className="brand"><span className="brand-mark">N</span><span>AgentMailbox</span><button className="mobile-close" aria-label="Close navigation" onClick={() => setMobileNav(false)}><X size={17} /></button></div>
      <button className="workspace-switcher"><span className="status-dot" /> <span>Legacy estate</span><ChevronDown size={15} /></button>
      <div className="nav-label">Workspace</div>
      <nav className="nav-list">{nav.map(({ label, view: navView, icon: Icon, child, count, expandable }) => <button key={`${label}-${navView}`} className={`nav-item ${child ? "nav-child" : ""} ${view === navView ? "is-active" : ""}`} onClick={() => { setView(navView); setMobileNav(false); }}><Icon size={child ? 15 : 16} strokeWidth={1.8} /><span>{label}</span>{count && <span className="nav-count">{count}</span>}{expandable && <ChevronDown className="nav-end-icon" size={14} />}</button>)}</nav>
      <div className="sidebar-spacer" />
      <nav className="nav-list sidebar-lower"><div className="nav-label">Admin</div><button className={`nav-item ${view === "settings" ? "is-active" : ""}`} onClick={() => setView("settings")}><Settings2 size={16} /><span>Capabilities</span><ChevronRight className="nav-end-icon" size={14} /></button><button className="nav-item is-disabled"><CircleHelp size={16} /><span>Support</span></button></nav>
      <div className="sidebar-footer"><span className="status-dot" /><div><strong>Index connected</strong><small>Local workspace</small></div><button className="icon-button" aria-label="More workspace actions"><MoreHorizontal size={17} /></button></div>
    </aside>
    {mobileNav && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <main className="main-panel">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button desktop-only" aria-label="Toggle navigation"><LayoutGrid size={16} /></button><span>Workspace</span><ChevronRight size={14} /><strong>{currentTitle}</strong></div><div className="top-actions"><span className="index-health"><span className="status-dot" /> Live index <span className="health-divider" /> {inventory ? `${inventory.totalFiles} files` : "8 entities"}</span><button className="outline-button" onClick={() => setImportOpen(true)}><FileInput size={15} /> Import source</button><button className="avatar" aria-label="Open account menu">R</button></div></header>
      <section className="workspace">
        <section className="chat-column"><div className="section-heading"><div><div className="eyebrow">Knowledge chat</div><h1>Understand your estate</h1><p>Ask questions grounded in parsed source and dependency context.</p></div><button className="icon-button" aria-label="More chat options"><MoreHorizontal size={18} /></button></div><div className="conversation" id="message-list">{messages.map((message, index) => <article className={`message ${message.role}`} key={`${message.text}-${index}`}>{message.role === "assistant" && <div className="message-meta"><span className="mini-mark"><Bot size={14} /></span><span>AgentMailbox</span><time>Now</time></div>}<p>{message.text}</p>{message.detail && <p className="message-detail">{message.detail}</p>}{message.source && <div className="source-chip"><span><FileCode2 size={12} /> {message.source}</span><ChevronRight size={14} /></div>}{message.role === "assistant" && index === 0 && <button className="inline-action" onClick={() => setSelectedId("STEP-05R")}><Sparkles size={13} /> Highlight related nodes</button>}{message.role === "user" && <time>Now</time>}</article>)}</div><form className="composer" onSubmit={submitSearch}><div className="composer-label"><Search size={15} /><span>Ask the knowledge layer</span></div><textarea value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitSearch(); }} rows={2} placeholder="Ask about a program, rule, or dependency…" aria-label="Ask AgentMailbox" /><div className="composer-footer"><span>⌘ Enter to search</span><button className="send-button" aria-label="Search knowledge graph"><ArrowUp size={17} /></button></div></form></section>
        <section className="graph-column"><div className="graph-header"><div><div className="eyebrow">{view === "settings" ? "Product truth" : view === "programs" ? "Repository inventory" : "Dependency map"}</div><h2>{view === "settings" ? "Capability matrix" : view === "programs" ? "Programs inventory" : "Claims processing workflow"}</h2><span className="graph-meta"><Activity size={13} /> {view === "settings" ? "Live product status labels" : view === "programs" ? "Indexed source estate" : "Live relationship view · updated just now"}</span></div><div className="graph-header-actions"><button className="icon-button" aria-label="Graph options"><MoreHorizontal size={18} /></button></div></div>{view === "settings" ? <CapabilityMatrix matrix={capabilityMatrix} counts={capabilityCounts} /> : view === "programs" ? <ProgramInventory inventory={inventory} onImport={() => setImportOpen(true)} /> : <><div className="graph-toolbar"><div className="segmented" role="tablist">{(["Graph", "Flow", "Files"] as GraphMode[]).map((mode) => <button key={mode} className={graphMode === mode ? "is-active" : ""} onClick={() => setGraphMode(mode)} role="tab" aria-selected={graphMode === mode}>{mode}</button>)}</div><div className="graph-tools"><button className="icon-button" aria-label="Zoom in" onClick={() => setScale((current) => Math.min(1.35, current + .1))}><Plus size={16} /></button><button className="icon-button" aria-label="Zoom out" onClick={() => setScale((current) => Math.max(.75, current - .1))}><Minus size={16} /></button><button className="icon-button" aria-label="Fit graph" onClick={() => setScale(1)}><Maximize2 size={15} /></button></div></div><div className="graph-canvas"><svg viewBox="0 0 760 620" role="img" aria-label="Interactive business dependency graph"><g transform={`scale(${scale})`}>{edges.map(([from, to]) => { const a = nodes.find((node) => node.id === from)!; const b = nodes.find((node) => node.id === to)!; return <line key={`${from}-${to}`} className={connectedIds.has(from) && connectedIds.has(to) ? "graph-line is-connected" : "graph-line"} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />; })}{nodes.map((node) => <g key={node.id} className={`graph-node ${node.id === selectedId ? "is-selected" : ""}`} transform={`translate(${node.x} ${node.y})`} onClick={() => setSelectedId(node.id)} tabIndex={0} role="button" aria-label={`Select ${node.label}`}><circle r={node.id === selectedId ? 9 : 5} /><text x="13" y="4">{node.label}</text></g>)}</g></svg><div className="graph-legend"><span><i className="legend-dot green" /> Selected path</span><span><i className="legend-dot gray" /> Related entity</span></div><div className="graph-zoom">{Math.round(scale * 100)}%</div></div><aside className="node-inspector"><div className="inspector-heading"><span className="eyebrow">Selected entity</span><button className="icon-button" aria-label="Close inspector"><X size={15} /></button></div><div className="inspector-title"><span className="selected-dot" /><strong>{selected.label}</strong></div><p>{selected.description}</p><div className="inspector-grid"><div><span>Type</span><strong>{selected.type}</strong></div><div><span>Program</span><strong>{selected.program}</strong></div><div><span>Connections</span><strong>{connectedIds.size - 1} related</strong></div></div><button className="dark-button" onClick={() => { setQuery(`Explain ${selected.label}`); setView("chat"); }}>Open explanation <ArrowUp size={15} /></button></aside></>}</section>
      </section>
    </main>
    {importOpen && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="import-title"><form onSubmit={extract}><div className="modal-header"><div><div className="eyebrow">Add to knowledge layer</div><h2 id="import-title">Import mainframe source</h2><p>Ingest source files into a versioned repository inventory.</p></div><button type="button" className="icon-button" onClick={() => setImportOpen(false)} aria-label="Close import dialog"><X size={18} /></button></div><label>API key<input name="apiKey" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Bearer key for this deployment" /></label><label>Dataset<input name="dataset" defaultValue="local-upload" required /></label><label>Repository files<input className="file-picker" type="file" multiple onChange={selectImportFiles} /></label>{selectedFiles.length > 0 && <div className="file-selection"><strong>{selectedFiles.length} files selected</strong><span>{selectedFiles.slice(0, 3).map((file) => file.webkitRelativePath || file.name).join(", ")}{selectedFiles.length > 3 ? "..." : ""}</span></div>}<label>Fallback filename<input name="filename" defaultValue="LOAN-CALC.cbl" required={selectedFiles.length === 0} /></label><label>Paste source<textarea name="code" rows={10} placeholder="Paste COBOL, JCL, PL/I, or REXX source when not selecting files..." required={selectedFiles.length === 0} /></label>{inventory && <div className="inventory-strip"><span>{inventory.totalFiles} files</span><span>{inventory.indexed} indexed</span><span>{inventory.failed} failed</span></div>}{importStatus && <div className={`modal-status ${importStatus.startsWith("The") ? "is-error" : ""}`}>{importStatus}</div>}<div className="modal-actions"><button type="button" className="outline-button" onClick={() => setImportOpen(false)}>Cancel</button><button className="dark-button" type="submit">Ingest source <ArrowUp size={15} /></button></div></form></div></div>}
  </div>;
}

export default App;

function CapabilityMatrix({ matrix, counts }: { matrix: ProductCapabilityMatrix; counts: Record<CapabilityStatus, number> }) {
  return <div className="capability-panel">
    <div className="capability-summary">
      {(["live", "beta", "prototype", "roadmap"] as CapabilityStatus[]).map((status) => <div key={status} className={`capability-count status-${status}`}><span>{status}</span><strong>{counts[status]}</strong></div>)}
    </div>
    <div className="capability-note"><strong>Product truth layer</strong><span>Every outward claim should map to one of these statuses. Roadmap items are intentionally visible so demos stay honest.</span></div>
    <div className="capability-list">{matrix.capabilities.map((capability) => <article className="capability-card" key={capability.id}><div className="capability-card-head"><div><span className="eyebrow">{capability.category}</span><h3>{capability.title}</h3></div><span className={`status-pill status-${capability.status}`}>{capability.status}</span></div><p>{capability.summary}</p>{capability.nextMilestone && <div className="next-milestone"><span>Next</span>{capability.nextMilestone}</div>}<div className="evidence-row">{capability.evidence.slice(0, 3).map((item) => <code key={item}>{item}</code>)}</div></article>)}</div>
  </div>;
}

function ProgramInventory({ inventory, onImport }: { inventory: IngestionInventory | null; onImport: () => void }) {
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
      {files.map((file) => <div className="inventory-row" role="row" key={file.sourceId}>
        <span><i className={`status-chip status-${file.status}`}>{file.status}</i></span>
        <strong>{file.program ?? "Pending parse"}</strong>
        <code title={file.sourceId}>{file.filename}</code>
        <span>{file.language ?? "auto"}</span>
        <span>{file.dataset ?? file.sourceId.split("/")[0]}</span>
        {file.error && <p>{file.error}</p>}
      </div>)}
    </div>
  </div>;
}

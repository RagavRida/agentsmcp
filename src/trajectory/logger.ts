// ============================================================
// Trajectory Logger — Immutable Audit Trail
//
// Every AI reasoning step is logged to a .agent_history file.
// This provides:
// 1. Bank regulatory compliance (MiFID II, SOX, DORA)
// 2. Experience Replay — the AI can learn from past traversals
// 3. Full provenance — every answer is traceable to source nodes
// ============================================================

import * as fs from "fs";
import * as path from "path";

export interface TrajectoryEntry {
  timestamp: string;
  sessionId: string;
  action: TrajectoryAction;
  input: string;
  output: string;
  sources: string[];       // Node IDs that contributed to this step
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export type TrajectoryAction =
  | "PARSE"            // Parsed a source file
  | "GRAPH_QUERY"      // Queried the Neo4j graph
  | "VECTOR_SEARCH"    // Searched the vector store
  | "LLM_GENERATION"   // Generated text via LLM
  | "FLARE_RETRIEVAL"  // FLARE paused generation and retrieved context
  | "IMPACT_ANALYSIS"  // Ran impact analysis
  | "MIGRATION"        // Generated migration code
  | "SANDBOX_EXEC"     // Ran code in Modal sandbox
  | "USER_QUERY"       // User asked a question
  | "SESSION_DISTILL"; // Expired session distilled to trajectory

export class TrajectoryLogger {
  private logPath: string;
  private sessionId: string;
  private entries: TrajectoryEntry[] = [];

  constructor(options: {
    logDir: string;
    sessionId?: string;
  }) {
    this.sessionId = options.sessionId || `session-${Date.now()}`;
    this.logPath = path.join(
      options.logDir,
      `.agent_history_${this.sessionId}.jsonl`,
    );

    // Ensure the directory exists
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
  }

  /**
   * Log a trajectory entry. Appends to both in-memory buffer and disk.
   * The file is append-only — entries are never modified or deleted.
   */
  log(entry: Omit<TrajectoryEntry, "timestamp" | "sessionId">): void {
    const full: TrajectoryEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    };

    this.entries.push(full);

    // Append to disk (JSONL format — one JSON object per line)
    fs.appendFileSync(this.logPath, JSON.stringify(full) + "\n", "utf-8");
  }

  // ── Convenience Methods ────────────────────────────────────

  logParse(filename: string, result: {
    programName: string;
    businessRules: number;
    graphNodes: number;
  }, latencyMs: number): void {
    this.log({
      action: "PARSE",
      input: filename,
      output: `Parsed ${result.programName}: ${result.businessRules} rules, ${result.graphNodes} graph nodes`,
      sources: [result.programName],
      latencyMs,
    });
  }

  logGraphQuery(query: string, resultCount: number, nodeIds: string[], latencyMs: number): void {
    this.log({
      action: "GRAPH_QUERY",
      input: query,
      output: `Found ${resultCount} results`,
      sources: nodeIds,
      latencyMs,
    });
  }

  logVectorSearch(query: string, results: Array<{
    id: string;
    description: string;
    score: number;
  }>, latencyMs: number): void {
    this.log({
      action: "VECTOR_SEARCH",
      input: query,
      output: results.map((r) => `[${r.score.toFixed(3)}] ${r.description}`).join("\n"),
      sources: results.map((r) => r.id),
      latencyMs,
    });
  }

  logGeneration(prompt: string, response: string, sourceNodeIds: string[], latencyMs: number): void {
    this.log({
      action: "LLM_GENERATION",
      input: prompt,
      output: response,
      sources: sourceNodeIds,
      latencyMs,
    });
  }

  logFlareRetrieval(uncertainTokens: string, retrievedContext: string, sourceNodeIds: string[], latencyMs: number): void {
    this.log({
      action: "FLARE_RETRIEVAL",
      input: `Uncertain: "${uncertainTokens}"`,
      output: `Retrieved: ${retrievedContext}`,
      sources: sourceNodeIds,
      latencyMs,
    });
  }

  // ── Audit & Export ─────────────────────────────────────────

  /**
   * Export the full trajectory for regulatory audit.
   * Returns all entries from this session.
   */
  getTrajectory(): TrajectoryEntry[] {
    return [...this.entries];
  }

  /**
   * Load trajectory from disk (for experience replay or audit review).
   */
  static loadFromFile(filePath: string): TrajectoryEntry[] {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TrajectoryEntry);
  }

  /** Restore in-memory buffer from persisted entries (e.g. on startup). */
  hydrate(entries: TrajectoryEntry[]): void {
    this.entries = [...entries];
  }

  /**
   * Get a summary of this session's trajectory.
   */
  summary(): {
    sessionId: string;
    totalSteps: number;
    actions: Record<string, number>;
    totalLatencyMs: number;
    uniqueSources: number;
    logFile: string;
  } {
    const actions: Record<string, number> = {};
    let totalLatency = 0;
    const allSources = new Set<string>();

    for (const entry of this.entries) {
      actions[entry.action] = (actions[entry.action] || 0) + 1;
      totalLatency += entry.latencyMs;
      for (const src of entry.sources) allSources.add(src);
    }

    return {
      sessionId: this.sessionId,
      totalSteps: this.entries.length,
      actions,
      totalLatencyMs: totalLatency,
      uniqueSources: allSources.size,
      logFile: this.logPath,
    };
  }

  /**
   * Generate an audit report in human-readable format.
   */
  auditReport(): string {
    const lines: string[] = [
      `=== AUDIT TRAIL: ${this.sessionId} ===`,
      `Generated: ${new Date().toISOString()}`,
      `Total Steps: ${this.entries.length}`,
      "",
    ];

    for (const entry of this.entries) {
      lines.push(`[${entry.timestamp}] ${entry.action}`);
      lines.push(`  Input:   ${entry.input.substring(0, 200)}`);
      lines.push(`  Output:  ${entry.output.substring(0, 200)}`);
      lines.push(`  Sources: ${entry.sources.join(", ")}`);
      lines.push(`  Latency: ${entry.latencyMs}ms`);
      lines.push("");
    }

    return lines.join("\n");
  }
}

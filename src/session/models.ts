/**
 * Session Models — types for agent session lifecycle.
 *
 * Inspired by Cognee's modules/session_lifecycle/models.py
 */

/** A single session entry (key-value with TTL) */
export interface SessionEntry {
  key: string;
  value: unknown;
  timestamp: number;
  ttlMs: number;
  source: "agent" | "system" | "pipeline";
}

/** Session record — metadata about a session */
export interface SessionRecord {
  sessionId: string;
  agentId: string;
  createdAt: number;
  lastAccessedAt: number;
  entryCount: number;
  datasetId?: string;
  status: "active" | "idle" | "expired" | "distilled";
}

/** Summary of a session (for distillation into persistent memory) */
export interface SessionSummary {
  sessionId: string;
  agentId: string;
  duration: number;
  programs: string[];        // programs analyzed
  queries: string[];         // queries made
  keyInsights: string[];     // distilled insights
  distilledAt: number;
}

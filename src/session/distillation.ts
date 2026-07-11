/**
 * Session Distillation — compress expired sessions into persistent memory.
 *
 * Inspired by Cognee's modules/session_distillation/.
 * When a session expires, extract key insights and store them
 * in the knowledge graph so the agent has permanent memory
 * of what it learned during the session.
 */

import type { SessionManager } from "./manager";
import type { SessionSummary } from "./models";

export interface DistillationConfig {
  /** Summarizer function (LLM or deterministic) */
  summarizer?: (entries: Record<string, unknown>) => Promise<string[]>;
  /** Max sessions to distill per cycle */
  maxPerCycle?: number;
}

/**
 * Distill expired sessions into permanent memory.
 *
 * Returns summaries that can be fed into remember() for
 * permanent knowledge graph storage.
 */
export async function distillExpiredSessions(
  sessionManager: SessionManager,
  config?: DistillationConfig
): Promise<SessionSummary[]> {
  const maxPerCycle = config?.maxPerCycle ?? 10;
  const summaries: SessionSummary[] = [];

  // Find expired sessions that haven't been distilled yet
  const allSessions = sessionManager.listActiveSessions();
  // Only distill idle sessions (no recent access)
  const idleSessions = allSessions
    .filter(s => s.status === "idle")
    .slice(0, maxPerCycle);

  for (const record of idleSessions) {
    const entries = sessionManager.getAll(record.sessionId);
    if (Object.keys(entries).length === 0) continue;

    // Extract key data from session entries
    const programs = extractPrograms(entries);
    const queries = extractQueries(entries);

    let keyInsights: string[] = [];
    if (config?.summarizer) {
      keyInsights = await config.summarizer(entries);
    } else {
      // Deterministic distillation: extract notable entries
      keyInsights = Object.entries(entries)
        .filter(([k]) => !k.startsWith("last"))
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    }

    const summary: SessionSummary = {
      sessionId: record.sessionId,
      agentId: record.agentId,
      duration: Date.now() - record.createdAt,
      programs,
      queries,
      keyInsights,
      distilledAt: Date.now(),
    };

    summaries.push(summary);

    // Mark session as distilled and clear
    sessionManager.clear(record.sessionId);
  }

  return summaries;
}

function extractPrograms(entries: Record<string, unknown>): string[] {
  const programs = new Set<string>();
  for (const [key, value] of Object.entries(entries)) {
    if (key.includes("program") || key.includes("Program")) {
      if (typeof value === "string") programs.add(value);
    }
  }
  return [...programs];
}

function extractQueries(entries: Record<string, unknown>): string[] {
  const queries: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (key.includes("query") || key.includes("Query")) {
      if (typeof value === "string") queries.push(value);
    }
  }
  return queries;
}

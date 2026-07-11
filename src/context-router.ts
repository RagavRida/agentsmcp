/**
 * Dynamic Context Router
 *
 * Encapsulates context between agents without hardcoded contracts.
 * The system learns what each agent needs based on:
 *   1. What the receiver QUERIES (their interest signals)
 *   2. What the receiver USES from past messages (access patterns)
 *   3. What the sender MARKS as public vs internal (visibility hints)
 *
 * Store EVERYTHING. Scope on READ.
 *
 * Like a SQL view — same underlying data, different projection per agent.
 */

import type { Message, AgentAddress, ThreadContext } from "./types";

// ── Visibility Levels ──────────────────────────────────────
// Sender annotates their output at send time.
// NOT a hardcoded schema — just hints the router uses for filtering.
export type Visibility = "public" | "internal" | "derived";

export interface ContextField {
  key: string;        // dot-path: "businessRules", "graph.edges", "dataTransforms"
  visibility: Visibility;
  sizeBytes: number;  // for budget enforcement
}

// ── Agent Interest (learned dynamically) ───────────────────
export interface AgentInterest {
  agentId: AgentAddress;
  /** Fields this agent has accessed in past receives (auto-tracked) */
  accessedFields: Map<string, number>;  // field → access count
  /** Fields this agent explicitly requested (opt-in) */
  requestedFields: Set<string>;
  /** Max token budget this agent tolerates */
  tokenBudget: number;
  /** Last updated */
  updatedAt: number;
}

// ── Context Envelope ───────────────────────────────────────
// What's actually stored per message (full, unscoped)
export interface ContextEnvelope {
  /** Full payload from sender */
  full: Record<string, unknown>;
  /** Sender's visibility annotations (auto-generated from structure) */
  fields: ContextField[];
  /** Derivation chain: who produced what */
  provenance: { agentId: string; action: string; timestamp: number }[];
}

// ── The Router ─────────────────────────────────────────────

export class ContextRouter {
  private interests = new Map<AgentAddress, AgentInterest>();
  private envelopes = new Map<string, ContextEnvelope>(); // messageId → envelope

  /**
   * Wrap a payload for sending. Auto-discovers field structure
   * and assigns visibility based on heuristics:
   *   - Leaf values with small size → public
   *   - Large arrays/objects → derived (computed, may be expensive)
   *   - Keys starting with _ or containing "internal" → internal
   */
  wrap(
    senderId: AgentAddress,
    payload: Record<string, unknown>,
    overrides?: Partial<Record<string, Visibility>>
  ): ContextEnvelope {
    const fields: ContextField[] = [];

    const walk = (obj: Record<string, unknown>, prefix = "") => {
      for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const size = JSON.stringify(value).length;

        // Dynamic visibility assignment
        let vis: Visibility = "public";
        if (overrides?.[path]) {
          vis = overrides[path]!;
        } else if (key.startsWith("_") || key.includes("internal")) {
          vis = "internal";
        } else if (Array.isArray(value) && value.length > 20) {
          vis = "derived";  // large arrays are "computed" — send summary only
        } else if (typeof value === "object" && value !== null && size > 5000) {
          vis = "derived";  // large nested objects
        }

        fields.push({ key: path, visibility: vis, sizeBytes: size });

        // Recurse into objects (but not arrays — treat arrays as leaf)
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          walk(value as Record<string, unknown>, path);
        }
      }
    };

    walk(payload);

    return {
      full: payload,
      fields,
      provenance: [{ agentId: senderId, action: "SEND", timestamp: Date.now() }],
    };
  }

  /**
   * Scope an envelope for a specific receiver.
   * Uses the receiver's interest profile to filter.
   *
   * Priority:
   *   1. Explicitly requested fields → always include
   *   2. Frequently accessed fields → include if budget allows
   *   3. Public fields → include if budget allows
   *   4. Derived fields → include summary only
   *   5. Internal fields → never include
   */
  scope(
    envelope: ContextEnvelope,
    receiverId: AgentAddress,
    opts?: { tokenBudget?: number; includeFields?: string[] }
  ): Record<string, unknown> {
    const interest = this.interests.get(receiverId);
    const budget = opts?.tokenBudget ?? interest?.tokenBudget ?? Infinity;
    const explicitIncludes = new Set(opts?.includeFields || []);

    // Merge explicit with learned interests
    if (interest) {
      for (const f of interest.requestedFields) explicitIncludes.add(f);
    }

    // Score each field
    const scored = envelope.fields
      .filter(f => !f.key.includes(".")) // Only top-level fields for scoping
      .map(f => {
        let score = 0;

        // Explicitly requested → highest priority
        if (explicitIncludes.has(f.key)) score += 1000;

        // Frequently accessed → high priority
        const accessCount = interest?.accessedFields.get(f.key) ?? 0;
        score += accessCount * 10;

        // Visibility-based scoring
        if (f.visibility === "public") score += 5;
        if (f.visibility === "derived") score += 1;
        if (f.visibility === "internal") score = -1; // Never include unless explicit

        return { field: f, score };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // Build scoped output within budget
    const scoped: Record<string, unknown> = {};
    let usedBytes = 0;
    const budgetBytes = budget * 4; // ~4 bytes per token

    for (const { field } of scored) {
      const value = envelope.full[field.key];
      if (value === undefined) continue;

      if (usedBytes + field.sizeBytes > budgetBytes && budgetBytes !== Infinity) {
        // Over budget — include summary instead of full value
        if (Array.isArray(value)) {
          scoped[field.key] = { _summary: `Array[${value.length}]`, _count: value.length };
        } else if (typeof value === "object" && value !== null) {
          scoped[field.key] = { _summary: `Object[${Object.keys(value).length} keys]` };
        }
        // Skip scalars that don't fit
        continue;
      }

      scoped[field.key] = value;
      usedBytes += field.sizeBytes;
    }

    // Always include provenance (tiny)
    scoped._provenance = envelope.provenance;
    scoped._scopedFor = receiverId;
    scoped._includedFields = Object.keys(scoped).filter(k => !k.startsWith("_"));

    return scoped;
  }

  /**
   * Track what a receiver accesses (called automatically on receive).
   * This is how the system LEARNS what each agent needs — no config.
   */
  trackAccess(receiverId: AgentAddress, accessedKeys: string[]) {
    let interest = this.interests.get(receiverId);
    if (!interest) {
      interest = {
        agentId: receiverId,
        accessedFields: new Map(),
        requestedFields: new Set(),
        tokenBudget: Infinity,
        updatedAt: Date.now(),
      };
      this.interests.set(receiverId, interest);
    }

    for (const key of accessedKeys) {
      const count = interest.accessedFields.get(key) ?? 0;
      interest.accessedFields.set(key, count + 1);
    }
    interest.updatedAt = Date.now();
  }

  /**
   * Agent declares what it's interested in (opt-in, not required).
   * If never called, the system still works — just uses access patterns.
   */
  declareInterest(agentId: AgentAddress, fields: string[], tokenBudget?: number) {
    let interest = this.interests.get(agentId);
    if (!interest) {
      interest = {
        agentId,
        accessedFields: new Map(),
        requestedFields: new Set(),
        tokenBudget: tokenBudget ?? Infinity,
        updatedAt: Date.now(),
      };
      this.interests.set(agentId, interest);
    }
    for (const f of fields) interest.requestedFields.add(f);
    if (tokenBudget !== undefined) interest.tokenBudget = tokenBudget;
    interest.updatedAt = Date.now();
  }

  /**
   * Get the current interest profile for an agent (for debugging/audit).
   */
  getInterestProfile(agentId: AgentAddress): AgentInterest | undefined {
    return this.interests.get(agentId);
  }

  /** List all agent IDs with interest profiles (for persistence). */
  listAgentIds(): AgentAddress[] {
    return [...this.interests.keys()];
  }

  /**
   * Auto-generate a scoped send: wrap + scope in one call.
   * The sender sends FULL context, but each receiver only gets what they need.
   */
  route(
    senderId: AgentAddress,
    receiverId: AgentAddress,
    payload: Record<string, unknown>,
    opts?: { visibilityOverrides?: Partial<Record<string, Visibility>>; tokenBudget?: number }
  ): { envelope: ContextEnvelope; scoped: Record<string, unknown> } {
    const envelope = this.wrap(senderId, payload, opts?.visibilityOverrides);
    const scoped = this.scope(envelope, receiverId, { tokenBudget: opts?.tokenBudget });
    return { envelope, scoped };
  }
}

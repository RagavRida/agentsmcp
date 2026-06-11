import { PgPoolLike } from "./auth";
import { logger } from "../logger";

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  agentId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

/**
 * Record a new audit event in the database.
 * This is best-effort — failures are caught and logged but do not disrupt
 * the parent request/transaction.
 */
export async function recordAudit(
  pool: PgPoolLike,
  params: {
    userId?: string | null;
    agentId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (
        user_id, agent_id, action, resource_type, resource_id, metadata, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        params.userId ?? null,
        params.agentId ?? null,
        params.action,
        params.resourceType ?? null,
        params.resourceId ?? null,
        JSON.stringify(params.metadata ?? {}),
        params.ipAddress ?? null,
        params.userAgent ?? null,
      ]
    );
  } catch (err) {
    logger.error({ err }, "failed to write audit log");
  }
}

/**
 * Fetch the latest 100 audit log entries for a user, ordered by creation time descending.
 */
export async function getAuditTrail(
  pool: PgPoolLike,
  userId: string,
  limit = 100
): Promise<AuditLogEntry[]> {
  const res = await pool.query<{
    id: string;
    user_id: string | null;
    agent_id: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    metadata: Record<string, unknown>;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
  }>(
    `SELECT id, user_id, agent_id, action, resource_type, resource_id, metadata, ip_address, user_agent, created_at
     FROM audit_log
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );

  return res.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata ?? {},
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at.toISOString(),
  }));
}

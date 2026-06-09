import { Request, Response, NextFunction } from "express";
import {
  KEY_PREFIX,
  UPGRADE_URL,
  PgPoolLike,
  verifyApiKey,
  getPlanLimits,
  PlanLimits,
  verifySession,
  getUser,
} from "./auth";
import { ScopedStorage } from "./scoping";
import { Storage } from "../storage/interface";

// Augment Express's request type so route handlers can pull `req.userId`
// / `req.userPlan` / `req.storage` (the scoped Storage instance) with full
// type safety. This is global — once anyone in the project imports this
// file, Express's `Request` gains these optional fields everywhere.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userPlan?: string;
      apiKeyId?: string;
      storage?: Storage;
      planLimits?: PlanLimits;
    }
  }
}

export interface CloudAuthOptions {
  /** Shared pg.Pool — typically `await postgresStorage.getRawPool()`. */
  pool: PgPoolLike;
  /** Secret used to verify JWT session tokens. */
  sessionSecret?: string;
}

const SKIPPED_PREFIXES = [
  "/health",
  "/.well-known/",
  "/auth/register",
  "/auth/github",
  "/auth/session",
  "/usage/",
];

function shouldSkipAuth(path: string): boolean {
  return SKIPPED_PREFIXES.some((p) =>
    p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(`${p}?`)
  );
}

/**
 * Authenticate a Bearer token, look up the owning user, attach a request-
 * scoped `ScopedStorage`, and load the user's plan caps for downstream
 * enforcement.
 *
 * Supports both API keys (starting with sk_live_) and dashboard JWT session tokens.
 *
 * Returns 401 with `{error:"invalid_api_key"}` for any failure mode —
 * don't distinguish missing vs revoked vs expired in the response shape.
 */
export function cloudAuth(opts: CloudAuthOptions) {
  const { pool, sessionSecret } = opts;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (shouldSkipAuth(req.path)) return next();

    const header = req.header("authorization") ?? "";
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) {
      return res.status(401).json({ error: "invalid_api_key" });
    }
    const token = header.slice(prefix.length).trim();

    try {
      let verified: { userId: string; plan: string; keyId: string } | null = null;

      if (token.startsWith(KEY_PREFIX)) {
        verified = await verifyApiKey(pool, token);
      } else if (sessionSecret) {
        const payload = verifySession(token, sessionSecret);
        if (payload) {
          const user = await getUser(pool, payload.userId);
          if (user) {
            verified = {
              userId: user.userId,
              plan: user.plan,
              keyId: "__session__",
            };
          }
        }
      }

      if (!verified) {
        return res.status(401).json({ error: "invalid_api_key" });
      }

      req.userId = verified.userId;
      req.userPlan = verified.plan;
      req.apiKeyId = verified.keyId;
      req.storage = new ScopedStorage(pool, verified.userId);

      const limits = await getPlanLimits(pool, verified.plan);
      if (limits) req.planLimits = limits;
      return next();
    } catch (e) {
      // Never leak DB errors / stacks via auth failures.
      console.error("[agentsmcp] cloudAuth error:", e);
      return res.status(401).json({ error: "invalid_api_key" });
    }
  };
}

// --------------------------------------------------------------------------
// Plan-limit enforcement
// --------------------------------------------------------------------------

interface LimitFailure {
  status: number;
  body: {
    error: "plan_limit";
    resource: string;
    current: number;
    limit: number;
    upgrade: string;
  };
}

function limitFailure(
  resource: string,
  current: number,
  limit: number
): LimitFailure {
  return {
    status: 403,
    body: {
      error: "plan_limit",
      resource,
      current,
      limit,
      upgrade: UPGRADE_URL,
    },
  };
}

/**
 * Enforce per-plan caps before agent registration. -1 == unlimited.
 *
 * Mount as an Express middleware on POST /agents/register routes only,
 * AFTER cloudAuth so `req.userId` and `req.planLimits` are populated.
 */
export function enforceAgentCap(opts: CloudAuthOptions) {
  const { pool } = opts;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.userId || !req.planLimits) return next();
    const limit = req.planLimits.maxAgents;
    if (limit < 0) return next();

    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM agents WHERE user_id = $1`,
      [req.userId]
    );
    const current = Number(r.rows[0]?.c ?? 0);

    // If this would create a NEW agent (not idempotent re-register), check
    // the cap. The request body shape mirrors /agents/register's Zod schema.
    const body = req.body as { agentId?: string } | undefined;
    if (body?.agentId) {
      const existing = await pool.query(
        `SELECT 1 FROM agents WHERE id = $1 AND user_id = $2`,
        [body.agentId, req.userId]
      );
      if (existing.rows.length > 0) return next(); // idempotent, free
    }

    if (current >= limit) {
      const f = limitFailure("agents", current, limit);
      return res.status(f.status).json(f.body);
    }
    return next();
  };
}

/**
 * Enforce per-day message cap. Mount on POST /messages/send and POST
 * /messages/reply-all. Reads usage_metrics for today; rejects when the
 * count would exceed the plan's max_messages_per_day.
 *
 * Increment is NOT done here — call `recordMessageSent()` from the route
 * AFTER the send succeeds, so failed sends don't burn quota.
 */
export function enforceMessageCap(opts: CloudAuthOptions) {
  const { pool } = opts;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.userId || !req.planLimits) return next();
    const limit = req.planLimits.maxMessagesPerDay;
    if (limit < 0) return next();

    const r = await pool.query<{ c: string | null }>(
      `SELECT count::text AS c FROM usage_metrics
       WHERE user_id = $1 AND metric = 'messages_sent'
         AND period_start = CURRENT_DATE`,
      [req.userId]
    );
    const current = Number(r.rows[0]?.c ?? 0);
    if (current >= limit) {
      const f = limitFailure("messages_per_day", current, limit);
      return res.status(f.status).json(f.body);
    }
    return next();
  };
}

/**
 * UPSERT today's message counter. Best-effort: a failure here must not
 * undo the message that already landed. Caller is responsible for swallowing
 * any rejection.
 */
export async function recordMessageSent(
  pool: PgPoolLike,
  userId: string
): Promise<void> {
  await pool.query(
    `INSERT INTO usage_metrics (user_id, metric, count, period_start)
     VALUES ($1, 'messages_sent', 1, CURRENT_DATE)
     ON CONFLICT (user_id, metric, period_start)
     DO UPDATE SET count = usage_metrics.count + 1`,
    [userId]
  );
}

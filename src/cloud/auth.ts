import { createHash, randomBytes, timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";

// `pg` is in `dependencies` so it's always present at runtime, but we keep
// the import structural — same pattern as src/storage/postgres.ts — so the
// rest of the package doesn't need a hard compile-time dep on pg's types.
interface PgQueryResult<R = unknown> {
  rows: R[];
  rowCount: number | null;
}
interface PgClientLike {
  query<R = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<R>>;
  release(): void;
}
export interface PgPoolLike {
  query<R = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<R>>;
  connect(): Promise<PgClientLike>;
}

export interface GeneratedKey {
  /** Plaintext key. Returned to the user ONCE and never stored. */
  key: string;
  /** SHA-256 hex of `key`. Stored in api_keys.key_hash. */
  hash: string;
  /** First 16 chars of `key` ("sk_live_XXXXXXXX"). Safe to display. */
  prefix: string;
}

const KEY_BYTES = 32;
export const KEY_PREFIX = "sk_live_";
export const UPGRADE_URL = "https://agentsmcp.com/pricing";
const PREFIX_DISPLAY_LEN = 16;

/**
 * Generate a fresh API key. Returns the plaintext form (show to user once)
 * and the SHA-256 hash + display prefix (safe to persist).
 */
export function generateApiKey(): GeneratedKey {
  const raw = randomBytes(KEY_BYTES).toString("hex");
  const key = `${KEY_PREFIX}${raw}`;
  return {
    key,
    hash: hashApiKey(key),
    prefix: key.slice(0, PREFIX_DISPLAY_LEN),
  };
}

/** SHA-256 hex digest of an API key. Deterministic; used for lookups. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Constant-time comparison of two hex digests. Use this whenever you're
 * checking whether a presented hash matches a stored one — equality with
 * `===` leaks via timing.
 */
export function safeHashEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length === 0 || aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// Circuit breaker (for external dependencies, e.g. GitHub OAuth)
// ---------------------------------------------------------------------------

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. Default 5. */
  failureThreshold?: number;
  /** How long the circuit stays open before a half-open probe. Default 30s. */
  resetTimeoutMs?: number;
}

/** Thrown when the circuit is open and a call is rejected without executing. */
export class CircuitOpenError extends Error {
  constructor() {
    super("circuit_open");
    this.name = "CircuitOpenError";
  }
}

/**
 * Minimal in-memory circuit breaker. Opens after `failureThreshold`
 * consecutive failures; after `resetTimeoutMs` it half-opens, letting one
 * probe call through — success closes the circuit, failure re-opens it.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.resetMs = opts.resetTimeoutMs ?? 30_000;
  }

  get isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    // Past the reset window → allow a half-open probe through.
    return Date.now() - this.openedAt < this.resetMs;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) throw new CircuitOpenError();
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (e) {
      this.failures += 1;
      if (this.failures >= this.threshold) this.openedAt = Date.now();
      throw e;
    }
  }
}

export interface VerifiedKey {
  userId: string;
  plan: string;
  keyId: string;
}

interface KeyRow {
  id: string;
  user_id: string;
  key_hash: string;
  plan: string;
}

/**
 * Look up `bearerToken` in api_keys. Returns the owning user + plan if the
 * key is active (not revoked, not expired) and the hash matches. Updates
 * `last_used_at` on success.
 *
 * Returns `null` for any failure — invalid format, missing row, revoked,
 * expired, or hash mismatch. Callers should never distinguish these to the
 * client; respond with a single 401 shape regardless.
 */
export async function verifyApiKey(
  pool: PgPoolLike,
  bearerToken: string
): Promise<VerifiedKey | null> {
  if (typeof bearerToken !== "string" || !bearerToken.startsWith(KEY_PREFIX)) {
    return null;
  }
  const presentedHash = hashApiKey(bearerToken);

  // We look up by the hash (an indexed UNIQUE column) but still compare in
  // constant time to defend against any future change that makes the index
  // probe leak timing.
  const res = await pool.query<KeyRow>(
    `SELECT k.id, k.user_id, k.key_hash, u.plan
     FROM api_keys k
     JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1
       AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > NOW())
     LIMIT 1`,
    [presentedHash]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (!safeHashEquals(row.key_hash, presentedHash)) return null;

  // Best-effort last_used_at bump. Failure here must not block the request.
  pool
    .query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id])
    .catch(() => undefined);

  return { userId: row.user_id, plan: row.plan, keyId: row.id };
}

export interface CreatedUser {
  userId: string;
  apiKey: string;
  /** Hint shown to the dashboard; not a hard contract. */
  message: string;
}

/**
 * Create a brand-new user (defaulting to 'free' plan) and mint their first
 * API key. The plaintext key is returned exactly once — store it client-side
 * immediately. `email` is unique; double-signup with the same email returns
 * an error rather than a fresh key.
 */
export async function createUser(
  pool: PgPoolLike,
  email: string,
  opts: { name?: string; plan?: string } = {}
): Promise<CreatedUser> {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!isValidEmail(cleanEmail)) {
    throw new AuthError("invalid_email", 400);
  }
  const plan = opts.plan ?? "free";

  const userRes = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, plan)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [cleanEmail, opts.name ?? null, plan]
  );
  if (userRes.rows.length === 0) {
    throw new AuthError("email_already_registered", 409);
  }
  const userId = userRes.rows[0].id;

  const { key, hash, prefix } = generateApiKey();
  await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, 'default')`,
    [userId, hash, prefix]
  );

  return {
    userId,
    apiKey: key,
    message: "Save this key. It will not be shown again.",
  };
}

export interface CreatedKey {
  keyId: string;
  apiKey: string;
  name: string;
}

/**
 * Mint an additional API key for an existing user. Caller is responsible
 * for plan-cap enforcement (max_api_keys) before invoking this.
 */
export async function createAdditionalKey(
  pool: PgPoolLike,
  userId: string,
  name = "default"
): Promise<CreatedKey> {
  const { key, hash, prefix } = generateApiKey();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, hash, prefix, name]
  );
  return { keyId: res.rows[0].id, apiKey: key, name };
}

/**
 * Soft-delete an API key (sets `revoked_at`). Refuses to revoke a key the
 * caller doesn't own, and refuses to revoke the key the caller is currently
 * authenticated with — clients should mint a replacement first.
 */
export async function revokeKey(
  pool: PgPoolLike,
  keyId: string,
  userId: string,
  currentKeyId: string
): Promise<boolean> {
  if (keyId === currentKeyId) {
    throw new AuthError("cannot_revoke_current_key", 400);
  }
  const res = await pool.query(
    `UPDATE api_keys
     SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [keyId, userId]
  );
  return (res.rowCount ?? 0) > 0;
}

export interface KeyListing {
  id: string;
  prefix: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** Returns all active keys for a user. Never includes the hash or full key. */
export async function listKeys(
  pool: PgPoolLike,
  userId: string
): Promise<KeyListing[]> {
  const res = await pool.query<{
    id: string;
    key_prefix: string;
    name: string;
    created_at: Date;
    last_used_at: Date | null;
    expires_at: Date | null;
  }>(
    `SELECT id, key_prefix, name, created_at, last_used_at, expires_at
     FROM api_keys
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );
  return res.rows.map((r) => ({
    id: r.id,
    prefix: r.key_prefix,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
  }));
}

export interface UserInfo {
  userId: string;
  email: string;
  name: string | null;
  plan: string;
  createdAt: string;
}

/** Fetch the calling user's profile. */
export async function getUser(
  pool: PgPoolLike,
  userId: string
): Promise<UserInfo | null> {
  const res = await pool.query<{
    id: string;
    email: string;
    name: string | null;
    plan: string;
    created_at: Date;
  }>(
    `SELECT id, email, name, plan, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    userId: r.id,
    email: r.email,
    name: r.name,
    plan: r.plan,
    createdAt: r.created_at.toISOString(),
  };
}

export interface PlanLimits {
  plan: string;
  maxAgents: number;
  maxMessagesPerDay: number;
  maxThreads: number;
  maxPayloadBytes: number;
  maxApiKeys: number;
  retentionDays: number;
}

/** Resolve the hard caps for a plan. Returns null when plan is unknown. */
export async function getPlanLimits(
  pool: PgPoolLike,
  plan: string
): Promise<PlanLimits | null> {
  const res = await pool.query<{
    plan: string;
    max_agents: number;
    max_messages_per_day: number;
    max_threads: number;
    max_payload_bytes: number;
    max_api_keys: number;
    retention_days: number;
  }>(
    `SELECT plan, max_agents, max_messages_per_day, max_threads,
            max_payload_bytes, max_api_keys, retention_days
     FROM plan_limits WHERE plan = $1`,
    [plan]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    plan: r.plan,
    maxAgents: r.max_agents,
    maxMessagesPerDay: r.max_messages_per_day,
    maxThreads: r.max_threads,
    maxPayloadBytes: r.max_payload_bytes,
    maxApiKeys: r.max_api_keys,
    retentionDays: r.retention_days,
  };
}

export class AuthError extends Error {
  constructor(public code: string, public status = 401) {
    super(code);
    this.name = "AuthError";
  }
}

// Deliberately permissive — RFC 5321 says lots of things are legal. We only
// reject obviously broken input ("", missing @, internal whitespace).
function isValidEmail(s: string): boolean {
  if (!s || /\s/.test(s)) return false;
  const at = s.indexOf("@");
  return at > 0 && at < s.length - 1 && s.lastIndexOf("@") === at;
}

// ============================================================================
// GitHub OAuth + JWT session
// ============================================================================

export interface GitHubProfile {
  githubId: number;
  githubLogin: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface FindOrCreateResult {
  userId: string;
  apiKey?: string;
  isNew: boolean;
}

/**
 * Resolve a GitHub OAuth user to one of ours, creating a new account on
 * first login. The match order is intentional:
 *
 *   1. By github_id   — stable across GitHub username renames.
 *   2. By email       — links a pre-existing email-signup account to GitHub.
 *   3. New row        — registers the user and mints their default API key.
 *
 * Only step 3 returns `apiKey` (in plaintext, exactly once). Existing users
 * coming back through GitHub don't get a fresh key — they manage keys from
 * the dashboard via `/auth/keys`.
 */
export async function findOrCreateGitHubUser(
  pool: PgPoolLike,
  profile: GitHubProfile
): Promise<FindOrCreateResult> {
  // 1. Lookup by github_id.
  const byGh = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE github_id = $1 LIMIT 1`,
    [profile.githubId]
  );
  if (byGh.rows.length > 0) {
    // Refresh the cached login + avatar in case they changed on GitHub.
    await pool.query(
      `UPDATE users
         SET github_login = $2,
             avatar_url   = $3,
             updated_at   = NOW()
       WHERE id = $1`,
      [byGh.rows[0].id, profile.githubLogin, profile.avatarUrl]
    );
    return { userId: byGh.rows[0].id, isNew: false };
  }

  // 2. Lookup by email — links an email-only account to GitHub.
  const byEmail = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    [profile.email.toLowerCase()]
  );
  if (byEmail.rows.length > 0) {
    await pool.query(
      `UPDATE users
         SET github_id    = $2,
             github_login = $3,
             avatar_url   = $4,
             updated_at   = NOW()
       WHERE id = $1`,
      [
        byEmail.rows[0].id,
        profile.githubId,
        profile.githubLogin,
        profile.avatarUrl,
      ]
    );
    return { userId: byEmail.rows[0].id, isNew: false };
  }

  // 3. New user.
  const created = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, plan, github_id, github_login, avatar_url)
     VALUES ($1, $2, 'free', $3, $4, $5)
     RETURNING id`,
    [
      profile.email.toLowerCase(),
      profile.name,
      profile.githubId,
      profile.githubLogin,
      profile.avatarUrl,
    ]
  );
  const userId = created.rows[0].id;

  const { key, hash, prefix } = generateApiKey();
  await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, 'default')`,
    [userId, hash, prefix]
  );
  return { userId, apiKey: key, isNew: true };
}

export interface SessionPayload {
  userId: string;
  githubLogin?: string;
}

/**
 * Mint a 7-day JWT session token. Used for the dashboard only — NOT for
 * API access (that's `sk_live_*` keys). The two are intentionally separate
 * trust boundaries: a leaked session lets someone use the dashboard until
 * the JWT expires; a leaked API key gives full agent/message access until
 * it's revoked.
 */
export function signSession(payload: SessionPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

export function verifySession(
  token: string,
  secret: string
): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as SessionPayload & {
      iat?: number;
      exp?: number;
    };
    return { userId: decoded.userId, githubLogin: decoded.githubLogin };
  } catch {
    return null;
  }
}

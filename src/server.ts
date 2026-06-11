#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { createStorage, Storage } from "./storage";
import { Compressor, NoopCompressor } from "./compression";
import { assembleContext } from "./context";
import { readEnv } from "./env";
import { logger, createHttpLogger } from "./logger";
import {
  createRateLimiter,
  RateLimiterHandle,
  RateLimitConfig,
} from "./ratelimit";
import {
  cloudAuth,
  enforceAgentCap,
  enforceMessageCap,
  recordMessageSent,
} from "./cloud/middleware";
import {
  createUser,
  createAdditionalKey,
  revokeKey,
  listKeys,
  getUser,
  getPlanLimits,
  PgPoolLike,
  AuthError,
  findOrCreateGitHubUser,
  signSession,
  verifySession,
  UPGRADE_URL,
  CircuitBreaker,
} from "./cloud/auth";
import { recordAudit, getAuditTrail } from "./cloud/audit";
import { PostgresStorage } from "./storage/postgres";
import {
  AgentAddress,
  AgentCard,
  AgentCardSkill,
  ContextFrame,
  Message,
  ParticipantRole,
  Thread,
} from "./types";

const DEFAULT_CLOUD_RATE_LIMITS: RateLimitConfig = {
  maxAgentsPerIp: 10,
  maxMessagesPerDay: 500,
  maxRequestsPerMinute: 60,
};

const DEFAULT_CLOUD_CORS_ORIGINS = [
  // Live marketing site + legacy alias
  "https://agentmailbox.vercel.app",
  "https://freqooo.vercel.app",
  // Dev origin
  "http://localhost:5173",
  // Legacy .com placeholders kept for backward compatibility with any
  // references that pre-date the .vercel.app rename.
  "https://dashboard.agentsmcp.com",
  "https://agentsmcp.com",
];

/** Parse a query-string integer with a guaranteed finite fallback. */
function parseQueryInt(raw: unknown, def: number, min: number, max: number): number {
  const n = Number(raw ?? def);
  return Number.isFinite(n) ? Math.min(Math.max(min, n), max) : def;
}

/**
 * Wrap an async route handler so rejected promises propagate to the Express
 * error middleware instead of becoming unhandled rejections. Existing routes
 * use explicit try/catch + next(e); prefer this wrapper for new routes.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * True when `url` is a plain http://localhost or http://127.0.0.1 URL with no
 * userinfo and no embedded credentials. Required to prevent /auth/github
 * being abused as an open redirect via the cli_redirect param.
 */
export function isSafeLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Construct a loopback callback URL with a failure code. Used when CLI OAuth fails. */
function buildCliFailureUrl(
  cliRedirect: string,
  code: string,
  cliState: string | null
): string {
  const u = new URL(cliRedirect);
  u.searchParams.set("error", code);
  if (cliState) u.searchParams.set("state", cliState);
  return u.toString();
}

let cachedPackageVersion: string | null = null;
function getPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8")
    ) as { version?: string };
    cachedPackageVersion = pkg.version ?? "unknown";
  } catch {
    cachedPackageVersion = "unknown";
  }
  return cachedPackageVersion;
}

function getBaseUrl(req: Request): string {
  const fromEnv = readEnv("AGENTSMCP_BASE_URL", "AGENTMAILBOX_BASE_URL");
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

const SERVER_SKILLS: AgentCardSkill[] = [
  {
    id: "send-message",
    name: "Send Message",
    description:
      "Send a message to another agent with optional CC/BCC recipients and context snapshot",
    inputSchema: {
      type: "object",
      required: ["from", "to", "payload"],
      properties: {
        from: { type: "string", minLength: 1 },
        to: { type: "string", minLength: 1 },
        payload: {},
        contextSnapshot: { type: "object", additionalProperties: true },
        threadId: { type: "string" },
        cc: { type: "array", items: { type: "string", minLength: 1 } },
        bcc: { type: "array", items: { type: "string", minLength: 1 } },
        replyTo: { type: "string", minLength: 1 },
      },
    },
    outputSchema: {
      type: "object",
      required: ["messageId", "threadId", "deliveredTo"],
      properties: {
        messageId: { type: "string" },
        threadId: { type: "string" },
        deliveredTo: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    id: "receive-messages",
    name: "Receive Messages",
    description:
      "Get unread messages with full thread context (snapshot, summary, recent messages)",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      required: ["messages"],
      properties: {
        messages: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    id: "sync-thread",
    name: "Sync Thread",
    description: "Rejoin a thread and get the full assembled context frame",
    inputSchema: {
      type: "object",
      required: ["threadId"],
      properties: { threadId: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      required: ["context"],
      properties: { context: { type: "object" } },
    },
  },
  {
    id: "reply-all",
    name: "Reply All",
    description: "Reply to every visible participant on a thread",
    inputSchema: {
      type: "object",
      required: ["from", "threadId", "payload"],
      properties: {
        from: { type: "string", minLength: 1 },
        threadId: { type: "string", minLength: 1 },
        payload: {},
        contextSnapshot: { type: "object", additionalProperties: true },
      },
    },
    outputSchema: {
      type: "object",
      required: ["messageId", "threadId", "deliveredTo"],
      properties: {
        messageId: { type: "string" },
        threadId: { type: "string" },
        deliveredTo: { type: "array", items: { type: "string" } },
      },
    },
  },
];

function buildServerCard(baseUrl: string, authRequired: boolean): AgentCard {
  return {
    name: "AgentMailbox",
    description:
      "Context-sync protocol for AI agents. Durable threads with cold-restart, context compression, and email-like semantics (TO/CC/BCC/ReplyAll).",
    url: baseUrl,
    version: getPackageVersion(),
    capabilities: {
      messaging: true,
      threading: true,
      contextCompression: true,
      coldRestart: true,
      multiAgent: true,
    },
    skills: SERVER_SKILLS,
    provider: {
      organization: "AgentMailbox",
      url: "https://github.com/RagavRida/agentsmcp",
    },
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
    authentication: authRequired ? "required" : "none",
  };
}

const RegisterSchema = z.object({
  agentId: z.string().min(1),
});

const SendSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  payload: z.unknown(),
  contextSnapshot: z.record(z.unknown()).optional(),
  threadId: z.string().optional(),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
  replyTo: z.string().min(1).optional(),
});

const ReplyAllSchema = z.object({
  from: z.string().min(1),
  threadId: z.string().min(1),
  payload: z.unknown(),
  contextSnapshot: z.record(z.unknown()).optional(),
});

const MarkReadSchema = z.object({
  threadId: z.string().min(1),
});

function stripBccFromMessage(m: Message, requester: AgentAddress): Message {
  if (m.from === requester) return m;
  if (!m.bcc || m.bcc.length === 0) return m;
  const { bcc: _bcc, ...rest } = m;
  return rest;
}

function stripBccFromMessages(
  messages: Message[],
  requester: AgentAddress
): Message[] {
  return messages.map((m) => stripBccFromMessage(m, requester));
}

function stripBccFromFrame(
  frame: ContextFrame,
  requester: AgentAddress
): ContextFrame {
  const stripped: ContextFrame = { ...frame };
  if (frame.from !== requester && frame.bcc) delete stripped.bcc;
  stripped.context = {
    ...frame.context,
    recentMessages: stripBccFromMessages(frame.context.recentMessages, requester),
  };
  return stripped;
}

function stripBccFromThread(t: Thread, requester: AgentAddress): Thread {
  return {
    ...t,
    silentParticipants: requester && t.silentParticipants.includes(requester)
      ? t.silentParticipants
      : [],
    messages: stripBccFromMessages(t.messages, requester),
  };
}

function bearerMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CreateServerOptions {
  apiKey?: string;
  /**
   * Compressor used to fold older messages into a structured summary.
   * Defaults to {@link NoopCompressor} — keeps zero-config installs
   * working without any LLM dependency.
   */
  compressor?: Compressor;
  /**
   * Compress only once this many older (beyond the verbatim window)
   * messages have accumulated since the last summary. Defaults to 20.
   */
  compressionThreshold?: number;
  /**
   * Enable hosted-tier behaviour: trust-proxy, CORS, per-IP/per-agent rate
   * limits, and the /usage/:identifier endpoint. Defaults to the value of
   * the `CLOUD_MODE` env var. Self-hosted users leave this off.
   */
  cloudMode?: boolean;
  /** Override the default cloud-tier limits when cloudMode is on. */
  rateLimits?: Partial<RateLimitConfig>;
  /** Override the default cloud-tier CORS origins. */
  corsOrigins?: string[];
}

export interface CreateServerResult {
  app: express.Express;
  storage: Storage;
  ready: Promise<void>;
  rateLimiter?: RateLimiterHandle;
}

export function createServer(
  dbPath = "agentmailbox.db",
  opts: CreateServerOptions = {}
): CreateServerResult {
  const storage = createStorage(dbPath);
  const ready = storage.init();

  const apiKey =
    opts.apiKey ?? readEnv("AGENTSMCP_API_KEY", "AGENTMAILBOX_API_KEY") ?? "";
  const compressor = opts.compressor ?? new NoopCompressor();
  const compressionThreshold = opts.compressionThreshold;

  const cloudMode =
    opts.cloudMode ??
    ((readEnv("CLOUD_MODE", "AGENTSMCP_CLOUD_MODE") ?? "")
      .toLowerCase()
      .match(/^(1|true|yes|on)$/) !== null);

  const app = express();
  let cloudPool: PgPoolLike | null = null;

  if (cloudMode) {
    // App Runner / any HTTPS-fronted load balancer forwards client IP via
    // X-Forwarded-For. Required for the rate limiter to see real client IPs.
    app.set("trust proxy", true);

    app.use(
      cors({
        origin: opts.corsOrigins ?? DEFAULT_CLOUD_CORS_ORIGINS,
        credentials: true,
      })
    );
  }

  app.use(express.json({ limit: "10mb" }));

  // Structured request logging (pino-http). `req.log` is always attached so
  // any handler can emit request-correlated logs; automatic per-request
  // completion lines are emitted only in cloudMode to keep self-hosted
  // installs quiet by default.
  app.use(createHttpLogger({ autoLogging: cloudMode }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Agent Cards (A2A v1.0). Public discovery — no auth, per spec.
  app.get("/.well-known/agent-card.json", (req: Request, res: Response) => {
    return res.status(200).json(buildServerCard(getBaseUrl(req), Boolean(apiKey)));
  });

  app.get(
    "/.well-known/agent-card/:agentId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agentId = req.params.agentId;
        const agent = await storage.getAgent(agentId);
        if (!agent) return res.status(404).json({ error: "agent not found" });

        const baseUrl = getBaseUrl(req);
        const mailbox = await storage.getMailbox(agentId);
        const card: AgentCard = {
          name: agentId,
          description: `Registered agent on this AgentMailbox instance (${mailbox.threads.length} thread(s)).`,
          url: `${baseUrl}/mailbox/${encodeURIComponent(agentId)}`,
          version: getPackageVersion(),
          capabilities: {
            messaging: true,
            threading: true,
            coldRestart: true,
          },
          provider: {
            organization: "AgentMailbox",
            url: "https://github.com/RagavRida/agentsmcp",
          },
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
          },
          authentication: apiKey ? "required" : "none",
          agentId,
          createdAt: agent.createdAt,
          threadCount: mailbox.threads.length,
          unreadCount: mailbox.unreadCount,
          endpoints: {
            mailbox: `${baseUrl}/mailbox/${encodeURIComponent(agentId)}`,
            unread: `${baseUrl}/mailbox/${encodeURIComponent(agentId)}/unread`,
            markRead: `${baseUrl}/mailbox/${encodeURIComponent(agentId)}/read`,
          },
        };
        return res.status(200).json(card);
      } catch (e) {
        next(e);
      }
    }
  );

  const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    if (!apiKey) return next();
    if (req.path === "/health") return next();
    const header = req.header("authorization") ?? "";
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const token = header.slice(prefix.length);
    if (!bearerMatches(token, apiKey)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  };
  app.use(requireApiKey);

  // Cloud-tier rate limiting. Spec: skip entirely when AGENTSMCP_API_KEY is
  // set (self-hosted operator) — they're past the soft caps by definition.
  let rateLimiter: RateLimiterHandle | undefined;
  if (cloudMode && !apiKey) {
    rateLimiter = createRateLimiter({
      ...DEFAULT_CLOUD_RATE_LIMITS,
      ...opts.rateLimits,
    });
    app.use(rateLimiter.middleware);
  }

  // GET /usage/:identifier — current soft-limit usage. Mounted only when
  // the limiter is active so /usage isn't exposed on self-hosted deploys.
  if (rateLimiter) {
    app.get("/usage/:identifier", (req: Request, res: Response) => {
      return res.status(200).json(rateLimiter!.getUsage(req.params.identifier));
    });
  }

  // ---------- Cloud-tier multi-tenant auth ----------
  //
  // When CLOUD_MODE is on AND we have a Postgres-backed storage (the only
  // adapter that can host multi-tenant data today), mount the per-user
  // Bearer auth layer. Single-key self-hosted users (`AGENTSMCP_API_KEY`
  // set) skip this entirely — they're already past the trust boundary.
  if (cloudMode && !apiKey && storage instanceof PostgresStorage) {
    const pgStorage = storage;
    // Lazy: pg.Pool isn't constructed until the first request that needs
    // it, so createServer() can stay synchronous.
    let resolvedPool: PgPoolLike | null = null;
    const getPool = async (): Promise<PgPoolLike> => {
      if (!resolvedPool) {
        resolvedPool = (await pgStorage.getRawPool()) as unknown as PgPoolLike;
      }
      return resolvedPool;
    };
    cloudPool = {
      query: async (text, params) => (await getPool()).query(text, params),
      connect: async () => (await getPool()).connect(),
    };

    // /auth/register rate limiter: max 10 registrations per IP per hour.
    // In-memory only — resets on restart. Sufficient to block scripted
    // account-factory attacks without a Redis dependency.
    const registerAttempts = new Map<string, { count: number; windowStart: number }>();
    const REGISTER_WINDOW_MS = 60 * 60 * 1000; // 1 hour
    const REGISTER_MAX = 10;
    const registerRateLimit = (req: Request, res: Response, next: NextFunction) => {
      const ip = (req.ip ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
      const now = Date.now();
      const entry = registerAttempts.get(ip);
      if (!entry || now - entry.windowStart > REGISTER_WINDOW_MS) {
        registerAttempts.set(ip, { count: 1, windowStart: now });
        return next();
      }
      if (entry.count >= REGISTER_MAX) {
        return res.status(429).json({
          error: "rate_limit",
          message: `Max ${REGISTER_MAX} registrations per IP per hour`,
          retryAfterMs: REGISTER_WINDOW_MS - (now - entry.windowStart),
        });
      }
      entry.count += 1;
      return next();
    };

    // /auth/register is intentionally registered BEFORE cloudAuth so signup
    // doesn't require a key. cloudAuth's skip-list also includes it as
    // defence-in-depth.
    app.post("/auth/register", registerRateLimit, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { email, name } = (req.body ?? {}) as {
          email?: string;
          name?: string;
        };
        if (!email) return res.status(400).json({ error: "email_required" });
        const created = await createUser(cloudPool!, email, { name });
        return res.status(201).json(created);
      } catch (e) {
        if (e instanceof AuthError) {
          return res.status(e.status).json({ error: e.code });
        }
        next(e);
      }
    });

    // ---------- GitHub OAuth (also pre-auth: no Bearer required) ----------
    const githubClientId = process.env.GITHUB_CLIENT_ID;
    const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
    const githubCallbackUrl =
      process.env.GITHUB_CALLBACK_URL ??
      "https://hdnxa5c8yr.us-east-1.awsapprunner.com/auth/github/callback";
    const frontendUrl =
      process.env.FRONTEND_URL ?? "https://agentmailbox.vercel.app";
    const sessionSecret = process.env.SESSION_SECRET;
    const githubReady =
      Boolean(githubClientId) &&
      Boolean(githubClientSecret) &&
      Boolean(sessionSecret);

    // Circuit breaker around GitHub's token-exchange endpoint. After 5
    // consecutive failures the callback fails fast for 30s instead of
    // stacking up requests against a degraded external dependency.
    const githubTokenBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
    });

    if (!githubReady) {
      logger.warn(
        "GitHub OAuth env vars missing; /auth/github routes will 503"
      );
    }

    // GET /auth/github — kick off OAuth. State cookie defends against CSRF
    // on the callback (verified inside /auth/github/callback below).
    //
    // Optional CLI-loopback flow:
    //   ?cli_redirect=http://127.0.0.1:PORT/callback
    //   ?cli_label=alice-laptop   (used as the new API key's display name)
    //   ?cli_state=...            (echoed back to the CLI for its own CSRF check)
    // When cli_redirect is present and points to a localhost address, the
    // callback redirects there with the freshly-minted apiKey instead of the
    // dashboard. Required by `agentsmcp init` for browser-based login.
    app.get("/auth/github", (req: Request, res: Response) => {
      if (!githubReady) {
        return res.status(503).json({ error: "github_oauth_not_configured" });
      }
      const cliRedirect = (req.query.cli_redirect as string | undefined)?.trim();
      const cliLabel = (req.query.cli_label as string | undefined)?.slice(0, 64);
      const cliState = (req.query.cli_state as string | undefined)?.slice(0, 128);

      if (cliRedirect && !isSafeLoopback(cliRedirect)) {
        return res
          .status(400)
          .json({ error: "cli_redirect must be a http://localhost or http://127.0.0.1 URL" });
      }

      const rawState = randomBytes(24).toString("hex");
      // GitHub echoes back `state` verbatim; we encode the CLI metadata into
      // it so the callback can recover the loopback URL without trusting a
      // cross-host cookie (which wouldn't reach a localhost callback anyway).
      const githubState = cliRedirect
        ? "cli." +
          Buffer.from(
            JSON.stringify({ s: rawState, c: cliRedirect, l: cliLabel ?? null, cs: cliState ?? null })
          ).toString("base64url")
        : rawState;

      // Cookie still stores the raw state. The CSRF check happens against
      // this cookie regardless of whether we used CLI mode.
      res.setHeader(
        "Set-Cookie",
        `ghoauth_state=${rawState}; Max-Age=600; Path=/auth/github; HttpOnly; Secure; SameSite=Lax`
      );

      const params = new URLSearchParams({
        client_id: githubClientId!,
        redirect_uri: githubCallbackUrl,
        scope: "read:user user:email",
        state: githubState,
        allow_signup: "true",
      });
      return res.redirect(
        `https://github.com/login/oauth/authorize?${params.toString()}`
      );
    });

    // GET /auth/github/callback — exchange code for token, look up user,
    // sign a JWT, redirect to frontend.
    app.get(
      "/auth/github/callback",
      async (req: Request, res: Response, next: NextFunction) => {
        if (!githubReady) {
          return res.status(503).json({ error: "github_oauth_not_configured" });
        }
        try {
          const { code, state, error } = req.query as {
            code?: string;
            state?: string;
            error?: string;
          };
          if (error) {
            return res.redirect(`${frontendUrl}/?auth_error=${encodeURIComponent(error)}`);
          }
          if (!code) {
            return res.redirect(`${frontendUrl}/?auth_error=missing_code`);
          }

          // Decode the CLI metadata if present. Format: "cli." + base64url(JSON).
          // Returns the raw CSRF state for the cookie comparison plus the
          // optional CLI loopback URL + label + cli-side state.
          let rawState: string | undefined = state;
          let cliRedirect: string | null = null;
          let cliLabel: string | null = null;
          let cliState: string | null = null;
          if (state && state.startsWith("cli.")) {
            try {
              const decoded = JSON.parse(
                Buffer.from(state.slice(4), "base64url").toString("utf8")
              ) as { s?: string; c?: string; l?: string | null; cs?: string | null };
              if (typeof decoded.s === "string") rawState = decoded.s;
              if (typeof decoded.c === "string" && isSafeLoopback(decoded.c)) {
                cliRedirect = decoded.c;
              }
              if (typeof decoded.l === "string") cliLabel = decoded.l;
              if (typeof decoded.cs === "string") cliState = decoded.cs;
            } catch {
              return res.redirect(`${frontendUrl}/?auth_error=bad_state`);
            }
          }

          // CSRF check: state cookie must match the (decoded) raw state.
          const cookieHeader = req.headers.cookie ?? "";
          const stateCookie = cookieHeader
            .split(";")
            .map((c) => c.trim())
            .find((c) => c.startsWith("ghoauth_state="))
            ?.slice("ghoauth_state=".length);
          if (!stateCookie || !rawState || stateCookie !== rawState) {
            const failUrl = cliRedirect
              ? buildCliFailureUrl(cliRedirect, "state_mismatch", cliState)
              : `${frontendUrl}/?auth_error=state_mismatch`;
            return res.redirect(failUrl);
          }

          // Exchange code → access_token. Guarded by a circuit breaker and
          // a 10s timeout so a degraded GitHub fails fast instead of piling
          // up hanging requests.
          let tokenJson: { access_token?: string; error?: string };
          try {
            tokenJson = await githubTokenBreaker.exec(async () => {
              const tokenRes = await fetch(
                "https://github.com/login/oauth/access_token",
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "User-Agent": "agentsmcp",
                  },
                  body: JSON.stringify({
                    client_id: githubClientId,
                    client_secret: githubClientSecret,
                    code,
                    redirect_uri: githubCallbackUrl,
                  }),
                  signal: AbortSignal.timeout(10_000),
                }
              );
              if (!tokenRes.ok) {
                throw new Error(
                  `github token exchange failed with status ${tokenRes.status}`
                );
              }
              return (await tokenRes.json()) as {
                access_token?: string;
                error?: string;
              };
            });
          } catch (err) {
            req.log.warn({ err }, "github token exchange unavailable");
            const failUrl = cliRedirect
              ? buildCliFailureUrl(cliRedirect, "token_exchange_failed", cliState)
              : `${frontendUrl}/?auth_error=token_exchange_failed`;
            return res.redirect(failUrl);
          }
          if (!tokenJson.access_token) {
            return res.redirect(
              `${frontendUrl}/?auth_error=${encodeURIComponent(tokenJson.error ?? "token_exchange_failed")}`
            );
          }
          const accessToken = tokenJson.access_token;

          // Fetch profile + email in parallel.
          const ghHeaders = {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "agentsmcp",
            Accept: "application/vnd.github+json",
          };
          const [userRes, emailsRes] = await Promise.all([
            fetch("https://api.github.com/user", { headers: ghHeaders }),
            fetch("https://api.github.com/user/emails", { headers: ghHeaders }),
          ]);
          if (!userRes.ok) {
            return res.redirect(`${frontendUrl}/?auth_error=gh_user_fetch_failed`);
          }
          const ghUser = (await userRes.json()) as {
            id: number;
            login: string;
            name?: string;
            email?: string;
            avatar_url?: string;
          };
          let primaryEmail: string | undefined;
          if (emailsRes.ok) {
            const emails = (await emailsRes.json()) as Array<{
              email: string;
              primary: boolean;
              verified: boolean;
            }>;
            primaryEmail =
              emails.find((e) => e.primary && e.verified)?.email ??
              emails.find((e) => e.primary)?.email;
          }
          primaryEmail = primaryEmail ?? ghUser.email ?? undefined;
          if (!primaryEmail) {
            return res.redirect(
              `${frontendUrl}/?auth_error=no_verified_email`
            );
          }

          const { userId, apiKey: signupKey, isNew } = await findOrCreateGitHubUser(
            cloudPool!,
            {
              githubId: ghUser.id,
              githubLogin: ghUser.login,
              email: primaryEmail,
              name: ghUser.name ?? null,
              avatarUrl: ghUser.avatar_url ?? null,
            }
          );

          const token = signSession({ userId, githubLogin: ghUser.login }, sessionSecret!);

          // Record auth login event
          recordAudit(cloudPool!, {
            userId,
            action: "auth.login",
            resourceType: "user",
            resourceId: userId,
            metadata: { method: "github", isNew, cli: Boolean(cliRedirect) },
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
          });

          // Clear the state cookie now that we've validated it.
          res.setHeader(
            "Set-Cookie",
            "ghoauth_state=; Max-Age=0; Path=/auth/github; HttpOnly; Secure; SameSite=Lax"
          );

          // CLI loopback flow: mint a labeled API key (for returning users) and
          // redirect to the local callback. Each CLI install gets its own key
          // so it can be revoked independently.
          if (cliRedirect) {
            let cliApiKey = signupKey;
            if (!cliApiKey) {
              try {
                const minted = await createAdditionalKey(
                  cloudPool!,
                  userId,
                  cliLabel ? `cli:${cliLabel}` : "cli"
                );
                cliApiKey = minted.apiKey;
                recordAudit(cloudPool!, {
                  userId,
                  action: "key.create",
                  resourceType: "api_key",
                  resourceId: minted.keyId,
                  metadata: { name: minted.name, via: "cli" },
                  ipAddress: req.ip,
                  userAgent: req.headers["user-agent"] ?? null,
                });
              } catch (e) {
                const code =
                  e instanceof AuthError ? e.code : "key_create_failed";
                return res.redirect(buildCliFailureUrl(cliRedirect, code, cliState));
              }
            }
            const cliUrl = new URL(cliRedirect);
            cliUrl.searchParams.set("apiKey", cliApiKey!);
            if (cliState) cliUrl.searchParams.set("state", cliState);
            cliUrl.searchParams.set("githubLogin", ghUser.login);
            return res.redirect(cliUrl.toString());
          }

          const dashboardParams = new URLSearchParams({ token });
          // Only surface the freshly-minted API key on first-time signup so
          // the dashboard can show the one-time copy banner. Returning users
          // see their key list via /auth/keys after sign-in.
          if (isNew && signupKey) dashboardParams.set("apiKey", signupKey);
          return res.redirect(
            `${frontendUrl}/dashboard?${dashboardParams.toString()}`
          );
        } catch (e) {
          next(e);
        }
      }
    );

    // GET /auth/session — validate a JWT, return user profile + keys + usage.
    // Authenticated by JWT (NOT a sk_live_ key) so it can't be confused with
    // the API-key auth used everywhere else.
    app.get("/auth/session", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!sessionSecret) {
          return res.status(503).json({ error: "session_not_configured" });
        }
        const header = req.header("authorization") ?? "";
        if (!header.startsWith("Bearer ")) {
          return res.status(401).json({ error: "session_required" });
        }
        const token = header.slice("Bearer ".length).trim();
        const payload = verifySession(token, sessionSecret);
        if (!payload) {
          return res.status(401).json({ error: "session_expired" });
        }

        const user = await getUser(cloudPool!, payload.userId);
        if (!user) return res.status(404).json({ error: "user_not_found" });

        const limits = await getPlanLimits(cloudPool!, user.plan);
        const keys = await listKeys(cloudPool!, payload.userId);

        const counts = await cloudPool!.query<{
          agents: string;
          threads: string;
          msgs_today: string | null;
          github_login: string | null;
          avatar_url: string | null;
        }>(
          `SELECT
             (SELECT COUNT(*)::text FROM agents  WHERE user_id = $1) AS agents,
             (SELECT COUNT(*)::text FROM threads WHERE user_id = $1) AS threads,
             (SELECT count::text FROM usage_metrics
                WHERE user_id = $1
                  AND metric = 'messages_sent'
                  AND period_start = CURRENT_DATE) AS msgs_today,
             (SELECT github_login FROM users WHERE id = $1) AS github_login,
             (SELECT avatar_url   FROM users WHERE id = $1) AS avatar_url`,
          [payload.userId]
        );
        const row = counts.rows[0] ?? {
          agents: "0",
          threads: "0",
          msgs_today: null,
          github_login: null,
          avatar_url: null,
        };

        return res.status(200).json({
          user: {
            id: user.userId,
            email: user.email,
            name: user.name,
            plan: user.plan,
            githubLogin: row.github_login,
            avatarUrl: row.avatar_url,
            createdAt: user.createdAt,
          },
          keys,
          usage: {
            agents: Number(row.agents),
            maxAgents: limits?.maxAgents ?? null,
            threads: Number(row.threads),
            maxThreads: limits?.maxThreads ?? null,
            messagesToday: Number(row.msgs_today ?? 0),
            maxMessagesPerDay: limits?.maxMessagesPerDay ?? null,
          },
        });
      } catch (e) {
        next(e);
      }
    });

    // GET /auth/audit — fetch audit trail logs for the logged-in user.
    app.get("/auth/audit", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!sessionSecret) {
          return res.status(503).json({ error: "session_not_configured" });
        }
        const header = req.header("authorization") ?? "";
        if (!header.startsWith("Bearer ")) {
          return res.status(401).json({ error: "session_required" });
        }
        const token = header.slice("Bearer ".length).trim();
        const payload = verifySession(token, sessionSecret);
        if (!payload) {
          return res.status(401).json({ error: "session_expired" });
        }

        const rawLimit = Number(req.query.limit ?? 100);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 1000)) : 100;
        const logs = await getAuditTrail(cloudPool!, payload.userId, limit);
        return res.status(200).json({ logs });
      } catch (e) {
        next(e);
      }
    });

    // Mount the API-key auth AFTER the OAuth + session routes so those
    // stay pre-auth.
    const cloudOpts = { pool: cloudPool, sessionSecret };
    app.use(cloudAuth(cloudOpts));

    // /auth/me — caller's profile + current usage snapshot.
    app.get("/auth/me", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.userId) return res.status(401).json({ error: "invalid_api_key" });
        const user = await getUser(cloudPool!, req.userId);
        if (!user) return res.status(404).json({ error: "user_not_found" });
        const limits = await getPlanLimits(cloudPool!, user.plan);

        const counts = await cloudPool!.query<{
          agents: string;
          threads: string;
          msgs_today: string | null;
        }>(
          `SELECT
             (SELECT COUNT(*)::text FROM agents  WHERE user_id = $1) AS agents,
             (SELECT COUNT(*)::text FROM threads WHERE user_id = $1) AS threads,
             (SELECT count::text FROM usage_metrics
                WHERE user_id = $1
                  AND metric = 'messages_sent'
                  AND period_start = CURRENT_DATE) AS msgs_today`,
          [req.userId]
        );
        const row = counts.rows[0] ?? { agents: "0", threads: "0", msgs_today: null };
        return res.status(200).json({
          ...user,
          usage: {
            agents: Number(row.agents),
            maxAgents: limits?.maxAgents ?? null,
            threads: Number(row.threads),
            maxThreads: limits?.maxThreads ?? null,
            messagesToday: Number(row.msgs_today ?? 0),
            maxMessagesPerDay: limits?.maxMessagesPerDay ?? null,
          },
        });
      } catch (e) {
        next(e);
      }
    });

    // GET /auth/keys — list active keys (never returns the full key/hash).
    app.get("/auth/keys", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.userId) return res.status(401).json({ error: "invalid_api_key" });
        const keys = await listKeys(cloudPool!, req.userId);
        return res.status(200).json({ keys });
      } catch (e) {
        next(e);
      }
    });

    // POST /auth/keys — mint an additional key, capped at plan.max_api_keys.
    app.post("/auth/keys", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.userId || !req.planLimits) {
          return res.status(401).json({ error: "invalid_api_key" });
        }
        const { name } = (req.body ?? {}) as { name?: string };

        const existing = await listKeys(cloudPool!, req.userId);
        const cap = req.planLimits.maxApiKeys;
        if (cap >= 0 && existing.length >= cap) {
          return res.status(403).json({
            error: "plan_limit",
            resource: "api_keys",
            current: existing.length,
            limit: cap,
            upgrade: UPGRADE_URL,
          });
        }
        const created = await createAdditionalKey(cloudPool!, req.userId, name || "default");
        recordAudit(cloudPool!, {
          userId: req.userId,
          action: "key.create",
          resourceType: "api_key",
          resourceId: created.keyId,
          metadata: { name: created.name },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
        return res.status(201).json(created);
      } catch (e) {
        next(e);
      }
    });

    // DELETE /auth/keys/:keyId — revoke (soft delete). When authenticated via
    // API key, refuses to revoke the key being used. JWT sessions have no such
    // restriction since they don't use an API key for auth.
    app.delete("/auth/keys/:keyId", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.userId) {
          return res.status(401).json({ error: "invalid_api_key" });
        }
        // JWT session auth: apiKeyId is undefined — skip the self-revoke guard.
        const currentKeyId = req.apiKeyId ?? "__session__";
        const ok = await revokeKey(cloudPool!, req.params.keyId, req.userId, currentKeyId);
        if (!ok) return res.status(404).json({ error: "key_not_found" });
        recordAudit(cloudPool!, {
          userId: req.userId,
          action: "key.revoke",
          resourceType: "api_key",
          resourceId: req.params.keyId,
          metadata: { currentKeyId },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
        return res.status(200).json({ ok: true });
      } catch (e) {
        if (e instanceof AuthError) {
          return res.status(e.status).json({ error: e.code });
        }
        next(e);
      }
    });
  }

  // Helper: in CLOUD_MODE the auth middleware attaches a ScopedStorage as
  // `req.storage`; self-hosted requests fall back to the unscoped global.
  const storageFor = (req: Request): Storage => req.storage ?? storage;

  // Plan-cap middleware factory — only mounted when CLOUD_MODE is on and
  // the storage backend is Postgres. We build a lazy proxy pool so callers
  // don't depend on createServer being async.
  const buildLazyPool = (pgStorage: PostgresStorage): PgPoolLike => ({
    query: async (text: string, params?: unknown[]) =>
      (await pgStorage.getRawPool()).query(text, params),
    connect: async () => (await pgStorage.getRawPool()).connect(),
  });
  const planLazyPool =
    cloudMode && !apiKey && storage instanceof PostgresStorage
      ? buildLazyPool(storage)
      : null;
  const planCapAgents = planLazyPool
    ? enforceAgentCap({ pool: planLazyPool })
    : (_req: Request, _res: Response, next: NextFunction) => next();
  const planCapMessages = planLazyPool
    ? enforceMessageCap({ pool: planLazyPool })
    : (_req: Request, _res: Response, next: NextFunction) => next();

  // POST /agents/register
  app.post("/agents/register", planCapAgents, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const s = storageFor(req);
      const existing = await s.getAgent(parsed.data.agentId);
      const agent = await s.registerAgent(parsed.data.agentId);
      if (req.userId) {
        recordAudit(cloudPool!, {
          userId: req.userId,
          agentId: agent.id,
          action: "agent.register",
          resourceType: "agent",
          resourceId: agent.id,
          metadata: { created: !existing },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
      }
      return res.status(201).json({
        agentId: agent.id,
        created: !existing,
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /messages/send
  app.post("/messages/send", planCapMessages, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SendSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const { from, to, payload, contextSnapshot, threadId, cc, bcc, replyTo } =
        parsed.data;
      const s = storageFor(req);

      await s.registerAgent(from);
      await s.registerAgent(to);
      for (const a of cc ?? []) await s.registerAgent(a);
      for (const a of bcc ?? []) await s.registerAgent(a);

      let thread: Thread | null = null;
      let threadCreated = false;
      if (threadId) {
        thread = await s.getThread(threadId);
        if (!thread) {
          return res.status(404).json({ error: `thread ${threadId} not found` });
        }
      } else {
        const visibleSet = [from, to, ...(cc ?? [])];
        thread = await s.getThreadByParticipantSet(visibleSet);
        if (!thread) {
          thread = await s.createThread(visibleSet, bcc ?? []);
          threadCreated = true;
        }
      }

      const message: Message = {
        id: uuidv4(),
        threadId: thread.id,
        from,
        to,
        payload,
        contextSnapshot: contextSnapshot ?? {},
        timestamp: Date.now(),
      };
      if (cc && cc.length > 0) message.cc = cc;
      if (bcc && bcc.length > 0) message.bcc = bcc;
      if (replyTo) message.replyTo = replyTo;

      await s.appendMessage(thread.id, message);

      if (req.userId) {
        if (threadCreated) {
          recordAudit(cloudPool!, {
            userId: req.userId,
            agentId: from,
            action: "thread.create",
            resourceType: "thread",
            resourceId: thread.id,
            metadata: { participants: [from, to, ...(cc ?? [])] },
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
          });
        }
        recordAudit(cloudPool!, {
          userId: req.userId,
          agentId: from,
          action: "message.send",
          resourceType: "message",
          resourceId: message.id,
          metadata: { threadId: thread.id, from, to, ccSize: cc?.length ?? 0, bccSize: bcc?.length ?? 0 },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
      }

      // Cloud-tier usage counter. Best-effort; failure here must not undo
      // the message that already landed.
      if (req.userId && storage instanceof PostgresStorage) {
        const pool = await storage.getRawPool();
        recordMessageSent(pool as unknown as PgPoolLike, req.userId).catch(
          (err) => req.log.error({ err }, "usage_metrics upsert failed")
        );
      }

      const deliveredTo = Array.from(
        new Set<AgentAddress>([to, ...(cc ?? []), ...(bcc ?? [])])
      ).filter((a) => a !== from);

      return res.status(200).json({
        messageId: message.id,
        threadId: thread.id,
        deliveredTo,
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /messages/reply-all
  app.post("/messages/reply-all", planCapMessages, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ReplyAllSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const { from, threadId, payload, contextSnapshot } = parsed.data;
      const s = storageFor(req);

      const thread = await s.getThread(threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });

      await s.registerAgent(from);

      const visible = thread.participants.filter((p) => p !== from);
      if (visible.length === 0) {
        return res
          .status(400)
          .json({ error: "no other visible participants to reply to" });
      }

      const [primary, ...rest] = visible;
      const message: Message = {
        id: uuidv4(),
        threadId,
        from,
        to: primary,
        payload,
        contextSnapshot: contextSnapshot ?? {},
        timestamp: Date.now(),
      };
      if (rest.length > 0) message.cc = rest;

      await s.appendMessage(threadId, message);

      if (req.userId) {
        recordAudit(cloudPool!, {
          userId: req.userId,
          agentId: from,
          action: "message.send",
          resourceType: "message",
          resourceId: message.id,
          metadata: { threadId, from, to: primary, ccSize: rest.length, type: "reply_all" },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
      }

      if (req.userId && storage instanceof PostgresStorage) {
        const pool = await storage.getRawPool();
        recordMessageSent(pool as unknown as PgPoolLike, req.userId).catch(
          (err) => req.log.error({ err }, "usage_metrics upsert failed")
        );
      }

      const deliveredTo = visible;
      return res.status(200).json({
        messageId: message.id,
        threadId,
        deliveredTo,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId?limit=N&offset=M
  app.get("/mailbox/:agentId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const s = storageFor(req);
      const limit = parseQueryInt(req.query.limit, 100, 1, 1000);
      const offset = parseQueryInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const mailbox = await s.getMailbox(agentId, { limit, offset });
      const threadsRaw = await Promise.all(
        mailbox.threads.map((tid) => s.getThread(tid))
      );
      const threads: Thread[] = threadsRaw
        .filter((t): t is Thread => t !== null)
        .map((t) => stripBccFromThread(t, agentId));
      return res.status(200).json({
        threads,
        unreadCount: mailbox.unreadCount,
        total: mailbox.total,
        limit,
        offset,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId/unread
  app.get("/mailbox/:agentId/unread", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const s = storageFor(req);
      const recentLimit = parseQueryInt(req.query.recent, 10, 1, 50);
      const unread = await s.getUnread(agentId);
      const frames: ContextFrame[] = await Promise.all(
        unread.map(async (m) => {
          const allMessages = await s.getMessages(m.threadId);
          const context = await assembleContext(allMessages, {
            threadId: m.threadId,
            storage: s,
            compressor,
            compressionThreshold,
            recentLimit,
          });
          const frame: ContextFrame = {
            id: m.id,
            threadId: m.threadId,
            from: m.from,
            to: m.to,
            timestamp: m.timestamp,
            payload: m.payload,
            context,
          };
          if (m.cc) frame.cc = m.cc;
          if (m.bcc) frame.bcc = m.bcc;
          if (m.replyTo) frame.replyTo = m.replyTo;
          return stripBccFromFrame(frame, agentId);
        })
      );
      if (req.userId && frames.length > 0) {
        recordAudit(cloudPool!, {
          userId: req.userId,
          agentId,
          action: "message.receive",
          resourceType: "agent",
          resourceId: agentId,
          metadata: { count: frames.length },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
      }
      return res.status(200).json({ messages: frames });
    } catch (e) {
      next(e);
    }
  });

  // POST /mailbox/:agentId/read
  app.post("/mailbox/:agentId/read", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const parsed = MarkReadSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      await storageFor(req).markRead(agentId, parsed.data.threadId);
      if (req.userId) {
        recordAudit(cloudPool!, {
          userId: req.userId,
          agentId,
          action: "message.read",
          resourceType: "thread",
          resourceId: parsed.data.threadId,
          metadata: { agentId },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // GET /threads/:threadId
  app.get("/threads/:threadId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const thread = await storageFor(req).getThread(req.params.threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });
      const requester = (req.query.as as string | undefined) ?? "";
      return res.status(200).json({ thread: stripBccFromThread(thread, requester) });
    } catch (e) {
      next(e);
    }
  });

  // GET /threads/:threadId/sync
  app.get("/threads/:threadId/sync", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const s = storageFor(req);
      const thread = await s.getThread(req.params.threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });
      const requester = (req.query.as as string | undefined) ?? "";
      const recentLimit = parseQueryInt(req.query.recent, 10, 1, 50);
      const ctx = await assembleContext(thread.messages, {
        threadId: thread.id,
        storage: s,
        compressor,
        compressionThreshold,
        recentLimit,
      });
      const responseContext: Record<string, unknown> = {
        snapshot: ctx.snapshot,
        threadSummary: ctx.threadSummary,
        recentMessages: stripBccFromMessages(ctx.recentMessages, requester),
        tokenCount: ctx.tokenCount,
      };
      if (ctx.threadSummaryStructured) {
        responseContext.threadSummaryStructured = ctx.threadSummaryStructured;
      }
      return res.status(200).json({ context: responseContext });
    } catch (e) {
      next(e);
    }
  });

  // GET /threads/:threadId/participants
  app.get("/threads/:threadId/participants", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const threadId = req.params.threadId;
      const s = storageFor(req);
      const thread = await s.getThread(threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });

      const requester = (req.query.as as string | undefined) ?? "";
      const roles = await s.getThreadParticipants(threadId);

      // Determine which BCC agents the requester can see.
      // Rule: requester sees a BCC participant iff requester is the sender of
      // any message that included that agent in BCC, OR requester IS that BCC agent.
      const messages = thread.messages;
      const bccVisibleToRequester = new Set<string>();
      for (const m of messages) {
        if (!m.bcc) continue;
        if (m.from === requester) {
          for (const a of m.bcc) bccVisibleToRequester.add(a);
        }
      }
      if (requester) bccVisibleToRequester.add(requester);

      const filtered: ParticipantRole[] = roles.filter((p) => {
        if (p.role !== "bcc") return true;
        return bccVisibleToRequester.has(p.agentId);
      });

      return res.status(200).json({ participants: filtered });
    } catch (e) {
      next(e);
    }
  });

  // ===================== Context Graph =====================

  const VALID_NODE_TYPES = new Set(["message", "file", "symbol", "decision", "task"]);

  // POST /mailbox/:agentId/graph/nodes — upsert a graph node
  app.post("/mailbox/:agentId/graph/nodes", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const { id, type, name, description, metadata } = req.body ?? {};
      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "id (string) is required" });
      }
      if (!type || !VALID_NODE_TYPES.has(type)) {
        return res.status(400).json({
          error: `type must be one of: ${[...VALID_NODE_TYPES].join(", ")}`,
        });
      }
      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "name (string) is required" });
      }
      if (metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) {
        return res.status(400).json({ error: "metadata must be a JSON object" });
      }
      await storageFor(req).upsertNode(agentId, {
        id,
        type,
        name,
        description: typeof description === "string" ? description : undefined,
        metadata: metadata ?? {},
      });
      return res.status(200).json({ ok: true, nodeId: id });
    } catch (e) {
      next(e);
    }
  });

  // POST /mailbox/:agentId/graph/edges — add a graph edge
  app.post("/mailbox/:agentId/graph/edges", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sourceId, targetId, type, weight } = req.body ?? {};
      if (!sourceId || typeof sourceId !== "string") {
        return res.status(400).json({ error: "sourceId (string) is required" });
      }
      if (!targetId || typeof targetId !== "string") {
        return res.status(400).json({ error: "targetId (string) is required" });
      }
      if (!type || typeof type !== "string") {
        return res.status(400).json({ error: "type (string) is required" });
      }
      const weightNum = weight !== undefined ? Number(weight) : 1.0;
      if (!Number.isFinite(weightNum) || weightNum <= 0) {
        return res.status(400).json({ error: "weight must be a positive finite number" });
      }
      await storageFor(req).addEdge({ sourceId, targetId, type, weight: weightNum });
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId/graph/query?q=...&limit=N&depth=D — keyword search + N-hop traversal
  app.get("/mailbox/:agentId/graph/query", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const q = (req.query.q as string | undefined) ?? "";
      if (!q) {
        return res.status(400).json({ error: "q query parameter is required" });
      }
      const limit = parseQueryInt(req.query.limit, 30, 1, 200);
      const depth = parseQueryInt(req.query.depth, 2, 1, 5);
      // Storage layer handles both limit and depth now
      const result = await storageFor(req).queryGraph(agentId, q, { limit, depth });
      return res.status(200).json(result);
    } catch (e) {
      next(e);
    }
  });

  // DELETE /mailbox/:agentId/graph/nodes/:nodeId
  app.delete("/mailbox/:agentId/graph/nodes/:nodeId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await storageFor(req).deleteNode(req.params.agentId, req.params.nodeId);
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // DELETE /mailbox/:agentId/graph/edges — body: { sourceId, targetId, type }
  app.delete("/mailbox/:agentId/graph/edges", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sourceId, targetId, type } = req.body ?? {};
      if (!sourceId || !targetId || !type) {
        return res.status(400).json({ error: "sourceId, targetId, and type are required" });
      }
      await storageFor(req).deleteEdge(sourceId, targetId, type);
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ===================== Git / Version Control =====================

  // POST /mailbox/:agentId/git/commit — snapshot current graph+index as a commit
  // Body: { message, branch?, keepLast? }
  app.post("/mailbox/:agentId/git/commit", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const { message, branch, keepLast } = (req.body ?? {}) as {
        message?: string; branch?: string; keepLast?: number;
      };
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "message (string) is required" });
      }
      const keepLastNum = keepLast !== undefined ? Number(keepLast) : undefined;
      if (keepLastNum !== undefined && (!Number.isFinite(keepLastNum) || keepLastNum < 1)) {
        return res.status(400).json({ error: "keepLast must be a positive integer" });
      }
      const commit = await storageFor(req).createCommit(agentId, message, {
        branch: branch ?? "main",
        keepLast: keepLastNum,
      });
      return res.status(201).json(commit);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 413) return res.status(413).json({ error: err.message });
      next(e);
    }
  });

  // DELETE /mailbox/:agentId/git/commits/:commitId
  app.delete("/mailbox/:agentId/git/commits/:commitId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await storageFor(req).deleteCommit(req.params.agentId, req.params.commitId);
      if (!deleted) return res.status(404).json({ error: "commit not found" });
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId/git/log?branch=main&limit=20
  app.get("/mailbox/:agentId/git/log", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const branch = req.query.branch as string | undefined;
      const rawLimit = Number(req.query.limit ?? 20);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;
      const commits = await storageFor(req).listCommits(agentId, { branch, limit });
      return res.status(200).json({ commits });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId/git/commits/:commitId — get single commit with full snapshot
  app.get("/mailbox/:agentId/git/commits/:commitId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const commit = await storageFor(req).getCommit(req.params.agentId, req.params.commitId);
      if (!commit) return res.status(404).json({ error: "commit not found" });
      return res.status(200).json(commit);
    } catch (e) {
      next(e);
    }
  });

  // POST /mailbox/:agentId/git/restore/:commitId — restore graph+index to a commit
  app.post("/mailbox/:agentId/git/restore/:commitId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await storageFor(req).restoreCommit(req.params.agentId, req.params.commitId);
      return res.status(200).json({ ok: true, restoredTo: req.params.commitId });
    } catch (e) {
      if ((e as Error)?.message?.includes("not found")) {
        return res.status(404).json({ error: (e as Error).message });
      }
      next(e);
    }
  });

  // POST /mailbox/:agentId/git/merge — merge fromBranch HEAD into toBranch
  // Body: { fromBranch, toBranch, strategy?: "union"|"ours"|"theirs", message? }
  app.post("/mailbox/:agentId/git/merge", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const { fromBranch, toBranch, strategy, message } = (req.body ?? {}) as {
        fromBranch?: string; toBranch?: string;
        strategy?: string; message?: string;
      };
      if (!fromBranch || typeof fromBranch !== "string") {
        return res.status(400).json({ error: "fromBranch (string) is required" });
      }
      if (!toBranch || typeof toBranch !== "string") {
        return res.status(400).json({ error: "toBranch (string) is required" });
      }
      const validStrategies = ["union", "ours", "theirs"];
      if (strategy && !validStrategies.includes(strategy)) {
        return res.status(400).json({ error: `strategy must be one of: ${validStrategies.join(", ")}` });
      }
      const commit = await storageFor(req).mergeCommits(agentId, fromBranch, toBranch, {
        strategy: (strategy as "union" | "ours" | "theirs") ?? "union",
        message: message ?? undefined,
      });
      return res.status(201).json(commit);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.message?.includes("has no commits")) {
        return res.status(404).json({ error: err.message });
      }
      if (err.status === 413) return res.status(413).json({ error: err.message });
      next(e);
    }
  });

  // GET /mailbox/:agentId/git/diff?from=<commitId>&to=<commitId|"live">
  // Omit `to` or pass `to=live` to diff against current live state.
  app.get("/mailbox/:agentId/git/diff", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const fromId = req.query.from as string | undefined;
      if (!fromId) return res.status(400).json({ error: "from query parameter is required" });
      const toRaw = req.query.to as string | undefined;
      const toId = toRaw && toRaw !== "live" ? toRaw : null;
      const diff = await storageFor(req).diffCommits(agentId, fromId, toId);
      return res.status(200).json(diff);
    } catch (e) {
      if ((e as Error)?.message?.includes("not found")) {
        return res.status(404).json({ error: (e as Error).message });
      }
      next(e);
    }
  });

  // ===================== Codebase Index =====================

  const VALID_INDEX_CATEGORIES = new Set([
    "file", "symbol", "api", "config", "architecture", "module", "overview",
  ]);

  // POST /mailbox/:agentId/index — upsert an index entry
  app.post("/mailbox/:agentId/index", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const { key, category, summary, metadata } = req.body ?? {};
      if (!key || typeof key !== "string") {
        return res.status(400).json({ error: "key (string) is required" });
      }
      if (!category || !VALID_INDEX_CATEGORIES.has(category)) {
        return res.status(400).json({
          error: `category must be one of: ${[...VALID_INDEX_CATEGORIES].join(", ")}`,
        });
      }
      if (!summary || typeof summary !== "string") {
        return res.status(400).json({ error: "summary (string) is required" });
      }
      if (metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) {
        return res.status(400).json({ error: "metadata must be a JSON object" });
      }
      await storageFor(req).upsertIndex(agentId, {
        key,
        category,
        summary,
        metadata: metadata ?? {},
      });
      return res.status(200).json({ ok: true, key });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId/index/:key — get a specific index entry
  app.get("/mailbox/:agentId/index/:key(*)", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const key = req.params.key;
      const entry = await storageFor(req).getIndex(agentId, key);
      if (!entry) return res.status(404).json({ error: "index entry not found" });
      return res.status(200).json(entry);
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId/index?q=...&category=...&limit=N — search index entries
  app.get("/mailbox/:agentId/index", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const q = (req.query.q as string | undefined) ?? "";
      if (!q) {
        return res.status(400).json({ error: "q query parameter is required" });
      }
      const categoryRaw = req.query.category as string | undefined;
      if (categoryRaw && !VALID_INDEX_CATEGORIES.has(categoryRaw)) {
        return res.status(400).json({
          error: `category must be one of: ${[...VALID_INDEX_CATEGORIES].join(", ")}`,
        });
      }
      const limit = parseQueryInt(req.query.limit, 20, 1, 200);
      const entries = await storageFor(req).searchIndex(agentId, q, categoryRaw, { limit });
      return res.status(200).json({ entries });
    } catch (e) {
      next(e);
    }
  });

  // DELETE /mailbox/:agentId/index/:key — delete an index entry
  app.delete("/mailbox/:agentId/index/:key(*)", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const key = req.params.key;
      await storageFor(req).deleteIndex(agentId, key);
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // POST /mailbox/:agentId/index/check-staleness — batch hash check
  // Body: { entries: [{ key, currentHash }] }
  // Returns: { fresh, stale, missing } — tells caller which summaries
  // are still valid so it can skip reading unchanged files.
  app.post("/mailbox/:agentId/index/check-staleness", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const entries = req.body?.entries;
      if (!Array.isArray(entries)) {
        return res.status(400).json({ error: "entries must be an array" });
      }
      if (entries.length > 500) {
        return res.status(400).json({ error: `entries array too large (${entries.length}). Maximum is 500.` });
      }
      for (const e of entries) {
        if (typeof e?.key !== "string" || typeof e?.currentHash !== "string") {
          return res.status(400).json({ error: "each entry must have key (string) and currentHash (string)" });
        }
      }
      const result = await storageFor(req).checkStaleness(agentId, entries);
      return res.status(200).json(result);
    } catch (e) {
      next(e);
    }
  });

  // POST /mailbox/:agentId/index/rollup — aggregate file summaries into a module entry
  // Body: { moduleKey, fileKeys }
  // Returns: { ok, key, fileCount }
  app.post("/mailbox/:agentId/index/rollup", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const { moduleKey, fileKeys } = req.body ?? {};
      if (typeof moduleKey !== "string" || !moduleKey) {
        return res.status(400).json({ error: "moduleKey is required (string)" });
      }
      if (!Array.isArray(fileKeys) || fileKeys.length === 0) {
        return res.status(400).json({ error: "fileKeys must be a non-empty array" });
      }
      if (fileKeys.length > 500) {
        return res.status(400).json({ error: `fileKeys array too large (${fileKeys.length}). Maximum is 500.` });
      }
      // Validate every item is a string
      for (let i = 0; i < fileKeys.length; i++) {
        if (typeof fileKeys[i] !== "string") {
          return res.status(400).json({ error: `fileKeys[${i}] must be a string, got ${typeof fileKeys[i]}` });
        }
      }
      await storageFor(req).rollupModule(agentId, moduleKey, fileKeys as string[]);
      return res.status(200).json({ ok: true, key: moduleKey, fileCount: (fileKeys as string[]).length });
    } catch (e) {
      next(e);
    }
  });

  // Final error boundary. Operational errors (4xx — the caller's fault,
  // e.g. malformed JSON body) are logged at warn and surface their message;
  // programmer/internal errors (5xx) log the full stack and return a
  // sanitized body in production so stacks and internals never leak.
  app.use((
    err: Error & { status?: number; statusCode?: number },
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const rawStatus = err.status ?? err.statusCode;
    const status =
      typeof rawStatus === "number" && rawStatus >= 400 && rawStatus <= 599
        ? rawStatus
        : 500;
    const requestId = req.id !== undefined ? String(req.id) : null;
    const log = req.log ?? logger;
    if (status >= 500) {
      log.error({ err, requestId, stack: err.stack }, "unhandled route error");
    } else {
      log.warn({ err, requestId }, "request failed");
    }
    const isProd = process.env.NODE_ENV === "production";
    const message =
      status < 500 || !isProd
        ? err.message ?? "internal error"
        : "internal error";
    res.status(status).json({ error: message, requestId });
  });

  return { app, storage, ready, rateLimiter };
}

if (require.main === module) {
  // Last-resort process guards. Unhandled rejections are logged with full
  // context but don't kill the process; uncaught exceptions exit non-zero
  // so the orchestrator restarts a clean instance.
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception; exiting");
    process.exit(1);
  });

  const port = Number(process.env.PORT ?? 3000);
  const dbPath =
    readEnv("AGENTSMCP_DB", "AGENTMAILBOX_DB") ?? "agentmailbox.db";
  const { app, ready } = createServer(dbPath);
  ready
    .then(() => {
      app.listen(port, () => {
        logger.info({ port, dbPath }, `server listening on http://localhost:${port}`);
      });
    })
    .catch((e) => {
      logger.fatal({ err: e }, "failed to initialize storage");
      process.exit(1);
    });
}

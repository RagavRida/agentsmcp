import { z } from "zod";
import { logger } from "./logger";

/**
 * Application configuration — validated at startup with zod.
 * Fails fast with a clear error if required vars are missing.
 */

const booleanEnv = z
  .enum(["true", "false", "1", "0", "yes", "no", "on", "off", ""])
  .optional()
  .transform((v) => v !== undefined && /^(true|1|yes|on)$/i.test(v));

const configSchema = z.object({
  /** HTTP port. Defaults to 3000. */
  PORT: z
    .string()
    .optional()
    .default("3000")
    .transform((v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 1 || n > 65535) {
        throw new Error(`PORT must be 1-65535, got "${v}"`);
      }
      return n;
    }),

  /** Database connection string or file path. */
  AGENTSMCP_DB: z.string().optional(),
  AGENTMAILBOX_DB: z.string().optional(),

  /** Enable SSL for Postgres connections. */
  AGENTSMCP_DB_SSL: booleanEnv,

  /** Cloud mode — enables auth, CORS, rate limiting, audit logging. */
  CLOUD_MODE: booleanEnv,
  AGENTSMCP_CLOUD_MODE: booleanEnv,

  /** API key for self-hosted single-tenant auth. */
  AGENTSMCP_API_KEY: z.string().optional(),

  /** GitHub OAuth credentials (required in cloud mode). */
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  /** JWT secret for session tokens (required in cloud mode). */
  JWT_SECRET: z.string().optional(),

  /** Log level override. */
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .optional(),

  /** Anthropic API key for Claude-powered context compression. */
  ANTHROPIC_API_KEY: z.string().optional(),

  /** OpenAI API key for GPT-powered context compression. */
  OPENAI_API_KEY: z.string().optional(),

  NODE_ENV: z.enum(["production", "development", "test"]).optional().default("development"),
});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Validate environment variables and return a typed, frozen config.
 * Throws with a descriptive message on validation failure.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  const config = Object.freeze(result.data);

  // Cloud mode cross-checks
  const isCloud = config.CLOUD_MODE || config.AGENTSMCP_CLOUD_MODE;
  if (isCloud) {
    const missing: string[] = [];
    if (!config.GITHUB_CLIENT_ID) missing.push("GITHUB_CLIENT_ID");
    if (!config.GITHUB_CLIENT_SECRET) missing.push("GITHUB_CLIENT_SECRET");
    if (!config.JWT_SECRET) missing.push("JWT_SECRET");
    if (missing.length > 0) {
      throw new Error(
        `CLOUD_MODE is enabled but required variables are missing: ${missing.join(", ")}`
      );
    }
  }

  // Log sanitized config at startup (redact secrets)
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === "") continue;
    if (/secret|key|password|token/i.test(k) && typeof v === "string") {
      sanitized[k] = v.slice(0, 4) + "****";
    } else {
      sanitized[k] = v;
    }
  }
  logger.info({ config: sanitized }, "configuration loaded");

  return config;
}

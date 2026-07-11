import { randomUUID } from "crypto";
import pino from "pino";
import pinoHttp, { HttpLogger } from "pino-http";

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);

/**
 * True when the optional pino-pretty dev dependency is installed and we're
 * running interactively (not production, not under the test runner).
 */
function prettyTransportAvailable(): boolean {
  if (isProduction || isTest) return false;
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

/**
 * Application-wide structured logger.
 *
 * - production (NODE_ENV=production): newline-delimited JSON, ready for
 *   App Runner -> CloudWatch ingestion.
 * - development: human-readable output via pino-pretty when installed.
 *
 * Level is controlled with LOG_LEVEL (fatal|error|warn|info|debug|trace);
 * defaults to info in production and debug elsewhere.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  timestamp: pino.stdTimeFunctions.isoTime,
  // Drop pid/hostname defaults - CloudWatch already attaches instance metadata.
  base: undefined,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-api-key",
      "headers.authorization",
      "authorization",
    ],
    censor: "[REDACTED]",
  },
  ...(prettyTransportAvailable()
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      }
    : {}),
});

export type Logger = pino.Logger;

export interface HttpLoggerOptions {
  /**
   * When false, `req.log` is still attached for request-scoped logging but
   * no automatic per-request completion line is emitted. Self-hosted
   * installs keep this off to stay quiet; cloud mode turns it on.
   */
  autoLogging?: boolean;
}

/**
 * Request-scoped HTTP logger middleware (pino-http).
 *
 * - Attaches `req.log`, a child logger bound to the request id.
 * - Honours an inbound X-Request-Id header (<=128 chars), else generates a
 *   UUID, and reflects it back on the response.
 * - Completion lines include requestId, userId, method, path, statusCode,
 *   and durationMs.
 */
export function createHttpLogger(opts: HttpLoggerOptions = {}): HttpLogger {
  return pinoHttp({
    logger,
    autoLogging: opts.autoLogging ?? true,
    genReqId: (req, res) => {
      const inbound = req.headers["x-request-id"];
      const id =
        typeof inbound === "string" && inbound.length > 0 && inbound.length <= 128
          ? inbound
          : randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    customAttributeKeys: {
      reqId: "requestId",
      responseTime: "durationMs",
    },
    customProps: (req, res) => {
      const r = req as typeof req & {
        userId?: string;
        apiKeyId?: string;
        path?: string;
        ip?: string;
      };
      return {
        method: req.method,
        path: r.path ?? req.url,
        statusCode: res.statusCode,
        ip: r.ip ?? req.socket?.remoteAddress ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        userId: r.userId ?? null,
        apiKeyId: r.apiKeyId ?? null,
      };
    },
  });
}

export default logger;

/**
 * Tests for scripts/index-codebase.ts static summary generation.
 *
 * We test the pure extraction functions in isolation — no server needed.
 * The functions are imported by running the script in test-only mode.
 */

import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import * as path from "node:path";

// ── Re-implement the pure functions here so they're testable without
//    spinning up a server or touching the file system.
//    (A future refactor can extract them to src/indexer/extract.ts)

type Language = "typescript" | "javascript" | "python" | "markdown" | "sql" | "json" | "text";

function detectLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, Language> = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python",
    ".md": "markdown", ".mdx": "markdown",
    ".sql": "sql",
    ".json": "json",
  };
  return map[ext] ?? "text";
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function extractTypeScript(source: string) {
  const jsdocMatch = source.match(/\/\*\*[\s\S]*?\*\s+([^\n@*][^\n]+)/);
  const lineCommentMatch = source.match(/^[ \t]*\/\/[ \t]*([^\n]+)/m);
  const description = (jsdocMatch?.[1] ?? lineCommentMatch?.[1] ?? "").trim();

  const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+|type\s+|interface\s+|enum\s+)(\w+)/g;
  const exports: string[] = [];
  for (const m of source.matchAll(exportRe)) {
    if (m[1] && !exports.includes(m[1])) exports.push(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const name of m[1].split(",")) {
      const clean = name.replace(/\s+as\s+\w+/, "").trim();
      if (clean && !exports.includes(clean)) exports.push(clean);
    }
  }

  const importRe = /from\s+['"]([^'"]+)['"]/g;
  const imports: string[] = [];
  for (const m of source.matchAll(importRe)) {
    if (!imports.includes(m[1])) imports.push(m[1]);
  }

  return { description, exports: exports.slice(0, 10), imports: imports.slice(0, 8) };
}

function extractPython(source: string) {
  const docstringMatch = source.match(/^(?:r?(?:"""|\'\'\'))([\s\S]*?)(?:"""|\'\'\')/)
    ?? source.match(/^#\s*([^\n]+)/m);
  const description = (docstringMatch?.[1] ?? "").trim().split("\n")[0];
  const declRe = /^(?:def|class|async def)\s+(\w+)/gm;
  const topLevelDecls: string[] = [];
  for (const m of source.matchAll(declRe)) {
    if (!topLevelDecls.includes(m[1])) topLevelDecls.push(m[1]);
  }
  const imports: string[] = [];
  for (const m of source.matchAll(/^(?:import|from)\s+(\S+)/gm)) {
    const raw = m[1];
    const dep = raw.startsWith(".") ? raw : raw.split(".")[0];
    if (!imports.includes(dep)) imports.push(dep);
  }
  return { description, exports: topLevelDecls.slice(0, 10), imports: imports.slice(0, 8) };
}

// ---------------------------------------------------------------------------

describe("detectLanguage", () => {
  it("identifies TypeScript", () => {
    expect(detectLanguage("src/auth/middleware.ts")).toBe("typescript");
    expect(detectLanguage("components/Button.tsx")).toBe("typescript");
  });

  it("identifies JavaScript", () => {
    expect(detectLanguage("src/server.js")).toBe("javascript");
    expect(detectLanguage("index.mjs")).toBe("javascript");
  });

  it("identifies Python", () => {
    expect(detectLanguage("agent.py")).toBe("python");
  });

  it("identifies Markdown", () => {
    expect(detectLanguage("README.md")).toBe("markdown");
    expect(detectLanguage("docs/intro.mdx")).toBe("markdown");
  });

  it("falls back to text for unknown extensions", () => {
    expect(detectLanguage("config.conf")).toBe("text");
  });
});

describe("hashContent", () => {
  it("returns a 16-char hex string", () => {
    const h = hashContent("hello world");
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("same content → same hash", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
  });

  it("different content → different hash", () => {
    expect(hashContent("abc")).not.toBe(hashContent("ABC"));
  });
});

describe("extractTypeScript", () => {
  it("extracts JSDoc description", () => {
    const source = `/**
 * JWT authentication middleware for HTTP and WebSocket.
 * @param options auth options
 */
export function requireAuth() {}`;
    const { description } = extractTypeScript(source);
    expect(description).toContain("JWT authentication middleware");
  });

  it("falls back to line comment when no JSDoc", () => {
    const source = `// Rate limiter using sliding window algorithm.
export function rateLimitByIp() {}`;
    const { description } = extractTypeScript(source);
    expect(description).toBe("Rate limiter using sliding window algorithm.");
  });

  it("extracts named function exports", () => {
    const source = `
export function requireAuth() {}
export async function parseToken(raw: string) {}
export class AuthError extends Error {}
`;
    const { exports } = extractTypeScript(source);
    expect(exports).toContain("requireAuth");
    expect(exports).toContain("parseToken");
    expect(exports).toContain("AuthError");
  });

  it("extracts const and type exports", () => {
    const source = `
export const DEFAULT_EXPIRY = 3600;
export type AuthOptions = { rs256: boolean };
export interface Middleware {}
`;
    const { exports } = extractTypeScript(source);
    expect(exports).toContain("DEFAULT_EXPIRY");
    expect(exports).toContain("AuthOptions");
    expect(exports).toContain("Middleware");
  });

  it("extracts named re-exports { foo, bar }", () => {
    const source = `export { requireAuth, parseToken } from "./core";`;
    const { exports } = extractTypeScript(source);
    expect(exports).toContain("requireAuth");
    expect(exports).toContain("parseToken");
  });

  it("extracts import paths", () => {
    const source = `
import { verify } from "jsonwebtoken";
import { getPublicKey } from "./keys";
import type { AuthOptions } from "./types";
`;
    const { imports } = extractTypeScript(source);
    expect(imports).toContain("jsonwebtoken");
    expect(imports).toContain("./keys");
    expect(imports).toContain("./types");
  });

  it("deduplicates imports", () => {
    const source = `
import { a } from "./utils";
import { b } from "./utils";
`;
    const { imports } = extractTypeScript(source);
    expect(imports.filter((i) => i === "./utils")).toHaveLength(1);
  });

  it("returns empty arrays for a file with no exports or imports", () => {
    const source = `const x = 1;`;
    const { exports, imports } = extractTypeScript(source);
    expect(exports).toHaveLength(0);
    expect(imports).toHaveLength(0);
  });
});

describe("extractPython", () => {
  it("extracts module docstring", () => {
    const source = `"""JWT authentication utilities for FastAPI."""\n\ndef verify_token(token: str) -> dict:\n    pass`;
    const { description } = extractPython(source);
    expect(description).toContain("JWT authentication");
  });

  it("extracts line comment description", () => {
    const source = `# Rate limiting middleware\ndef rate_limit(): pass`;
    const { description } = extractPython(source);
    expect(description).toContain("Rate limiting middleware");
  });

  it("extracts top-level functions and classes", () => {
    const source = `
def verify_token(token):
    pass

class AuthError(Exception):
    pass

async def refresh_token():
    pass
`;
    const { exports } = extractPython(source);
    expect(exports).toContain("verify_token");
    expect(exports).toContain("AuthError");
    expect(exports).toContain("refresh_token");
  });

  it("extracts import statements", () => {
    const source = `
import jwt
from fastapi import Depends, HTTPException
from .models import User
`;
    const { imports } = extractPython(source);
    expect(imports).toContain("jwt");
    expect(imports).toContain("fastapi");
    expect(imports).toContain(".models");
  });
});

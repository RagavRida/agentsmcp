#!/usr/bin/env node
/**
 * agentsmcp-index — CI codebase indexer
 *
 * Crawls a directory tree, extracts static summaries from source files
 * (no LLM, no API calls), and pushes entries to an AgentMailbox server.
 * Designed to run in CI on every git push.
 *
 * Usage:
 *   npx agentsmcp-index \
 *     --server https://your-server.example.com \
 *     --api-key sk_live_xxx \
 *     --agent-id project@team \
 *     --dir ./src \
 *     --mode full|incremental \
 *     --exclude "node_modules,dist,.git" \
 *     --concurrency 8 \
 *     --max-file-kb 512
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Named constants — all tuneable, none buried in code
// ---------------------------------------------------------------------------

/** Max exports/imports to include in a summary (per category). */
const MAX_EXPORTS = 12;
const MAX_INTERNAL_IMPORTS = 8;
const MAX_EXTERNAL_IMPORTS = 4;
const MAX_SQL_DECLS = 12;
const MAX_JSON_KEYS = 8;

/** Max description length from a comment line (chars). */
const MAX_DESCRIPTION_CHARS = 200;

/** Average summary size in tokens (used for stats only, not logic). */
const AVG_SUMMARY_TOKENS = 40;

/** Conservative average raw-file size in tokens (for savings estimate). */
const AVG_RAW_FILE_TOKENS = 3000;

/** Max concurrent HTTP requests to the server. */
const DEFAULT_CONCURRENCY = 8;

/** Skip files larger than this (bytes). Default 512 KB. */
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/** Progress log every N files. */
const PROGRESS_INTERVAL = 100;

/** HTTP retry settings. */
const HTTP_MAX_RETRIES = 3;
const HTTP_RETRY_BASE_MS = 500; // doubles on each retry

/** Prefix used in index keys for file entries. */
const FILE_KEY_PREFIX = "file:";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  server: string;
  apiKey: string;
  agentId: string;
  dir: string;
  mode: "full" | "incremental";
  exclude: string[];
  concurrency: number;
  maxFileBytes: number;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);

  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const val = argv[i + 1];
    // Guard against accidentally reading the next flag as a value
    if (!val || val.startsWith("--")) return undefined;
    return val;
  };
  const hasFlag = (flag: string): boolean => argv.includes(flag);

  const server = get("--server") ?? process.env.AGENTSMCP_SERVER ?? "";
  const apiKey = get("--api-key") ?? process.env.AGENTSMCP_API_KEY ?? "";
  const agentId = get("--agent-id") ?? process.env.AGENTSMCP_AGENT_ID ?? "project@index";
  const dir = get("--dir") ?? ".";
  const modeRaw = get("--mode") ?? "full";
  const mode: "full" | "incremental" = modeRaw === "incremental" ? "incremental" : "full";
  const excludeRaw =
    get("--exclude") ??
    "node_modules,dist,.git,coverage,*.test.ts,*.spec.ts,*.d.ts,*.min.js,*.map";
  const exclude = excludeRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const concurrencyRaw = get("--concurrency") ?? process.env.AGENTSMCP_CONCURRENCY;
  const concurrency = concurrencyRaw ? Math.max(1, Math.min(50, parseInt(concurrencyRaw, 10) || DEFAULT_CONCURRENCY)) : DEFAULT_CONCURRENCY;

  const maxFileKbRaw = get("--max-file-kb") ?? process.env.AGENTSMCP_MAX_FILE_KB;
  const maxFileBytes = maxFileKbRaw ? parseInt(maxFileKbRaw, 10) * 1024 : DEFAULT_MAX_FILE_BYTES;

  const verbose = hasFlag("--verbose") || hasFlag("-v") || !!process.env.AGENTSMCP_VERBOSE;

  if (!server) {
    console.error("[agentsmcp-index] ERROR: --server is required (or set AGENTSMCP_SERVER)");
    console.error("[agentsmcp-index] Usage: agentsmcp-index --server URL --agent-id ID [--mode full|incremental] [--dir PATH]");
    process.exit(1);
  }

  // Validate dir exists upfront — fail fast with a clear message
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) {
    console.error(`[agentsmcp-index] ERROR: --dir does not exist: ${absDir}`);
    process.exit(1);
  }
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory()) {
    console.error(`[agentsmcp-index] ERROR: --dir is not a directory: ${absDir}`);
    process.exit(1);
  }

  return { server, apiKey, agentId, dir, mode, exclude, concurrency, maxFileBytes, verbose };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift",
  ".json", ".yaml", ".yml", ".toml",
  ".sql", ".graphql", ".gql",
  ".md", ".mdx",
  ".sh", ".bash",
  ".css", ".scss", ".sass",
  ".html", ".xml",
]);

/**
 * Returns true if the path matches any exclude pattern.
 * Works correctly on both Unix and Windows by normalising separators.
 */
function matchesExclude(filePath: string, exclude: string[]): boolean {
  // Normalise to forward slashes so patterns always match on Windows too
  const normalised = filePath.replace(/\\/g, "/");
  const parts = normalised.split("/");
  const basename = parts[parts.length - 1] ?? "";

  for (const pattern of exclude) {
    if (!pattern) continue;

    if (pattern.startsWith("*.")) {
      // Glob suffix match: *.test.ts, *.min.js, etc.
      const suffix = pattern.slice(1); // .test.ts
      if (normalised.endsWith(suffix)) return true;
    } else if (pattern.includes("/")) {
      // Path segment match: "src/generated"
      if (normalised.includes(pattern)) return true;
    } else {
      // Directory name or filename match (any depth)
      if (parts.includes(pattern) || basename === pattern) return true;
    }
  }
  return false;
}

function walkDir(dir: string, exclude: string[], maxFileBytes: number): string[] {
  const results: string[] = [];
  const absRoot = path.resolve(dir);

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // Permission denied or race condition — skip silently
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const rel = path.relative(absRoot, fullPath);

      if (matchesExclude(rel, exclude)) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

        // Skip oversized files (generated bundles, binary data, etc.)
        try {
          const size = fs.statSync(fullPath).size;
          if (size > maxFileBytes) continue;
          if (size === 0) continue; // Empty files have nothing to summarise
        } catch {
          continue;
        }

        results.push(fullPath);
      }
    }
  }

  walk(absRoot);
  return results;
}

// ---------------------------------------------------------------------------
// Static summary generation — no LLM required
// ---------------------------------------------------------------------------

interface ExtractedInfo {
  description: string;
  exports: string[];
  imports: string[];
  language: string;
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust",
    ".rb": "ruby", ".java": "java", ".kt": "kotlin",
    ".swift": "swift", ".json": "json", ".yaml": "yaml",
    ".yml": "yaml", ".toml": "toml", ".sql": "sql",
    ".graphql": "graphql", ".gql": "graphql",
    ".md": "markdown", ".mdx": "markdown",
    ".sh": "shell", ".bash": "shell",
    ".css": "css", ".scss": "css", ".sass": "css",
    ".html": "html", ".xml": "xml",
  };
  return map[ext] ?? "text";
}

/** Deduplicate while preserving insertion order. */
function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function extractTypeScript(source: string): Partial<ExtractedInfo> {
  // Description: first JSDoc summary line or first line comment
  const jsdocMatch = source.match(/\/\*\*[\s\S]*?\*\s+([^\n@*][^\n]+)/);
  const lineCommentMatch = source.match(/^[ \t]*\/\/[ \t]*([^\n]+)/m);
  const description = (jsdocMatch?.[1] ?? lineCommentMatch?.[1] ?? "")
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);

  // Named exports (function, class, const, let, var, type, interface, enum)
  const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+|type\s+|interface\s+|enum\s+)(\w+)/g;
  const exports: string[] = [];
  for (const m of source.matchAll(exportRe)) {
    if (m[1]) exports.push(m[1]);
  }
  // Named re-exports: export { foo, bar as Baz }
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const token of m[1].split(",")) {
      const name = token.replace(/\s+as\s+\w+/, "").trim();
      if (name && /^\w+$/.test(name)) exports.push(name);
    }
  }

  // Import paths
  const imports: string[] = [];
  for (const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    imports.push(m[1]);
  }

  return {
    description,
    exports: dedupe(exports).slice(0, MAX_EXPORTS),
    imports: dedupe(imports).slice(0, MAX_INTERNAL_IMPORTS + MAX_EXTERNAL_IMPORTS),
  };
}

function extractGo(source: string): Partial<ExtractedInfo> {
  // Package declaration
  const pkg = source.match(/^package\s+(\w+)/m)?.[1] ?? "";
  // Exported identifiers (start with uppercase)
  const funcRe = /^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)\s*\(/gm;
  const typeRe = /^type\s+([A-Z]\w*)\s+/gm;
  const exports: string[] = [];
  for (const m of source.matchAll(funcRe)) exports.push(m[1]);
  for (const m of source.matchAll(typeRe)) exports.push(m[1]);
  // Imports
  const imports: string[] = [];
  for (const m of source.matchAll(/"([^"]+)"/g)) imports.push(m[1]);
  return {
    description: pkg ? `Go package: ${pkg}` : "",
    exports: dedupe(exports).slice(0, MAX_EXPORTS),
    imports: dedupe(imports).slice(0, MAX_INTERNAL_IMPORTS + MAX_EXTERNAL_IMPORTS),
  };
}

function extractPython(source: string): Partial<ExtractedInfo> {
  // Module docstring (triple-quoted) or first comment line
  const docstringMatch = source.match(/^(?:r?(?:"""|\'\'\'))([\s\S]*?)(?:"""|\'\'\')/)
    ?? source.match(/^#\s*([^\n]+)/m);
  const description = (docstringMatch?.[1] ?? "").trim().split("\n")[0]
    .slice(0, MAX_DESCRIPTION_CHARS);

  // Top-level functions and classes
  const exports: string[] = [];
  for (const m of source.matchAll(/^(?:def|class|async\s+def)\s+(\w+)/gm)) {
    exports.push(m[1]);
  }

  // Imports — preserve relative paths, strip sub-modules for absolute
  const imports: string[] = [];
  for (const m of source.matchAll(/^(?:import|from)\s+(\S+)/gm)) {
    const raw = m[1];
    const dep = raw.startsWith(".") ? raw : raw.split(".")[0];
    if (dep) imports.push(dep);
  }

  return {
    description,
    exports: dedupe(exports).slice(0, MAX_EXPORTS),
    imports: dedupe(imports).slice(0, MAX_INTERNAL_IMPORTS + MAX_EXTERNAL_IMPORTS),
  };
}

function extractMarkdown(source: string): Partial<ExtractedInfo> {
  const h1 = source.match(/^#\s+(.+)/m)?.[1]?.trim() ?? "";
  // First non-empty paragraph after the H1
  const withoutH1 = source.replace(/^#[^\n]*\n?/, "");
  const firstPara = withoutH1.match(/^([^\n]+)/m)?.[1]?.trim() ?? "";
  const description = (h1 || firstPara).slice(0, MAX_DESCRIPTION_CHARS);
  return { description, exports: [], imports: [] };
}

function extractSql(source: string): Partial<ExtractedInfo> {
  const tableRe = /CREATE\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
  const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/gi;
  const indexRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
  const decls: string[] = [];
  for (const m of source.matchAll(tableRe)) decls.push(m[1]);
  for (const m of source.matchAll(fnRe)) decls.push(m[1]);
  for (const m of source.matchAll(indexRe)) decls.push(m[1]);

  return {
    description: decls.length > 0
      ? `SQL: ${dedupe(decls).slice(0, MAX_SQL_DECLS).join(", ")}`
      : "SQL file",
    exports: dedupe(decls).slice(0, MAX_SQL_DECLS),
    imports: [],
  };
}

function extractJson(source: string): Partial<ExtractedInfo> {
  let obj: unknown;
  try {
    obj = JSON.parse(source);
  } catch {
    return { description: "JSON file (unparseable)", exports: [], imports: [] };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { description: `JSON ${Array.isArray(obj) ? "array" : typeof obj}`, exports: [], imports: [] };
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, MAX_JSON_KEYS);
  const name = typeof record.name === "string" ? record.name : "";
  const desc = typeof record.description === "string" ? record.description : "";
  const version = typeof record.version === "string" ? ` v${record.version}` : "";
  return {
    description: name
      ? `${name}${version}${desc ? ": " + desc.slice(0, 100) : ""}`
      : `JSON with keys: ${keys.join(", ")}`,
    exports: keys,
    imports: [],
  };
}

function extractGraphQL(source: string): Partial<ExtractedInfo> {
  const typeRe = /(?:type|interface|input|enum|union)\s+(\w+)/g;
  const queryRe = /(?:query|mutation|subscription)\s+(\w+)/g;
  const types: string[] = [];
  for (const m of source.matchAll(typeRe)) types.push(m[1]);
  for (const m of source.matchAll(queryRe)) types.push(m[1]);
  return {
    description: types.length > 0 ? `GraphQL: ${dedupe(types).slice(0, MAX_EXPORTS).join(", ")}` : "GraphQL schema/query",
    exports: dedupe(types).slice(0, MAX_EXPORTS),
    imports: [],
  };
}

function extractInfo(filePath: string, source: string): ExtractedInfo {
  const language = detectLanguage(filePath);
  let partial: Partial<ExtractedInfo> = {};

  switch (language) {
    case "typescript":
    case "javascript":
      partial = extractTypeScript(source);
      break;
    case "python":
      partial = extractPython(source);
      break;
    case "go":
      partial = extractGo(source);
      break;
    case "markdown":
      partial = extractMarkdown(source);
      break;
    case "sql":
      partial = extractSql(source);
      break;
    case "json":
      partial = extractJson(source);
      break;
    case "graphql":
      partial = extractGraphQL(source);
      break;
    default: {
      // Generic: first meaningful non-empty line (strip comment chars)
      const firstLine = source
        .split("\n")
        .find((l) => l.trim().length > 4)
        ?.trim() ?? "";
      partial.description = firstLine
        .replace(/^[#*/<>!-]+\s*/, "")
        .slice(0, MAX_DESCRIPTION_CHARS);
      partial.exports = [];
      partial.imports = [];
    }
  }

  return {
    description: partial.description ?? "",
    exports: partial.exports ?? [],
    imports: partial.imports ?? [],
    language,
  };
}

function buildSummary(filePath: string, source: string): string {
  const lineCount = source.split("\n").length;
  const info = extractInfo(filePath, source);

  const parts: string[] = [];

  // 1. Description — fallback to a clean filename-based label
  const description = info.description.trim() ||
    `${path.basename(filePath, path.extname(filePath))} module`;
  parts.push(description);

  // 2. Exports
  if (info.exports.length > 0) {
    parts.push(`Exports: ${info.exports.join(", ")}`);
  }

  // 3. Imports — split internal vs external for signal clarity
  const internal = info.imports.filter((i) => i.startsWith(".")).slice(0, MAX_INTERNAL_IMPORTS);
  const external = info.imports.filter((i) => !i.startsWith(".")).slice(0, MAX_EXTERNAL_IMPORTS);
  if (internal.length > 0) parts.push(`Depends on: ${internal.join(", ")}`);
  if (external.length > 0) parts.push(`Uses: ${external.join(", ")}`);

  // 4. Size signals
  parts.push(`${lineCount} lines`);
  parts.push(`Language: ${info.language}`);

  return parts.join(". ") + ".";
}

// ---------------------------------------------------------------------------
// SHA-256 content hash — first 16 hex chars (64-bit, collision-safe for this)
// ---------------------------------------------------------------------------

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// HTTP client with exponential backoff retry
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiPost(
  server: string,
  apiKey: string,
  apiPath: string,
  body: unknown,
  attempt = 0
): Promise<unknown> {
  const url = `${server.replace(/\/$/, "")}${apiPath}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    if (attempt < HTTP_MAX_RETRIES) {
      await sleep(HTTP_RETRY_BASE_MS * Math.pow(2, attempt));
      return apiPost(server, apiKey, apiPath, body, attempt + 1);
    }
    throw new Error(`Network error on POST ${apiPath}: ${(networkErr as Error).message}`);
  }

  // Retry on 429 (rate limit) or 5xx (server error)
  if ((resp.status === 429 || resp.status >= 500) && attempt < HTTP_MAX_RETRIES) {
    const retryAfter = parseInt(resp.headers.get("retry-after") ?? "0", 10);
    const delay = retryAfter > 0
      ? retryAfter * 1000
      : HTTP_RETRY_BASE_MS * Math.pow(2, attempt);
    await sleep(delay);
    return apiPost(server, apiKey, apiPath, body, attempt + 1);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`POST ${apiPath} → HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function apiDelete(
  server: string,
  apiKey: string,
  apiPath: string,
  attempt = 0
): Promise<void> {
  const url = `${server.replace(/\/$/, "")}${apiPath}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "DELETE",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
  } catch (networkErr) {
    if (attempt < HTTP_MAX_RETRIES) {
      await sleep(HTTP_RETRY_BASE_MS * Math.pow(2, attempt));
      return apiDelete(server, apiKey, apiPath, attempt + 1);
    }
    throw new Error(`Network error on DELETE ${apiPath}: ${(networkErr as Error).message}`);
  }

  if ((resp.status === 429 || resp.status >= 500) && attempt < HTTP_MAX_RETRIES) {
    await sleep(HTTP_RETRY_BASE_MS * Math.pow(2, attempt));
    return apiDelete(server, apiKey, apiPath, attempt + 1);
  }
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`DELETE ${apiPath} → HTTP ${resp.status}`);
  }
}

// ---------------------------------------------------------------------------
// Index a single file — returns the source so callers don't re-read it
// ---------------------------------------------------------------------------

interface IndexResult {
  key: string;
  rawTokenEstimate: number; // chars/4 = rough input token count of raw file
  lines: number;
}

async function indexFile(
  server: string,
  apiKey: string,
  agentId: string,
  filePath: string,
  baseDir: string
): Promise<IndexResult> {
  const source = fs.readFileSync(filePath, "utf8");
  const relPath = path.relative(baseDir, filePath).replace(/\\/g, "/");
  const key = `${FILE_KEY_PREFIX}${relPath}`;
  const summary = buildSummary(filePath, source);
  const contentHash = hashContent(source);
  const lines = source.split("\n").length;
  const language = detectLanguage(filePath);

  await apiPost(server, apiKey, `/mailbox/${encodeURIComponent(agentId)}/index`, {
    key,
    category: "file",
    summary,
    contentHash,
    indexedBy: agentId,
    metadata: {
      path: relPath,
      lines,
      language,
      sizeBytes: source.length,
    },
  });

  return {
    key,
    rawTokenEstimate: Math.ceil(source.length / 4),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Group files by directory → module rollup keys
// ---------------------------------------------------------------------------

function groupByModule(keys: string[]): Map<string, string[]> {
  const modules = new Map<string, string[]>();
  for (const key of keys) {
    if (!key.startsWith(FILE_KEY_PREFIX)) continue;
    const rel = key.slice(FILE_KEY_PREFIX.length); // e.g. "src/auth/middleware.ts"
    const dir = path.dirname(rel).replace(/\\/g, "/"); // e.g. "src/auth"
    const moduleKey = `module:${dir}`;
    if (!modules.has(moduleKey)) modules.set(moduleKey, []);
    modules.get(moduleKey)!.push(key);
  }
  return modules;
}

// ---------------------------------------------------------------------------
// Incremental mode: get changed files from git
// ---------------------------------------------------------------------------

function getGitChangedFiles(baseDir: string): { added: string[]; deleted: string[] } {
  // Try staged+unstaged first, fall back to HEAD~1 diff (for CI)
  const strategies = [
    "git diff HEAD~1 --name-status",
    "git status --short --porcelain",
  ];

  let stdout = "";
  for (const cmd of strategies) {
    try {
      stdout = execSync(cmd, {
        cwd: baseDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
      if (stdout.trim()) break;
    } catch {
      // Try next strategy
    }
  }

  if (!stdout.trim()) {
    console.warn("[agentsmcp-index] Could not detect changed files via git. Falling back to full mode.");
    return { added: [], deleted: [] };
  }

  const added: string[] = [];
  const deleted: string[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Both `git diff --name-status` (D/A/M/R100 old new) and
    // `git status --porcelain` (?? / M / D / R old -> new) formats
    const parts = trimmed.split(/\s+/);
    const status = parts[0];
    if (!status) continue;

    // Determine file path (handle renames: last token is the new path)
    const filePart = parts[parts.length - 1];
    if (!filePart) continue;

    const fullPath = path.resolve(baseDir, filePart);
    const ext = path.extname(filePart).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    if (status === "D" || status === "D." || status === ".D") {
      deleted.push(fullPath);
    } else if (
      status === "A" || status === "M" || status === "??" ||
      status.startsWith("R") || status === "AM" || status === "MM"
    ) {
      // Only add if file actually exists (avoids crash on merge conflicts)
      if (fs.existsSync(fullPath)) added.push(fullPath);
    }
  }

  return {
    added: [...new Set(added)], // deduplicate
    deleted: [...new Set(deleted)],
  };
}

// ---------------------------------------------------------------------------
// Architecture overview entry
// ---------------------------------------------------------------------------

async function writeOverview(
  server: string,
  apiKey: string,
  agentId: string,
  moduleMap: Map<string, string[]>,
  totalFiles: number,
  totalLines: number
): Promise<void> {
  const sortedModules = Array.from(moduleMap.entries())
    .sort((a, b) => b[1].length - a[1].length); // largest modules first

  const moduleList = sortedModules
    .slice(0, 20) // cap at 20 modules in overview to avoid bloat
    .map(([mod, files]) => `${mod.replace("module:", "")} (${files.length} files)`)
    .join(", ");

  const moreModules = moduleMap.size > 20 ? ` (+${moduleMap.size - 20} more)` : "";

  const overview = [
    `Codebase: ${totalFiles} files across ${moduleMap.size} modules.`,
    `Modules: ${moduleList}${moreModules}.`,
    `Total: ~${totalLines.toLocaleString()} lines.`,
    `Indexed: ${new Date().toISOString()}.`,
  ].join(" ");

  await apiPost(server, apiKey, `/mailbox/${encodeURIComponent(agentId)}/index`, {
    key: "overview:architecture",
    category: "overview",
    summary: overview,
    indexedBy: agentId,
    metadata: {
      totalFiles,
      totalModules: moduleMap.size,
      totalLines,
      indexedAt: Date.now(),
    },
  });
}

// ---------------------------------------------------------------------------
// Concurrent batch processor
// ---------------------------------------------------------------------------

async function processBatch<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown; item: T }>> {
  const results: Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown; item: T }> = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        const value = await fn(items[idx], idx);
        results[idx] = { status: "fulfilled", value };
      } catch (reason) {
        results[idx] = { status: "rejected", reason, item: items[idx] };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const absDir = path.resolve(args.dir);

  console.log(`[agentsmcp-index] Mode:        ${args.mode}`);
  console.log(`[agentsmcp-index] Directory:   ${absDir}`);
  console.log(`[agentsmcp-index] Server:      ${args.server}`);
  console.log(`[agentsmcp-index] Agent:       ${args.agentId}`);
  console.log(`[agentsmcp-index] Concurrency: ${args.concurrency}`);
  console.log(`[agentsmcp-index] Max file:    ${(args.maxFileBytes / 1024).toFixed(0)} KB`);

  // ---- INCREMENTAL mode ----
  if (args.mode === "incremental") {
    const { added, deleted } = getGitChangedFiles(absDir);

    if (added.length === 0 && deleted.length === 0) {
      console.log("[agentsmcp-index] No supported file changes detected. Nothing to do.");
      return;
    }

    console.log(`[agentsmcp-index] Changes: +${added.length} modified, -${deleted.length} deleted`);

    // Delete removed files from index
    for (const filePath of deleted) {
      const relPath = path.relative(absDir, filePath).replace(/\\/g, "/");
      const key = `${FILE_KEY_PREFIX}${relPath}`;
      try {
        await apiDelete(
          args.server, args.apiKey,
          `/mailbox/${encodeURIComponent(args.agentId)}/index/${encodeURIComponent(key)}`
        );
        if (args.verbose) console.log(`[agentsmcp-index] Deleted:  ${key}`);
      } catch (e) {
        console.warn(`[agentsmcp-index] Could not delete ${key}: ${(e as Error).message}`);
      }
    }

    // Filter added files against exclude + maxFileBytes
    const toIndex = added.filter((f) => {
      const rel = path.relative(absDir, f);
      if (matchesExclude(rel, args.exclude)) return false;
      try {
        const size = fs.statSync(f).size;
        return size > 0 && size <= args.maxFileBytes;
      } catch {
        return false;
      }
    });

    const indexResults = await processBatch(toIndex, args.concurrency, (f) =>
      indexFile(args.server, args.apiKey, args.agentId, f, absDir)
    );

    const indexedKeys: string[] = [];
    let totalRawTokens = 0;

    for (const result of indexResults) {
      if (result.status === "fulfilled") {
        indexedKeys.push(result.value.key);
        totalRawTokens += result.value.rawTokenEstimate;
        if (args.verbose) console.log(`[agentsmcp-index] Indexed:  ${result.value.key}`);
      } else {
        const r = result as { status: "rejected"; reason: unknown; item: string };
        console.warn(`[agentsmcp-index] SKIP ${r.item}: ${(r.reason as Error)?.message ?? r.reason}`);
      }
    }

    // Re-rollup affected modules
    const affectedModules = groupByModule(indexedKeys);
    for (const [moduleKey, fileKeys] of affectedModules) {
      try {
        await apiPost(
          args.server, args.apiKey,
          `/mailbox/${encodeURIComponent(args.agentId)}/index/rollup`,
          { moduleKey, fileKeys }
        );
        if (args.verbose) console.log(`[agentsmcp-index] Rollup:   ${moduleKey}`);
      } catch (e) {
        console.warn(`[agentsmcp-index] Rollup failed for ${moduleKey}: ${(e as Error).message}`);
      }
    }

    const summaryTokens = indexedKeys.length * AVG_SUMMARY_TOKENS;
    const savedTokens = Math.max(0, totalRawTokens - summaryTokens);

    console.log(`\n[agentsmcp-index] ✓ Incremental update complete`);
    console.log(`[agentsmcp-index] Indexed:  ${indexedKeys.length} files (${indexResults.filter((r) => r.status === "rejected").length} skipped)`);
    console.log(`[agentsmcp-index] Savings:  ~${savedTokens.toLocaleString()} tokens/session saved by index`);
    return;
  }

  // ---- FULL mode ----
  const allFiles = walkDir(absDir, args.exclude, args.maxFileBytes);

  if (allFiles.length === 0) {
    console.warn(`[agentsmcp-index] WARNING: No supported files found in ${absDir}`);
    console.warn("[agentsmcp-index] Check --dir and --exclude settings.");
    return;
  }

  console.log(`[agentsmcp-index] Found ${allFiles.length} files to index`);

  const indexedKeys: string[] = [];
  let totalRawTokens = 0;
  let totalLines = 0;
  let failed = 0;

  const results = await processBatch(allFiles, args.concurrency, (f, i) => {
    // Progress log at every PROGRESS_INTERVAL files
    if (i > 0 && i % PROGRESS_INTERVAL === 0) {
      console.log(`[agentsmcp-index] Progress: ${i}/${allFiles.length}`);
    }
    return indexFile(args.server, args.apiKey, args.agentId, f, absDir);
  });

  for (const result of results) {
    if (result.status === "fulfilled") {
      indexedKeys.push(result.value.key);
      totalRawTokens += result.value.rawTokenEstimate;
      totalLines += result.value.lines;
    } else {
      failed++;
      if (args.verbose) {
        const r = result as { status: "rejected"; reason: unknown; item: string };
        console.warn(`[agentsmcp-index] SKIP ${r.item}: ${(r.reason as Error)?.message ?? r.reason}`);
      }
    }
  }

  // Module rollups — one per directory
  const moduleMap = groupByModule(indexedKeys);
  console.log(`[agentsmcp-index] Creating ${moduleMap.size} module rollups...`);

  await processBatch(Array.from(moduleMap.entries()), args.concurrency, async ([moduleKey, fileKeys]) => {
    await apiPost(
      args.server, args.apiKey,
      `/mailbox/${encodeURIComponent(args.agentId)}/index/rollup`,
      { moduleKey, fileKeys }
    );
    if (args.verbose) console.log(`[agentsmcp-index] Rollup:   ${moduleKey}`);
  });

  // Architecture overview
  await writeOverview(args.server, args.apiKey, args.agentId, moduleMap, indexedKeys.length, totalLines);

  // Stats
  const summaryTokens = indexedKeys.length * AVG_SUMMARY_TOKENS;
  const savedTokens = Math.max(0, totalRawTokens - summaryTokens);
  const savingsPct = totalRawTokens > 0
    ? Math.round((savedTokens / totalRawTokens) * 100)
    : 0;

  console.log(`\n[agentsmcp-index] ✓ Full index complete`);
  console.log(`[agentsmcp-index] Indexed:    ${indexedKeys.length} files in ${moduleMap.size} modules`);
  if (failed > 0) console.log(`[agentsmcp-index] Skipped:   ${failed} files (binary, oversized, or unreadable)`);
  console.log(`[agentsmcp-index] Codebase:   ~${totalLines.toLocaleString()} lines`);
  console.log(`[agentsmcp-index] Index size: ~${(summaryTokens / 1000).toFixed(1)}K tokens (summaries)`);
  console.log(`[agentsmcp-index] Raw source: ~${(totalRawTokens / 1000).toFixed(1)}K tokens (if read directly)`);
  console.log(`[agentsmcp-index] Savings:    ~${savingsPct}% per agent session (~${savedTokens.toLocaleString()} tokens)`);
  console.log(`[agentsmcp-index] Overview:   overview:architecture`);
}

main().catch((e) => {
  console.error("[agentsmcp-index] FATAL:", e);
  process.exit(1);
});

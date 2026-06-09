/**
 * Context-as-comments: embed structured @context annotations directly in
 * source files so a fresh agent session can pick up file purpose, depends,
 * usedBy, gotchas, and decisions without re-reading the codebase index.
 *
 * Pure string manipulation — no AST parser, no new deps.
 */

/** Per-symbol annotation. Renders as a JSDoc block above the declaration. */
export interface CodeAnnotation {
  /** Required one-line description of what this block does. */
  context: string;
  /** Why this approach was chosen (design rationale). */
  why?: string;
  /** Named design pattern in use. */
  pattern?: string;
  /** Index keys this symbol depends on — e.g. `["file:auth/keys.ts", "sym:getPublicKey"]`. */
  depends?: string[];
  /** Index keys that use this symbol. */
  usedBy?: string[];
  /** Env vars / config keys this code reads. */
  config?: string[];
  /** Known issues, edge cases, traps. */
  gotcha?: string;
  /** Last-edited stamp — e.g. "2026-05-28 by agent-alice: added WS support". */
  changed?: string;
}

/** File-level annotation. Renders as a JSDoc block at the top of the file. */
export interface FileAnnotation {
  /** Module this file belongs to. */
  module?: string;
  /** Required one-line description of what this file does. */
  context: string;
  /** Sibling files in this module. */
  files?: string;
  /** Key design decisions affecting this file. */
  decisions?: string;
  /** Team / owner. */
  owner?: string;
  /** ISO timestamp of last annotation pass. */
  lastIndexed?: string;
  /** SHA of file content (excluding annotation blocks). */
  contentHash?: string;
}

export interface AnnotatableBlock {
  symbolName: string;
  annotation: CodeAnnotation;
}

export interface ParsedBlock {
  /** 1-based line number of the annotated declaration. */
  line: number;
  symbolName: string;
  annotation: CodeAnnotation;
}

export interface ParsedAnnotations {
  fileAnnotation?: FileAnnotation;
  blockAnnotations: ParsedBlock[];
}

export interface AnnotateOptions {
  /** Path regexes to skip. Default: *.d.ts, node_modules, dist, build. */
  skipPatterns?: RegExp[];
  /** Soft wrap width for tag values. Default 80. */
  wrapWidth?: number;
}

const DEFAULT_SKIP_PATTERNS: RegExp[] = [
  /\.d\.ts$/,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.git\//,
];

// Canonical tag order — must stay stable for format→parse→format round-trip.
const CODE_TAG_ORDER = [
  "context", "why", "pattern", "depends", "usedBy", "config", "gotcha", "changed",
] as const;
const FILE_TAG_ORDER = [
  "module", "context", "files", "decisions", "owner", "lastIndexed", "contentHash",
] as const;

const LIST_TAGS = new Set(["depends", "usedBy", "config"]);

// Match an export declaration that begins at the start of a line. Anchoring
// to ^ excludes the vast majority of string-embedded false positives like
// `const x = "export function foo"` while staying parser-free.
const EXPORT_RE =
  /^(\s*)export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/gm;

const TAG_LINE_RE = /^\s*\*?\s*@(\w+)\s*(.*)$/;

/** Parse all annotations (file-level + block-level) from a source file. */
export function parseAnnotations(source: string): ParsedAnnotations {
  const fileAnnotation = parseFileAnnotation(source);
  const blockAnnotations = parseBlockAnnotations(source);
  return fileAnnotation
    ? { fileAnnotation, blockAnnotations }
    : { blockAnnotations };
}

function parseJsdocBody(body: string): Record<string, string | string[]> {
  const tags: Record<string, string | string[]> = {};
  const lines = body.split("\n");
  let currentTag: string | null = null;
  let currentValue: string[] = [];

  const flush = () => {
    if (currentTag !== null) {
      const val = currentValue.join(" ").replace(/\s+/g, " ").trim();
      if (LIST_TAGS.has(currentTag)) {
        tags[currentTag] = val.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        tags[currentTag] = val;
      }
    }
    currentTag = null;
    currentValue = [];
  };

  for (const line of lines) {
    const m = line.match(TAG_LINE_RE);
    if (m) {
      flush();
      currentTag = m[1];
      currentValue = m[2] ? [m[2]] : [];
    } else if (currentTag !== null) {
      const cont = line.replace(/^\s*\*\s?/, "").trim();
      if (cont) currentValue.push(cont);
    }
  }
  flush();
  return tags;
}

function parseFileAnnotation(source: string): FileAnnotation | undefined {
  // File annotation = first JSDoc block at the top of the file that contains @file
  const m = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!m) return undefined;
  const tags = parseJsdocBody(m[1]);
  if (!("file" in tags)) return undefined;

  const fa: FileAnnotation = {
    context: typeof tags.context === "string" ? tags.context : "",
  };
  if (typeof tags.module === "string") fa.module = tags.module;
  if (typeof tags.files === "string") fa.files = tags.files;
  if (typeof tags.decisions === "string") fa.decisions = tags.decisions;
  if (typeof tags.owner === "string") fa.owner = tags.owner;
  if (typeof tags.lastIndexed === "string") fa.lastIndexed = tags.lastIndexed;
  if (typeof tags.contentHash === "string") fa.contentHash = tags.contentHash;
  return fa;
}

function parseBlockAnnotations(source: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  EXPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_RE.exec(source)) !== null) {
    const exportIdx = m.index;
    const symbolName = m[3];
    const jsdoc = findJsdocBefore(source, exportIdx);
    if (!jsdoc) continue;
    const tags = parseJsdocBody(jsdoc.body);
    // Skip JSDocs without @context — those aren't ours
    if (typeof tags.context !== "string") continue;
    // Skip file-level annotations (they have @file)
    if ("file" in tags) continue;

    const annotation: CodeAnnotation = { context: tags.context };
    if (typeof tags.why === "string") annotation.why = tags.why;
    if (typeof tags.pattern === "string") annotation.pattern = tags.pattern;
    if (Array.isArray(tags.depends)) annotation.depends = tags.depends;
    if (Array.isArray(tags.usedBy)) annotation.usedBy = tags.usedBy;
    if (Array.isArray(tags.config)) annotation.config = tags.config;
    if (typeof tags.gotcha === "string") annotation.gotcha = tags.gotcha;
    if (typeof tags.changed === "string") annotation.changed = tags.changed;

    const lineNumber = source.substring(0, exportIdx).split("\n").length;
    blocks.push({ line: lineNumber, symbolName, annotation });
  }
  return blocks;
}

/**
 * Find the JSDoc block immediately preceding `idx` in source. A block is
 * "immediately preceding" when only whitespace separates it from `idx` AND
 * that whitespace is a single newline (no blank line gap). This rule means
 * a file-level annotation separated from the first export by a blank line
 * is NOT considered to belong to that export — important because file and
 * block annotations are written by the same `applyAnnotations` call.
 *
 * Returns null when there is no JSDoc, when the gap is wider than a single
 * newline, or when the matched block is itself a file annotation (`@file`).
 */
function findJsdocBefore(
  source: string,
  idx: number
): { body: string; start: number; end: number } | null {
  const prefix = source.substring(0, idx);
  const trimmed = prefix.replace(/\s+$/, "");
  if (!trimmed.endsWith("*/")) return null;
  const endIdx = trimmed.length;

  // Reject blank-line gaps: trailing-whitespace count must not include
  // more than one "\n". Two or more newlines = blank line = not adjacent.
  const gap = prefix.substring(endIdx);
  if ((gap.match(/\n/g) ?? []).length > 1) return null;

  const startIdx = trimmed.lastIndexOf("/**", endIdx - 2);
  if (startIdx === -1) return null;
  const body = source.substring(startIdx + 3, endIdx - 2);

  // A file-level annotation is not a block annotation. Don't claim it.
  if (/^\s*\*\s*@file\b/m.test(body)) return null;

  return { body, start: startIdx, end: endIdx };
}

/** Render a structured annotation as a JSDoc string. Empty fields are skipped. */
export function formatAnnotation(
  ann: CodeAnnotation | FileAnnotation,
  opts?: { isFile?: boolean; wrapWidth?: number }
): string {
  // Auto-detect file vs code annotation when not given. File annotations have
  // file-only keys (module/lastIndexed/contentHash); without one of those we
  // treat the input as a CodeAnnotation.
  const isFile =
    opts?.isFile ??
    ("module" in ann ||
      "lastIndexed" in ann ||
      "contentHash" in ann ||
      "files" in ann ||
      "decisions" in ann ||
      "owner" in ann);
  const wrapWidth = opts?.wrapWidth ?? 80;
  const lines: string[] = ["/**"];

  if (isFile) {
    lines.push(" * @file");
    const fa = ann as FileAnnotation;
    for (const tag of FILE_TAG_ORDER) {
      const value = (fa as unknown as Record<string, unknown>)[tag];
      if (value === undefined || value === null || value === "") continue;
      appendTag(lines, tag, String(value), wrapWidth);
    }
  } else {
    const ca = ann as CodeAnnotation;
    for (const tag of CODE_TAG_ORDER) {
      const value = (ca as unknown as Record<string, unknown>)[tag];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        appendTag(lines, tag, value.join(", "), wrapWidth);
      } else if (value !== "") {
        appendTag(lines, tag, String(value), wrapWidth);
      }
    }
  }
  lines.push(" */");
  return lines.join("\n");
}

function appendTag(
  lines: string[],
  tag: string,
  value: string,
  wrapWidth: number
): void {
  const prefix = ` * @${tag} `;
  const budget = Math.max(20, wrapWidth - prefix.length);
  const words = value.split(/\s+/);
  const wrapped: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if (cur.length + 1 + w.length <= budget) cur += " " + w;
    else {
      wrapped.push(cur);
      cur = w;
    }
  }
  if (cur) wrapped.push(cur);
  if (wrapped.length === 0) wrapped.push("");
  lines.push(prefix + wrapped[0]);
  for (let i = 1; i < wrapped.length; i++) lines.push(" *   " + wrapped[i]);
}

/**
 * Insert or update annotations in a source file. Symbol annotations replace
 * any preceding JSDoc block; the file annotation (when provided) replaces
 * the existing @file block at the top, or is inserted if none exists.
 */
export function applyAnnotations(
  source: string,
  annotations: AnnotatableBlock[],
  fileAnnotation?: FileAnnotation
): string {
  let result = source;

  // 1. File annotation first so block scanning works on stable positions
  if (fileAnnotation) {
    result = applyFileAnnotation(result, fileAnnotation);
  }

  // 2. Locate every targeted symbol in the (possibly updated) source.
  //    Apply edits from last → first so earlier offsets stay valid.
  const targets: Array<{
    insertAt: number;
    indent: string;
    existing?: { start: number; end: number };
    ann: CodeAnnotation;
  }> = [];

  EXPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_RE.exec(result)) !== null) {
    const symbolName = m[3];
    const target = annotations.find((a) => a.symbolName === symbolName);
    if (!target) continue;

    // m.index points to the start of the leading-whitespace capture, not the
    // start of `export`. Use the captured indent directly.
    const indent = m[1] ?? "";
    const exportIdx = m.index + indent.length;
    const beforeExport = result.substring(0, exportIdx);
    const lineStart = beforeExport.lastIndexOf("\n") + 1;
    const existing = findJsdocBefore(result, exportIdx);

    targets.push({
      insertAt: lineStart,
      indent,
      existing: existing ? { start: existing.start, end: existing.end } : undefined,
      ann: target.annotation,
    });
  }

  // Apply from end to start
  targets.sort((a, b) => b.insertAt - a.insertAt);
  for (const t of targets) {
    const jsdoc = formatAnnotation(t.ann, { isFile: false });
    const indented = jsdoc.split("\n").map((l) => t.indent + l).join("\n");
    if (t.existing) {
      // Replace existing JSDoc. Preserve any whitespace between it and the
      // declaration by leaving content after t.existing.end untouched.
      result = result.substring(0, t.existing.start) + indented + result.substring(t.existing.end);
    } else {
      result =
        result.substring(0, t.insertAt) + indented + "\n" + result.substring(t.insertAt);
    }
  }

  return result;
}

function applyFileAnnotation(source: string, fa: FileAnnotation): string {
  const newJsdoc = formatAnnotation(fa, { isFile: true });
  // Detect existing file-level JSDoc at top
  const m = source.match(/^(\s*)\/\*\*([\s\S]*?)\*\//);
  if (m) {
    const tags = parseJsdocBody(m[2]);
    if ("file" in tags) {
      const matchStart = source.indexOf(m[0]);
      const matchEnd = matchStart + m[0].length;
      const leading = m[1] ?? "";
      return leading + newJsdoc + source.substring(matchEnd);
    }
  }
  // Prepend new file annotation, separating from existing top-of-file content
  // with a single blank line. Don't strip leading whitespace — that can change
  // the contentHash in subtle ways.
  return newJsdoc + "\n\n" + source.replace(/^\n+/, "");
}

/** True when the file should be excluded from annotation. */
export function shouldSkipFile(
  filePath: string,
  opts?: AnnotateOptions
): boolean {
  const patterns = opts?.skipPatterns ?? DEFAULT_SKIP_PATTERNS;
  return patterns.some((p) => p.test(filePath));
}

/** Exposed for callers that want to override the default skip list. */
export const DEFAULT_SKIP = DEFAULT_SKIP_PATTERNS;

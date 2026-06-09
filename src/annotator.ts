/**
 * Auto-annotation engine. Pulls structured context from the agent's graph +
 * codebase index and renders it as @context JSDoc blocks in source files.
 *
 * The agent dependency is intentionally a duck-typed interface so this module
 * does not import AgentMailbox — that would create a circular import once
 * AgentMailbox itself instantiates an Annotator.
 */
import { createHash } from "crypto";
import {
  AnnotatableBlock,
  AnnotateOptions,
  CodeAnnotation,
  FileAnnotation,
  applyAnnotations,
  shouldSkipFile,
} from "./annotations";
import type {
  CodebaseIndexEntry,
  GraphEdge,
  GraphNode,
} from "./storage/interface";

/** Minimal surface of AgentMailbox that Annotator needs. */
export interface AnnotatorAgent {
  getIndex(key: string): Promise<CodebaseIndexEntry | null>;
  queryGraph(
    query: string,
    opts?: { limit?: number; depth?: number }
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
}

export interface AnalyzeResult {
  fileAnnotation: FileAnnotation;
  blockAnnotations: AnnotatableBlock[];
}

const EXPORT_RE =
  /^(\s*)export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/gm;

/** Edge types interpreted as "this symbol depends on the target". */
const DEPENDS_EDGE_TYPES = new Set(["depends_on", "references", "imports"]);

export class Annotator {
  constructor(
    private agent: AnnotatorAgent,
    private opts: AnnotateOptions = {}
  ) {}

  /** Build a complete annotation set for a file without writing it. */
  async analyzeFile(filePath: string, source: string): Promise<AnalyzeResult> {
    const fileKey = `file:${filePath}`;
    const symbols = extractSymbols(source);

    // File-level + per-symbol lookups in parallel.
    const [fileIndex, fileGraph, symbolResults] = await Promise.all([
      this.agent.getIndex(fileKey).catch(() => null),
      this.agent
        .queryGraph(fileKey, { limit: 50 })
        .catch(() => ({ nodes: [], edges: [] })),
      Promise.all(
        symbols.map(async (sym) => {
          const symKey = `sym:${sym}`;
          const [symGraph, symIndex] = await Promise.all([
            this.agent
              .queryGraph(symKey, { limit: 30 })
              .catch(() => ({ nodes: [], edges: [] })),
            this.agent.getIndex(symKey).catch(() => null),
          ]);
          return { sym, symKey, symGraph, symIndex };
        })
      ),
    ]);

    const blockAnnotations: AnnotatableBlock[] = symbolResults.map(
      ({ sym, symKey, symGraph, symIndex }) => ({
        symbolName: sym,
        annotation: this.buildCodeAnnotation(sym, symKey, symGraph, symIndex),
      })
    );

    const fileAnnotation = this.buildFileAnnotation(
      filePath,
      source,
      fileIndex,
      fileGraph
    );

    return { fileAnnotation, blockAnnotations };
  }

  /** Analyze and apply — returns the annotated source. */
  async annotateFile(filePath: string, source: string): Promise<string> {
    if (shouldSkipFile(filePath, this.opts)) return source;
    const { fileAnnotation, blockAnnotations } = await this.analyzeFile(
      filePath,
      source
    );
    return applyAnnotations(source, blockAnnotations, fileAnnotation);
  }

  /**
   * Same as annotateFile, but every block annotation gets its `changed` tag
   * stamped with `editSummary` + the current ISO timestamp. Use as a post-
   * edit hook so the next agent sees what just happened.
   */
  async postEditAnnotate(
    filePath: string,
    source: string,
    editSummary: string
  ): Promise<string> {
    if (shouldSkipFile(filePath, this.opts)) return source;
    const { fileAnnotation, blockAnnotations } = await this.analyzeFile(
      filePath,
      source
    );
    const stamp = `${new Date().toISOString()}: ${editSummary}`;
    const stamped = blockAnnotations.map((b) => ({
      symbolName: b.symbolName,
      annotation: { ...b.annotation, changed: stamp },
    }));
    return applyAnnotations(source, stamped, fileAnnotation);
  }

  private buildCodeAnnotation(
    sym: string,
    symKey: string,
    symGraph: { nodes: GraphNode[]; edges: GraphEdge[] },
    symIndex: CodebaseIndexEntry | null
  ): CodeAnnotation {
    const annotation: CodeAnnotation = {
      context: symIndex?.summary ?? `Exported symbol ${sym}`,
    };

    // depends: outgoing edges where this symbol is source
    const depends = symGraph.edges
      .filter(
        (e) => e.sourceId === symKey && DEPENDS_EDGE_TYPES.has(e.type)
      )
      .map((e) => e.targetId);
    if (depends.length > 0) annotation.depends = uniqueSorted(depends);

    // usedBy: incoming edges where this symbol is target
    const usedBy = symGraph.edges
      .filter(
        (e) => e.targetId === symKey && DEPENDS_EDGE_TYPES.has(e.type)
      )
      .map((e) => e.sourceId);
    if (usedBy.length > 0) annotation.usedBy = uniqueSorted(usedBy);

    // why: connected decision nodes
    const decisionNodes = symGraph.nodes.filter((n) => n.type === "decision");
    if (decisionNodes.length > 0) {
      annotation.why = decisionNodes
        .map((d) => d.description ?? d.name)
        .filter(Boolean)
        .join("; ");
    }

    // pattern / gotcha / config / changed — pulled from index metadata
    const meta = (symIndex?.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta.pattern === "string" && meta.pattern) {
      annotation.pattern = meta.pattern;
    }
    if (typeof meta.knownIssues === "string" && meta.knownIssues) {
      annotation.gotcha = meta.knownIssues;
    } else if (typeof meta.gotcha === "string" && meta.gotcha) {
      annotation.gotcha = meta.gotcha;
    }
    if (Array.isArray(meta.config)) {
      const cfg = meta.config.filter(
        (c): c is string => typeof c === "string" && c.length > 0
      );
      if (cfg.length > 0) annotation.config = cfg;
    }
    if (typeof meta.changed === "string" && meta.changed) {
      annotation.changed = meta.changed;
    } else if (
      typeof meta.lastAnalyzedBy === "string" &&
      typeof meta.lastAnalyzedAt === "string"
    ) {
      annotation.changed = `${meta.lastAnalyzedAt} by ${meta.lastAnalyzedBy}`;
    }

    return annotation;
  }

  private buildFileAnnotation(
    filePath: string,
    source: string,
    fileIndex: CodebaseIndexEntry | null,
    _fileGraph: { nodes: GraphNode[]; edges: GraphEdge[] }
  ): FileAnnotation {
    const meta = (fileIndex?.metadata ?? {}) as Record<string, unknown>;
    const fa: FileAnnotation = {
      context: fileIndex?.summary ?? `File ${filePath}`,
    };
    if (fileIndex?.parentKey) {
      fa.module = fileIndex.parentKey.replace(/^module:/, "");
    }
    if (typeof meta.files === "string" && meta.files) fa.files = meta.files;
    if (typeof meta.decisions === "string" && meta.decisions)
      fa.decisions = meta.decisions;
    if (typeof meta.owner === "string" && meta.owner) fa.owner = meta.owner;
    fa.lastIndexed = new Date().toISOString();
    fa.contentHash = hashStrippedSource(source);
    return fa;
  }
}

/** Extract names of exported declarations starting at the beginning of a line. */
export function extractSymbols(source: string): string[] {
  const out: string[] = [];
  EXPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_RE.exec(source)) !== null) {
    out.push(m[3]);
  }
  return out;
}

function uniqueSorted(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort();
}

/**
 * Hash the source with all JSDoc blocks stripped AND all whitespace runs
 * collapsed so the hash is stable across annotation passes. Without the
 * whitespace collapse, removing a JSDoc leaves trailing blank lines and the
 * hash flips on every annotate call.
 */
function hashStrippedSource(source: string): string {
  const stripped = source
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(stripped).digest("hex").slice(0, 16);
}

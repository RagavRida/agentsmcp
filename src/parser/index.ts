// ============================================================
// Mainframe Parser Integration — Self-Contained API Layer
// Provides COBOL/JCL parsing as clean functions for MCP tools.
// Zero LLM calls. Deterministic. EU Sovereign.
//
// This module re-implements the high-level pipeline functions
// inline, importing parser classes lazily so the main project
// doesn't need to change its tsconfig or module resolution.
// ============================================================

// We load parser classes lazily via a helper so the main package
// can build even if the parser directory isn't compiled yet.
// At runtime we load from the pre-compiled CommonJS output (dist-cjs).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cachedClasses: Record<string, any> | null = null;

function loadParserClasses() {
  if (_cachedClasses) return _cachedClasses;

  /* eslint-disable @typescript-eslint/no-var-requires */
  const path = require("path");

  // Try the pre-compiled CJS dist first, fall back to source for dev
  const cjsDist = path.resolve(__dirname, "../../parser/dist-cjs");
  const srcDir = path.resolve(__dirname, "../../parser/src");
  const fs = require("fs");
  const parserRoot = fs.existsSync(path.join(cjsDist, "types.js")) &&
    fs.existsSync(path.join(cjsDist, "registry.js"))
    ? cjsDist
    : srcDir;
  if (parserRoot === srcDir) {
    try {
      require("ts-node").register({
        transpileOnly: true,
        compilerOptions: {
          module: "commonjs",
          moduleResolution: "node",
        },
      });
    } catch {
      // Test/build environments often preload TS support. If registration is
      // unavailable, fall through and let the require surface the real error.
    }
  }
  const modulePath = (name: string): string =>
    parserRoot === srcDir
      ? path.join(parserRoot, `${name}.ts`)
      : path.join(parserRoot, name);

  const types = require(modulePath("types"));
  const cobolParser = require(modulePath("cobol-parser"));
  const jclParser = require(modulePath("jcl-parser"));
  const edgeExtractor = require(modulePath("edge-extractor"));
  const semanticElevator = require(modulePath("semantic-elevator"));
  const copybookResolver = require(modulePath("copybook-resolver"));
  const registry = require(modulePath("registry"));

  _cachedClasses = {
    ASTNodeType: types.ASTNodeType,
    COBOLParser: cobolParser.COBOLParser,
    JCLParser: jclParser.JCLParser,
    EdgeExtractor: edgeExtractor.EdgeExtractor,
    SemanticElevator: semanticElevator.SemanticElevator,
    CopybookResolver: copybookResolver.CopybookResolver,
    parseMainframe: registry.parseMainframe,
    parseMainframeAsync: (source: string, options: Record<string, unknown>) =>
      registry.defaultParserRegistry.parseAsync(source, options),
    detectMainframeLanguage: registry.detectMainframeLanguage,
  };
  return _cachedClasses;
}

// ---- Public Interfaces ----

export interface SemanticNodeCompact {
  id: string;
  type: string;
  description: string;
  domain: string;
  inputs: string[];
  outputs: string[];
  sideEffects: string[];
  children: SemanticNodeCompact[];
}

export interface GraphEdgeCompact {
  source: string;
  target: string;
  type: string;
}

export interface GraphNodeCompact {
  id: string;
  label: string;
  type: string;
}

export interface ParseCobolResult {
  programName: string;
  semanticTree: SemanticNodeCompact;
  graph: {
    nodes: GraphNodeCompact[];
    edges: GraphEdgeCompact[];
  };
  businessRules: SemanticNodeCompact[];
  dataAccess: SemanticNodeCompact[];
  controlFlow: SemanticNodeCompact[];
  dataTransforms: SemanticNodeCompact[];
  stats: {
    paragraphs: number;
    variables: number;
    graphNodes: number;
    graphEdges: number;
    llmCalls: 0;
    codeSentExternally: "0 bytes";
  };
}

export interface ParseJclResult {
  jobName: string;
  semanticTree: SemanticNodeCompact;
  graph: {
    nodes: GraphNodeCompact[];
    edges: GraphEdgeCompact[];
  };
  stats: {
    steps: number;
    datasets: number;
    graphNodes: number;
    graphEdges: number;
    llmCalls: 0;
  };
}

export type MainframeLanguage = "auto" | "cobol" | "jcl" | "pli" | "rexx" | "unknown";

export interface ParseMainframeResult {
  language: Exclude<MainframeLanguage, "auto">;
  programName: string;
  semanticTree: SemanticNodeCompact;
  graph: {
    nodes: GraphNodeCompact[];
    edges: GraphEdgeCompact[];
  };
  businessRules: SemanticNodeCompact[];
  dataAccess: SemanticNodeCompact[];
  controlFlow: SemanticNodeCompact[];
  externalCalls: SemanticNodeCompact[];
  stats: {
    astNodes: number;
    graphNodes: number;
    graphEdges: number;
    semanticNodes: number;
    llmCalls: number;
    llmTokensUsed?: number;
    llmLatencyMs?: number;
    codeSentExternally: string;
  };
}

// ---- Helpers ----

function compactSemantic(node: Record<string, unknown>): SemanticNodeCompact {
  return {
    id: String(node.id || ""),
    type: String(node.type || ""),
    description: String(node.description || ""),
    domain: String(node.domain || "General"),
    inputs: (node.inputs as string[]) || [],
    outputs: (node.outputs as string[]) || [],
    sideEffects: (node.sideEffects as string[]) || [],
    children: ((node.children as Record<string, unknown>[]) || []).map(compactSemantic),
  };
}

function collectByType(node: SemanticNodeCompact, type: string): SemanticNodeCompact[] {
  const result: SemanticNodeCompact[] = [];
  if (node.type === type) result.push(node);
  for (const child of node.children) {
    result.push(...collectByType(child, type));
  }
  return result;
}

// ---- Public API ----

/**
 * Parse a COBOL source string through the full pipeline:
 * Preprocessing → AST → Knowledge Graph → Abstract Semantic Tree.
 *
 * Returns the semantic tree, graph, and categorized business logic.
 * Zero LLM calls. All analysis is deterministic.
 */
export function parseCobol(
  source: string,
  options?: { filename?: string; copybooks?: Record<string, string> }
): ParseCobolResult {
  const classes = loadParserClasses();

  // Phase 0: Resolve copybooks
  const resolver = new classes.CopybookResolver();
  if (options?.copybooks) {
    for (const [name, content] of Object.entries(options.copybooks)) {
      resolver.registerCopybook(name, content);
    }
  }
  const expandedSource = resolver.resolve(source);

  // Phase 1: Parse to AST
  const parser = new classes.COBOLParser();
  const ast = parser.parse(expandedSource);

  // Phase 2: Extract knowledge graph
  const extractor = new classes.EdgeExtractor();
  const filename = options?.filename || `${ast.name}.CBL`;
  extractor.extractFromCOBOL(ast, filename);
  const graph = extractor.getGraph();

  // Phase 3: Elevate to semantic tree
  const elevator = new classes.SemanticElevator();
  const semanticTree = compactSemantic(elevator.elevate(ast));

  // Count paragraphs and variables
  let paragraphs = 0;
  let variables = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function countNodes(node: any): void {
    if (node.type === classes.ASTNodeType.COBOL_PARAGRAPH_NODE) paragraphs++;
    if (node.type === classes.ASTNodeType.COBOL_VARIABLE_NODE) variables++;
    for (const child of node.children) countNodes(child);
  }
  countNodes(ast);

  return {
    programName: ast.name,
    semanticTree,
    graph: {
      nodes: graph.nodes.map((n: Record<string, unknown>) => ({
        id: String(n.id),
        label: String(n.label),
        type: String(n.type),
      })),
      edges: graph.edges.map((e: Record<string, unknown>) => ({
        source: String(e.source),
        target: String(e.target),
        type: String(e.type),
      })),
    },
    businessRules: collectByType(semanticTree, "BUSINESS_RULE"),
    dataAccess: collectByType(semanticTree, "DATA_ACCESS"),
    controlFlow: collectByType(semanticTree, "CONTROL_FLOW"),
    dataTransforms: collectByType(semanticTree, "DATA_TRANSFORM"),
    stats: {
      paragraphs,
      variables,
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      llmCalls: 0,
      codeSentExternally: "0 bytes",
    },
  };
}

/**
 * Parse a JCL source string through the full pipeline:
 * Tokenization → AST → Knowledge Graph → Abstract Semantic Tree.
 *
 * Returns the semantic tree, graph, and job statistics.
 * Zero LLM calls. All analysis is deterministic.
 */
export function parseJcl(
  source: string,
  options?: { filename?: string }
): ParseJclResult {
  const classes = loadParserClasses();

  // Phase 1: Parse to AST
  const parser = new classes.JCLParser();
  const ast = parser.parse(source);

  // Phase 2: Extract knowledge graph
  const extractor = new classes.EdgeExtractor();
  const filename = options?.filename || `${ast.name}.JCL`;
  extractor.extractFromJCL(ast, filename);
  const graph = extractor.getGraph();

  // Phase 3: Elevate to semantic tree
  const elevator = new classes.SemanticElevator();
  const semanticTree = compactSemantic(elevator.elevate(ast));

  // Count steps and datasets
  const steps = ast.children.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => c.type === classes.ASTNodeType?.JCL_STEP || c.type === "JCL_STEP"
  ).length;
  const datasets = graph.nodes.filter(
    (n: Record<string, unknown>) => n.type === "DATASET"
  ).length;

  return {
    jobName: ast.name,
    semanticTree,
    graph: {
      nodes: graph.nodes.map((n: Record<string, unknown>) => ({
        id: String(n.id),
        label: String(n.label),
        type: String(n.type),
      })),
      edges: graph.edges.map((e: Record<string, unknown>) => ({
        source: String(e.source),
        target: String(e.target),
        type: String(e.type),
      })),
    },
    stats: {
      steps,
      datasets,
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      llmCalls: 0,
    },
  };
}

export function parseMainframeSource(
  source: string,
  options?: { filename?: string; language?: MainframeLanguage }
): ParseMainframeResult {
  const classes = loadParserClasses();
  const result = classes.parseMainframe(source, {
    filename: options?.filename,
    language: options?.language ?? "auto",
  });
  return compactMainframeResult(result);
}

/**
 * Async version that supports LLM fallback for unknown languages.
 * When the source is COBOL/JCL/PL/I/REXX, this returns instantly.
 * When the language is unknown, it sends the source to the on-prem
 * LLM (GLM-5.2-FP8 / vLLM / Ollama) for semantic extraction.
 */
export async function parseMainframeSourceAsync(
  source: string,
  options?: { filename?: string; language?: MainframeLanguage }
): Promise<ParseMainframeResult> {
  const classes = loadParserClasses();
  const result = await classes.parseMainframeAsync(source, {
    filename: options?.filename,
    language: options?.language ?? "auto",
  });
  return compactMainframeResult(result);
}

export function parsePli(
  source: string,
  options?: { filename?: string }
): ParseMainframeResult {
  return parseMainframeSource(source, {
    ...options,
    language: "pli",
  });
}

export function parseRexx(
  source: string,
  options?: { filename?: string }
): ParseMainframeResult {
  return parseMainframeSource(source, {
    ...options,
    language: "rexx",
  });
}

export function detectMainframeLanguage(
  source: string,
  options?: { filename?: string }
): Exclude<MainframeLanguage, "auto"> {
  const classes = loadParserClasses();
  return classes.detectMainframeLanguage(source, options);
}

function compactMainframeResult(result: any): ParseMainframeResult {
  return {
    language: result.language,
    programName: result.programName,
    semanticTree: compactSemantic(result.semanticTree),
    graph: {
      nodes: (result.graph?.nodes ?? []).map((n: Record<string, unknown>) => ({
        id: String(n.id),
        label: String(n.label),
        type: String(n.type),
      })),
      edges: (result.graph?.edges ?? []).map((e: Record<string, unknown>) => ({
        source: String(e.source),
        target: String(e.target),
        type: String(e.type),
      })),
    },
    businessRules: ((result.businessRules ?? []) as Record<string, unknown>[]).map(compactSemantic),
    dataAccess: ((result.dataAccess ?? []) as Record<string, unknown>[]).map(compactSemantic),
    controlFlow: ((result.controlFlow ?? []) as Record<string, unknown>[]).map(compactSemantic),
    externalCalls: ((result.externalCalls ?? []) as Record<string, unknown>[]).map(compactSemantic),
    stats: {
      astNodes: Number(result.stats?.astNodes ?? 0),
      graphNodes: Number(result.stats?.graphNodes ?? 0),
      graphEdges: Number(result.stats?.graphEdges ?? 0),
      semanticNodes: Number(result.stats?.semanticNodes ?? 0),
      llmCalls: Number(result.stats?.llmCalls ?? 0),
      llmTokensUsed: result.stats?.llmTokensUsed,
      llmLatencyMs: result.stats?.llmLatencyMs,
      codeSentExternally: String(result.stats?.codeSentExternally ?? "0 bytes"),
    },
  };
}

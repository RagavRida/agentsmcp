import { COBOLParser } from './cobol-parser.js';
import { EdgeExtractor } from './edge-extractor.js';
import { JCLParser } from './jcl-parser.js';
import { PLISemanticElevator } from './pli-semantic.js';
import { PLIParser } from './pli-parser.js';
import { REXXParser } from './rexx-parser.js';
import { SemanticElevator, SemanticNode, SemanticNodeType } from './semantic-elevator.js';
import { ASTNode, ASTNodeType, EdgeType, GraphEdge, GraphNode, KnowledgeGraph } from './types.js';
import { llmFallbackParse, type LLMParseResult } from './llm-fallback-parser.js';

export type MainframeLanguage = 'cobol' | 'jcl' | 'pli' | 'rexx' | 'unknown';

export interface ParserRegistryOptions {
  filename?: string;
  language?: MainframeLanguage | 'auto';
}

export interface MainframeParseResult {
  language: MainframeLanguage;
  programName: string;
  ast: ASTNode;
  semanticTree: SemanticNode;
  graph: KnowledgeGraph;
  businessRules: SemanticNode[];
  dataAccess: SemanticNode[];
  controlFlow: SemanticNode[];
  externalCalls: SemanticNode[];
  stats: {
    astNodes: number;
    graphNodes: number;
    graphEdges: number;
    semanticNodes: number;
    llmCalls: number;
    llmTokensUsed?: number;
    llmLatencyMs?: number;
    codeSentExternally?: string;
  };
}

export class ParserRegistry {
  detect(source: string, options: ParserRegistryOptions = {}): MainframeLanguage {
    if (options.language && options.language !== 'auto') return options.language;
    const fromExtension = detectByExtension(options.filename);
    if (fromExtension) return fromExtension;
    return detectByContent(source);
  }

  /**
   * Synchronous parse for known languages.
   * For unknown languages, use parseAsync() which calls the on-prem LLM.
   */
  parse(source: string, options: ParserRegistryOptions = {}): MainframeParseResult {
    const language = this.detect(source, options);
    switch (language) {
      case 'cobol':
        return parseCobolRegistered(source, options.filename);
      case 'jcl':
        return parseJclRegistered(source, options.filename);
      case 'pli':
        return parsePliRegistered(source, options.filename);
      case 'rexx':
        return parseRexxRegistered(source, options.filename);
      case 'unknown':
        // Synchronous fallback: return a minimal result with a flag
        // indicating the caller should use parseAsync() instead.
        return buildUnknownPlaceholder(source, options.filename);
    }
  }

  /**
   * Async parse that supports LLM fallback for unknown languages.
   * For known languages (COBOL, JCL, PL/I, REXX), this is identical
   * to parse() — just wrapped in a promise. For unknown languages,
   * it sends the source to the on-prem LLM.
   */
  async parseAsync(source: string, options: ParserRegistryOptions = {}): Promise<MainframeParseResult> {
    const language = this.detect(source, options);
    if (language !== 'unknown') {
      return this.parse(source, options);
    }
    return parseLLMFallback(source, options.filename);
  }
}

export const defaultParserRegistry = new ParserRegistry();

export function detectMainframeLanguage(source: string, options: ParserRegistryOptions = {}): MainframeLanguage {
  return defaultParserRegistry.detect(source, options);
}

export function parseMainframe(source: string, options: ParserRegistryOptions = {}): MainframeParseResult {
  return defaultParserRegistry.parse(source, options);
}

function parseCobolRegistered(source: string, filename?: string): MainframeParseResult {
  const parser = new COBOLParser();
  const ast = parser.parse(source);
  const semanticTree = new SemanticElevator().elevate(ast);
  const extractor = new EdgeExtractor();
  extractor.extractFromCOBOL(ast, filename ?? `${ast.name}.CBL`);
  return buildResult('cobol', ast.name, ast, semanticTree, extractor.getGraph());
}

function parseJclRegistered(source: string, filename?: string): MainframeParseResult {
  const parser = new JCLParser();
  const ast = parser.parse(source);
  const semanticTree = new SemanticElevator().elevate(ast);
  const extractor = new EdgeExtractor();
  extractor.extractFromJCL(ast, filename ?? `${ast.name}.JCL`);
  return buildResult('jcl', ast.name, ast, semanticTree, extractor.getGraph());
}

function parsePliRegistered(source: string, filename?: string): MainframeParseResult {
  const parser = new PLIParser();
  const ast = parser.parse(source);
  const semanticTree = new PLISemanticElevator().elevate(ast);
  const graph = buildPliGraph(ast, filename ?? `${ast.name}.PLI`);
  return buildResult('pli', ast.name, ast, semanticTree, graph);
}

function parseRexxRegistered(source: string, filename?: string): MainframeParseResult {
  const parser = new REXXParser();
  const ast = parser.parse(source);
  const semanticTree = elevateRexx(ast);
  const graph = buildRexxGraph(ast, filename ?? `${ast.name}.REXX`);
  return buildResult('rexx', ast.name, ast, semanticTree, graph);
}

function buildResult(
  language: MainframeLanguage,
  programName: string,
  ast: ASTNode,
  semanticTree: SemanticNode,
  graph: KnowledgeGraph,
): MainframeParseResult {
  return {
    language,
    programName,
    ast,
    semanticTree,
    graph,
    businessRules: collectSemanticNodes(semanticTree, SemanticNodeType.BUSINESS_RULE),
    dataAccess: collectSemanticNodes(semanticTree, SemanticNodeType.DATA_ACCESS),
    controlFlow: collectSemanticNodes(semanticTree, SemanticNodeType.CONTROL_FLOW),
    externalCalls: collectSemanticNodes(semanticTree, SemanticNodeType.EXTERNAL_CALL),
    stats: {
      astNodes: countASTNodes(ast),
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      semanticNodes: countSemanticNodes(semanticTree),
      llmCalls: 0,
    },
  };
}

function detectByExtension(filename?: string): MainframeLanguage | undefined {
  const ext = filename?.toLowerCase().split('.').pop();
  if (!ext) return undefined;
  if (['cbl', 'cob', 'cobol'].includes(ext)) return 'cobol';
  if (['jcl', 'job', 'proc'].includes(ext)) return 'jcl';
  if (['pli', 'pl1', 'plx'].includes(ext)) return 'pli';
  if (['rexx', 'rex', 'exec'].includes(ext)) return 'rexx';
  return undefined;
}

function detectByContent(source: string): MainframeLanguage {
  const upper = source.toUpperCase();
  // JCL: starts with // followed by jobname/stepname
  if (/^\s*\/\/[A-Z0-9$#@]+\s+JOB\b/m.test(source) || /^\s*\/\/\S+\s+EXEC\b/m.test(source)) return 'jcl';
  // COBOL: has IDENTIFICATION/PROCEDURE DIVISION
  if (/\bIDENTIFICATION\s+DIVISION\b/.test(upper) || /\bPROCEDURE\s+DIVISION\b/.test(upper)) return 'cobol';
  // PL/I: has DCL/DECLARE + PROC/PROCEDURE
  if (/\b(DCL|DECLARE)\b/.test(upper) && /\b(PROC|PROCEDURE)\b/.test(upper)) return 'pli';
  // REXX: has PARSE ARG/VAR/PULL or SAY
  if (/\bPARSE\s+(ARG|VAR|PULL|SOURCE)\b/.test(upper) || /\bSAY\s+/.test(upper)) return 'rexx';
  // COBOL (loose): has column-based structure with numbered lines
  if (/^\d{6}\s/m.test(source) && /\bPERFORM\b/.test(upper)) return 'cobol';
  // PL/I (loose): has PROC/PROCEDURE without DIVISION
  if (/\b(PROC|PROCEDURE)\b/.test(upper) && !/DIVISION/.test(upper)) return 'pli';
  // Unknown — will be handled by LLM fallback
  return 'unknown';
}

function buildPliGraph(ast: ASTNode, file: string): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  addNode(nodes, ast.name, ast.name, 'PROGRAM', file);
  walkAST(ast, (node) => {
    if (node.type === ASTNodeType.PLI_CALL_NODE) {
      const target = String(node.meta.target ?? node.name);
      addNode(nodes, target, target, 'PROGRAM');
      addEdge(edges, ast.name, target, EdgeType.EXTERNAL_CALL, file, node.loc.startLine);
    }
    if (node.type === ASTNodeType.PLI_EXEC_SQL_NODE) {
      for (const table of normalizeStringArray(node.meta.tables)) {
        addNode(nodes, table, table, 'TABLE');
        addEdge(edges, ast.name, table, EdgeType.DATA_ACCESS, file, node.loc.startLine);
      }
    }
  });
  return { nodes: Array.from(nodes.values()), edges };
}

function buildRexxGraph(ast: ASTNode, file: string): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  addNode(nodes, ast.name, ast.name, 'PROGRAM', file);
  walkAST(ast, (node) => {
    if (node.type === ASTNodeType.REXX_CALL_NODE) {
      const target = String(node.meta.target ?? node.name);
      addNode(nodes, target, target, 'PROGRAM');
      addEdge(edges, ast.name, target, EdgeType.EXTERNAL_CALL, file, node.loc.startLine);
    }
  });
  return { nodes: Array.from(nodes.values()), edges };
}

function elevateRexx(ast: ASTNode): SemanticNode {
  const children = ast.children.map((child, index) => elevateRexxNode(child, index + 1));
  return {
    id: 'rexx_sem_0',
    type: SemanticNodeType.WORKFLOW,
    description: `REXX script: ${ast.name}`,
    domain: 'General' as SemanticNode['domain'],
    inputs: children.flatMap((child) => child.inputs),
    outputs: children.flatMap((child) => child.outputs),
    sideEffects: children.flatMap((child) => child.sideEffects),
    children,
    sourceAST: { type: ast.type, name: ast.name, loc: ast.loc },
  };
}

function elevateRexxNode(ast: ASTNode, id: number): SemanticNode {
  const type = ast.type === ASTNodeType.REXX_CALL_NODE
    ? SemanticNodeType.EXTERNAL_CALL
    : ast.type === ASTNodeType.REXX_IF_NODE || ast.type === ASTNodeType.REXX_DO_NODE
      ? SemanticNodeType.CONTROL_FLOW
      : SemanticNodeType.GENERAL;
  const target = typeof ast.meta.target === 'string' ? ast.meta.target : ast.name;
  return {
    id: `rexx_sem_${id}`,
    type,
    description: describeRexxNode(ast, target),
    domain: 'General' as SemanticNode['domain'],
    inputs: [],
    outputs: [],
    sideEffects: type === SemanticNodeType.EXTERNAL_CALL ? [`Calls ${target}`] : [],
    children: [],
    sourceAST: { type: ast.type, name: ast.name, loc: ast.loc },
  };
}

function describeRexxNode(ast: ASTNode, target: string): string {
  switch (ast.type) {
    case ASTNodeType.REXX_SAY_NODE: return `Display message: ${String(ast.meta.message ?? '')}`;
    case ASTNodeType.REXX_CALL_NODE: return `Call external routine: ${target}`;
    case ASTNodeType.REXX_DO_NODE: return `Iterative block: ${String(ast.meta.condition ?? '')}`;
    case ASTNodeType.REXX_IF_NODE: return `Conditional branch: ${String(ast.meta.condition ?? '')}`;
    case ASTNodeType.REXX_PARSE_NODE: return `Parse ${String(ast.meta.source ?? '')} with template ${String(ast.meta.template ?? '')}`;
    default: return ast.name;
  }
}

function addNode(nodes: Map<string, GraphNode>, id: string, label: string, type: GraphNode['type'], file?: string): void {
  if (!nodes.has(id)) nodes.set(id, { id, label, type, file });
}

function addEdge(edges: GraphEdge[], source: string, target: string, type: EdgeType, file: string, line: number): void {
  if (edges.some((edge) => edge.source === source && edge.target === target && edge.type === type)) return;
  edges.push({ source, target, type, loc: { file, line } });
}

function walkAST(node: ASTNode, visit: (node: ASTNode) => void): void {
  visit(node);
  for (const child of node.children) walkAST(child, visit);
}

function collectSemanticNodes(node: SemanticNode, type: SemanticNodeType): SemanticNode[] {
  const result: SemanticNode[] = [];
  if (node.type === type) result.push(node);
  for (const child of node.children) result.push(...collectSemanticNodes(child, type));
  return result;
}

function countASTNodes(node: ASTNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countASTNodes(child), 0);
}

function countSemanticNodes(node: SemanticNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countSemanticNodes(child), 0);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

// ── Unknown Language Handlers ──────────────────────────

/**
 * Synchronous placeholder for unknown languages.
 * Returns a minimal result. Callers should prefer parseAsync()
 * which will invoke the on-prem LLM for real extraction.
 */
function buildUnknownPlaceholder(source: string, filename?: string): MainframeParseResult {
  const totalLines = source.split(/\r?\n/).length;
  const name = filename
    ? filename.replace(/\.[^.]+$/, '').split('/').pop() ?? 'UNKNOWN'
    : 'UNKNOWN';

  const ast: ASTNode = {
    type: ASTNodeType.COBOL_PROGRAM,
    name,
    children: [],
    meta: { language: 'unknown', needsLLM: true },
    loc: { startLine: 1, endLine: totalLines },
  };

  const semanticTree: SemanticNode = {
    id: 'unknown_sem_0',
    type: SemanticNodeType.GENERAL,
    description: `Unknown language program: ${name}. Use parseAsync() with an LLM provider for full analysis.`,
    domain: 'General' as SemanticNode['domain'],
    inputs: [],
    outputs: [],
    sideEffects: [],
    children: [],
    sourceAST: { type: ast.type, name: ast.name, loc: ast.loc },
  };

  return {
    language: 'unknown',
    programName: name,
    ast,
    semanticTree,
    graph: { nodes: [], edges: [] },
    businessRules: [],
    dataAccess: [],
    controlFlow: [],
    externalCalls: [],
    stats: {
      astNodes: 1,
      graphNodes: 0,
      graphEdges: 0,
      semanticNodes: 1,
      llmCalls: 0,
      codeSentExternally: '0 bytes — use parseAsync() for LLM analysis',
    },
  };
}

/**
 * Async LLM fallback for unknown languages.
 * Sends the source to the on-prem model (GLM-5.2-FP8 / vLLM / Ollama)
 * and converts the LLM response into standard SemanticNodes.
 */
async function parseLLMFallback(source: string, filename?: string): Promise<MainframeParseResult> {
  const llmResult = await llmFallbackParse(source, { filename });

  const graph: KnowledgeGraph = buildLLMGraph(llmResult, filename);

  return {
    language: 'unknown',
    programName: llmResult.programName,
    ast: llmResult.ast,
    semanticTree: llmResult.semanticTree,
    graph,
    businessRules: collectSemanticNodes(llmResult.semanticTree, SemanticNodeType.BUSINESS_RULE),
    dataAccess: collectSemanticNodes(llmResult.semanticTree, SemanticNodeType.DATA_ACCESS),
    controlFlow: collectSemanticNodes(llmResult.semanticTree, SemanticNodeType.CONTROL_FLOW),
    externalCalls: collectSemanticNodes(llmResult.semanticTree, SemanticNodeType.EXTERNAL_CALL),
    stats: {
      astNodes: countASTNodes(llmResult.ast),
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      semanticNodes: countSemanticNodes(llmResult.semanticTree),
      llmCalls: 1,
      llmTokensUsed: llmResult.llmTokensUsed,
      llmLatencyMs: llmResult.llmLatencyMs,
      codeSentExternally: `${Buffer.byteLength(source)} bytes → on-prem ${llmResult.detectedLanguage}`,
    },
  };
}

function buildLLMGraph(llmResult: LLMParseResult, filename?: string): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const file = filename ?? `${llmResult.programName}.SRC`;

  addNode(nodes, llmResult.programName, llmResult.programName, 'PROGRAM', file);

  // Walk the semantic tree to extract graph edges
  walkSemanticTree(llmResult.semanticTree, (node) => {
    if (node.type === SemanticNodeType.EXTERNAL_CALL) {
      for (const effect of node.sideEffects) {
        const callMatch = effect.match(/Calls?\s+(.+)/i);
        if (callMatch) {
          const target = callMatch[1].trim();
          addNode(nodes, target, target, 'PROGRAM');
          addEdge(edges, llmResult.programName, target, EdgeType.EXTERNAL_CALL, file, 1);
        }
      }
    }
    if (node.type === SemanticNodeType.DATA_ACCESS) {
      for (const input of node.inputs) {
        addNode(nodes, input, input, 'TABLE');
        addEdge(edges, llmResult.programName, input, EdgeType.READS, file, 1);
      }
      for (const output of node.outputs) {
        addNode(nodes, output, output, 'TABLE');
        addEdge(edges, llmResult.programName, output, EdgeType.WRITES, file, 1);
      }
    }
  });

  return { nodes: Array.from(nodes.values()), edges };
}

function walkSemanticTree(node: SemanticNode, visit: (node: SemanticNode) => void): void {
  visit(node);
  for (const child of node.children) walkSemanticTree(child, visit);
}

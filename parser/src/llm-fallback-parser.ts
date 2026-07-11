// ============================================================
// LLM Fallback Parser — For Unknown Mainframe Languages
//
// When the deterministic parser registry cannot identify a
// language (Easytrieve, Natural, RPG, HLASM, SAS, etc.),
// this module sends the source to the on-prem LLM to extract
// semantic nodes.
//
// Uses the model provider from src/model/provider.ts which
// supports Modal GLM-5.2-FP8, vLLM, Ollama, DeepSeek, OpenAI.
//
// The source code is sent to YOUR OWN on-prem model —
// it never leaves your infrastructure.
// ============================================================

import { ASTNode, ASTNodeType } from './types.js';
import {
  SemanticNode,
  SemanticNodeType,
  BusinessDomain,
} from './semantic-elevator.js';

// ── Types ──────────────────────────────────────────────

export interface LLMParseOptions {
  filename?: string;
  /** Hint about the language (e.g. "easytrieve", "natural", "rpg") */
  languageHint?: string;
  /** Max tokens for the LLM response */
  maxTokens?: number;
  /** Temperature for generation (lower = more deterministic) */
  temperature?: number;
}

export interface LLMParseResult {
  programName: string;
  detectedLanguage: string;
  ast: ASTNode;
  semanticTree: SemanticNode;
  llmTokensUsed: number;
  llmLatencyMs: number;
}

// ── System Prompt ──────────────────────────────────────

const SYSTEM_PROMPT = `You are a mainframe code analysis engine. You receive source code in legacy mainframe languages (Easytrieve, Natural, RPG, HLASM/Assembler, SAS, FOCUS, ADS/Online, IDMS, or any other mainframe language).

Your task is to extract a structured semantic analysis as JSON. Do NOT explain or summarize — return ONLY the JSON object.

The JSON must have this exact structure:
{
  "programName": "string - the program/script/module name",
  "detectedLanguage": "string - the language you identified (e.g. 'easytrieve', 'natural', 'rpg', 'hlasm', 'sas')",
  "functions": [
    {
      "name": "string - function/paragraph/subroutine name",
      "type": "BUSINESS_RULE | DATA_ACCESS | DATA_TRANSFORM | CONTROL_FLOW | EXTERNAL_CALL | TRANSACTION | DATA_DEFINITION | GENERAL",
      "description": "string - what this function does in business terms",
      "domain": "Taxation | Payments | Risk Assessment | Customer Management | Account Management | Audit & Compliance | Reporting | Authentication | Pricing | General",
      "inputs": ["string - data items consumed"],
      "outputs": ["string - data items produced"],
      "sideEffects": ["string - external effects like DB writes, file I/O, CICS calls"],
      "calls": ["string - other functions/programs called"]
    }
  ],
  "variables": [
    {
      "name": "string",
      "type": "string - data type description",
      "usage": "string - business purpose"
    }
  ],
  "dataAccess": [
    {
      "target": "string - file/table/dataset name",
      "operation": "READ | WRITE | UPDATE | DELETE",
      "description": "string"
    }
  ],
  "externalCalls": [
    {
      "target": "string - called program/service",
      "description": "string"
    }
  ]
}

Rules:
1. Extract EVERY function, paragraph, subroutine, or logical block
2. Identify business domain from variable names and operations
3. Track all data access (files, databases, datasets)
4. Track all external program calls
5. Be specific about business logic — "Calculates provincial tax rate" not "Does calculation"
6. Return ONLY valid JSON, no markdown, no explanation`;

// ── Core Parser ────────────────────────────────────────

/**
 * Parse unknown mainframe source code using the on-prem LLM.
 * Requires a model provider to be configured (env vars).
 */
export async function llmFallbackParse(
  source: string,
  options: LLMParseOptions = {},
): Promise<LLMParseResult> {
  // Dynamically import the model provider to avoid circular deps
  // and to keep the parser module independent of src/
  const { generate, detectModelConfig } = await loadModelProvider();

  const config = detectModelConfig();
  if (config.provider === 'none') {
    throw new Error(
      'LLM fallback parser requires a model provider. Set one of: ' +
      'AGENTSMCP_MODAL_ENDPOINT_URL, AGENTSMCP_VLLM_URL, OLLAMA_URL, ' +
      'DEEPSEEK_API_KEY, or OPENAI_API_KEY',
    );
  }

  const languageHint = options.languageHint
    ? `\nLanguage hint: ${options.languageHint}`
    : '';

  const filenameHint = options.filename
    ? `\nFilename: ${options.filename}`
    : '';

  const prompt =
    `Analyze this mainframe source code and extract the semantic structure as JSON.${languageHint}${filenameHint}\n\n` +
    `Source code:\n\`\`\`\n${source}\n\`\`\``;

  const startTime = Date.now();

  const response = await generate({
    prompt,
    systemContext: SYSTEM_PROMPT,
    maxTokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.1,
  });

  const latencyMs = Date.now() - startTime;

  // Parse the LLM response as JSON
  const parsed = extractJSON(response.text);

  // Convert to AST + SemanticTree
  const ast = buildASTFromLLMResponse(parsed, source);
  const semanticTree = buildSemanticTreeFromLLMResponse(parsed);

  return {
    programName: String(parsed.programName ?? 'UNKNOWN'),
    detectedLanguage: String(parsed.detectedLanguage ?? options.languageHint ?? 'unknown'),
    ast,
    semanticTree,
    llmTokensUsed: response.tokensGenerated + response.promptTokens,
    llmLatencyMs: latencyMs,
  };
}

// ── JSON Extraction ────────────────────────────────────

/**
 * Extract JSON from LLM response text. Handles:
 * - Raw JSON
 * - JSON wrapped in ```json ... ```
 * - JSON with leading/trailing text
 */
function extractJSON(text: string): Record<string, unknown> {
  // Try raw JSON first
  try {
    return JSON.parse(text);
  } catch {
    // Continue to other strategies
  }

  // Try extracting from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {
      // Continue
    }
  }

  // Try finding first { to last }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.substring(firstBrace, lastBrace + 1));
    } catch {
      // Continue
    }
  }

  // Last resort: return empty structure
  return {
    programName: 'UNKNOWN',
    detectedLanguage: 'unknown',
    functions: [],
    variables: [],
    dataAccess: [],
    externalCalls: [],
  };
}

// ── AST Construction ───────────────────────────────────

function buildASTFromLLMResponse(
  parsed: Record<string, unknown>,
  source: string,
): ASTNode {
  const totalLines = source.split(/\r?\n/).length;
  const children: ASTNode[] = [];

  // Convert functions to AST nodes
  const functions = (parsed.functions ?? []) as Array<Record<string, unknown>>;
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    const type = mapFunctionTypeToASTNode(String(fn.type ?? 'GENERAL'));

    children.push({
      type,
      name: String(fn.name ?? `BLOCK_${i + 1}`),
      children: [],
      meta: {
        description: String(fn.description ?? ''),
        domain: String(fn.domain ?? 'General'),
        inputs: fn.inputs ?? [],
        outputs: fn.outputs ?? [],
        sideEffects: fn.sideEffects ?? [],
        calls: fn.calls ?? [],
        source: 'llm-fallback',
      },
      loc: { startLine: 1, endLine: totalLines },
    });
  }

  // Convert variables to AST nodes
  const variables = (parsed.variables ?? []) as Array<Record<string, unknown>>;
  for (const v of variables) {
    children.push({
      type: ASTNodeType.COBOL_VARIABLE_NODE, // Reuse for variable-like nodes
      name: String(v.name ?? 'UNKNOWN'),
      children: [],
      meta: {
        dataType: String(v.type ?? ''),
        usage: String(v.usage ?? ''),
        source: 'llm-fallback',
      },
      loc: { startLine: 1, endLine: 1 },
    });
  }

  return {
    type: ASTNodeType.COBOL_PROGRAM, // Root type — language-neutral wrapper
    name: String(parsed.programName ?? 'UNKNOWN'),
    children,
    meta: {
      language: String(parsed.detectedLanguage ?? 'unknown'),
      source: 'llm-fallback',
    },
    loc: { startLine: 1, endLine: totalLines },
  };
}

function mapFunctionTypeToASTNode(type: string): ASTNodeType {
  switch (type.toUpperCase()) {
    case 'BUSINESS_RULE': return ASTNodeType.COBOL_IF_NODE;
    case 'DATA_ACCESS': return ASTNodeType.COBOL_EXEC_SQL_NODE;
    case 'DATA_TRANSFORM': return ASTNodeType.COBOL_COMPUTE_NODE;
    case 'CONTROL_FLOW': return ASTNodeType.COBOL_PERFORM_NODE;
    case 'EXTERNAL_CALL': return ASTNodeType.COBOL_CALL_NODE;
    case 'TRANSACTION': return ASTNodeType.COBOL_EXEC_CICS_NODE;
    case 'DATA_DEFINITION': return ASTNodeType.COBOL_VARIABLE_NODE;
    default: return ASTNodeType.COBOL_PARAGRAPH_NODE;
  }
}

// ── Semantic Tree Construction ─────────────────────────

function buildSemanticTreeFromLLMResponse(
  parsed: Record<string, unknown>,
): SemanticNode {
  const children: SemanticNode[] = [];
  let idCounter = 1;

  // Convert functions to semantic nodes
  const functions = (parsed.functions ?? []) as Array<Record<string, unknown>>;
  for (const fn of functions) {
    children.push({
      id: `llm_sem_${idCounter++}`,
      type: mapToSemanticNodeType(String(fn.type ?? 'GENERAL')),
      description: String(fn.description ?? fn.name ?? ''),
      domain: mapToDomain(String(fn.domain ?? 'General')),
      inputs: normalizeStringArray(fn.inputs),
      outputs: normalizeStringArray(fn.outputs),
      sideEffects: normalizeStringArray(fn.sideEffects),
      children: [],
      sourceAST: {
        type: 'LLM_EXTRACTED',
        name: String(fn.name ?? 'UNKNOWN'),
        loc: { startLine: 1, endLine: 1 },
      },
    });
  }

  // Convert data access entries to semantic nodes
  const dataAccess = (parsed.dataAccess ?? []) as Array<Record<string, unknown>>;
  for (const da of dataAccess) {
    children.push({
      id: `llm_sem_${idCounter++}`,
      type: SemanticNodeType.DATA_ACCESS,
      description: String(da.description ?? `${da.operation} ${da.target}`),
      domain: BusinessDomain.GENERAL,
      inputs: da.operation === 'READ' ? [String(da.target ?? '')] : [],
      outputs: da.operation !== 'READ' ? [String(da.target ?? '')] : [],
      sideEffects: da.operation !== 'READ'
        ? [`${String(da.operation ?? 'ACCESS')} ${String(da.target ?? 'UNKNOWN')}`]
        : [],
      children: [],
      sourceAST: {
        type: 'LLM_EXTRACTED',
        name: String(da.target ?? 'UNKNOWN'),
        loc: { startLine: 1, endLine: 1 },
      },
    });
  }

  // Convert external calls to semantic nodes
  const externalCalls = (parsed.externalCalls ?? []) as Array<Record<string, unknown>>;
  for (const ec of externalCalls) {
    children.push({
      id: `llm_sem_${idCounter++}`,
      type: SemanticNodeType.EXTERNAL_CALL,
      description: String(ec.description ?? `Call ${ec.target}`),
      domain: BusinessDomain.GENERAL,
      inputs: [],
      outputs: [],
      sideEffects: [`Calls ${String(ec.target ?? 'UNKNOWN')}`],
      children: [],
      sourceAST: {
        type: 'LLM_EXTRACTED',
        name: String(ec.target ?? 'UNKNOWN'),
        loc: { startLine: 1, endLine: 1 },
      },
    });
  }

  return {
    id: 'llm_sem_0',
    type: SemanticNodeType.WORKFLOW,
    description: `${String(parsed.detectedLanguage ?? 'Unknown')} program: ${String(parsed.programName ?? 'UNKNOWN')}`,
    domain: inferDomainFromChildren(children),
    inputs: children.flatMap((c) => c.inputs),
    outputs: children.flatMap((c) => c.outputs),
    sideEffects: children.flatMap((c) => c.sideEffects),
    children,
    sourceAST: {
      type: 'LLM_EXTRACTED',
      name: String(parsed.programName ?? 'UNKNOWN'),
      loc: { startLine: 1, endLine: 1 },
    },
  };
}

function mapToSemanticNodeType(type: string): SemanticNodeType {
  const map: Record<string, SemanticNodeType> = {
    BUSINESS_RULE: SemanticNodeType.BUSINESS_RULE,
    DATA_ACCESS: SemanticNodeType.DATA_ACCESS,
    DATA_TRANSFORM: SemanticNodeType.DATA_TRANSFORM,
    CONTROL_FLOW: SemanticNodeType.CONTROL_FLOW,
    EXTERNAL_CALL: SemanticNodeType.EXTERNAL_CALL,
    TRANSACTION: SemanticNodeType.TRANSACTION,
    DATA_DEFINITION: SemanticNodeType.DATA_DEFINITION,
    GENERAL: SemanticNodeType.GENERAL,
  };
  return map[type.toUpperCase()] ?? SemanticNodeType.GENERAL;
}

function mapToDomain(domain: string): BusinessDomain {
  const map: Record<string, BusinessDomain> = {
    'Taxation': BusinessDomain.TAXATION,
    'Payments': BusinessDomain.PAYMENTS,
    'Risk Assessment': BusinessDomain.RISK,
    'Customer Management': BusinessDomain.CUSTOMER,
    'Account Management': BusinessDomain.ACCOUNT,
    'Audit & Compliance': BusinessDomain.AUDIT,
    'Reporting': BusinessDomain.REPORTING,
    'Authentication': BusinessDomain.AUTHENTICATION,
    'Pricing': BusinessDomain.PRICING,
    'General': BusinessDomain.GENERAL,
  };
  return map[domain] ?? BusinessDomain.GENERAL;
}

function inferDomainFromChildren(children: SemanticNode[]): BusinessDomain {
  const counts = new Map<BusinessDomain, number>();
  for (const child of children) {
    counts.set(child.domain, (counts.get(child.domain) ?? 0) + 1);
  }
  // Return the most frequent non-GENERAL domain
  let best = BusinessDomain.GENERAL;
  let bestCount = 0;
  for (const [domain, count] of counts) {
    if (domain !== BusinessDomain.GENERAL && count > bestCount) {
      best = domain;
      bestCount = count;
    }
  }
  return best;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

// ── Dynamic Import ─────────────────────────────────────
// The parser package doesn't directly depend on src/model/provider.ts.
// We load it dynamically at runtime to keep the parser portable.

async function loadModelProvider(): Promise<{
  generate: (req: { prompt: string; systemContext?: string; maxTokens?: number; temperature?: number }) => Promise<{ text: string; tokensGenerated: number; promptTokens: number }>;
  detectModelConfig: () => { provider: string };
}> {
  try {
    // Try loading from compiled dist first, then from source
    const path = require('path');
    const possiblePaths = [
      path.resolve(__dirname, '../../dist/model/provider'),
      path.resolve(__dirname, '../../src/model/provider'),
    ];

    for (const p of possiblePaths) {
      try {
        const mod = require(p);
        if (mod.generate && mod.detectModelConfig) return mod;
      } catch {
        continue;
      }
    }

    throw new Error('Model provider module not found');
  } catch (err) {
    throw new Error(
      `LLM fallback parser could not load model provider: ${err}. ` +
      'Ensure agentsmcp is built (npm run build) or running from source.',
    );
  }
}

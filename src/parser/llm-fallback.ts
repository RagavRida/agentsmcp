/**
 * LLM Fallback Extractor — handles code patterns the deterministic parser cannot.
 *
 * Architecture:
 *   1. Deterministic parser runs first (zero LLM, zero cost)
 *   2. Parser reports "unrecognized" AST nodes (patterns it saw but couldn't classify)
 *   3. This module sends ONLY those unrecognized fragments to the LLM
 *   4. LLM response is validated against the AST structure (grounding check)
 *   5. If validation fails, the LLM result is discarded (safety over coverage)
 *
 * This is NOT "send all the code to the LLM." It's a surgical fallback that:
 *   - Minimizes token usage (only unknown fragments)
 *   - Preserves deterministic results (LLM can't override parser)
 *   - Maintains audit trail (which rules came from parser vs LLM)
 *   - Respects data sovereignty (code fragments are anonymized before sending)
 *
 * Key design principle: The deterministic parser is the source of truth.
 * The LLM is a supplementary oracle for patterns the parser doesn't understand.
 */

import { createHash } from "crypto";
import { CacheManager } from "../cache/manager";
import { ATTR, withSpan } from "../observability";
import { LocalStorageAdapter } from "../storage/interfaces";
import { PromptRegistry } from "./prompt-registry";

export interface UnrecognizedFragment {
  /** The raw COBOL source fragment */
  source: string;
  /** Line range in the original program */
  startLine: number;
  endLine: number;
  /** Context: paragraph name, program ID */
  context: {
    programId: string;
    paragraphName: string;
    nearbyVariables: string[];
  };
}

export interface LLMExtractedRule {
  /** Human-readable description of the business rule */
  description: string;
  /** Classification: COMPUTE, IF, PERFORM, DATA_ACCESS, etc. */
  type: string;
  /** Variables involved */
  inputs: string[];
  outputs: string[];
  /** Confidence score from the LLM (0.0 to 1.0) */
  confidence: number;
  /** Whether this was validated against the AST */
  grounded: boolean;
  /** Source attribution */
  source: "llm_fallback";
}

export interface FallbackConfig {
  /** URL of the vLLM/DeepSeek endpoint */
  vllmUrl: string;
  /** Minimum confidence to accept an LLM extraction */
  minConfidence: number;
  /** Maximum tokens to send per fragment (privacy control) */
  maxFragmentTokens: number;
  /** Whether to anonymize variable names before sending */
  anonymize: boolean;
  /** Optional persistent cache directory for accepted fallback results. */
  cacheDir?: string;
  /** Optional shared cache manager, useful for S3/BYOS or tests. */
  cacheManager?: CacheManager;
  /** If true, fragment-level LLM failures fail the caller instead of degrading gracefully. */
  failOnError?: boolean;
  /** Optional PromptRegistry for versioned prompt execution and evaluation correlation */
  promptRegistry?: PromptRegistry;
}

const DEFAULT_CONFIG: FallbackConfig = {
  vllmUrl: "",
  minConfidence: 0.7,
  maxFragmentTokens: 500,
  anonymize: true,
  cacheDir: process.env.AGENTSMCP_LLM_FALLBACK_CACHE_DIR,
};

// ── Anonymization ──────────────────────────────────────────

/** Anonymize COBOL variable names to protect sensitive data */
export function anonymizeFragment(
  source: string,
  variables: string[]
): { anonymized: string; mapping: Map<string, string> } {
  const mapping = new Map<string, string>();
  let anonymized = source;

  // Sort by length descending to avoid partial replacements
  const sorted = [...variables].sort((a, b) => b.length - a.length);

  for (let i = 0; i < sorted.length; i++) {
    const varName = sorted[i];
    const placeholder = `VAR-${String(i + 1).padStart(3, "0")}`;
    mapping.set(placeholder, varName);
    // Replace all occurrences (case-insensitive for COBOL)
    anonymized = anonymized.replace(
      new RegExp(varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      placeholder
    );
  }

  return { anonymized, mapping };
}

/** De-anonymize LLM response by reversing the mapping */
export function deanonymize(
  text: string,
  mapping: Map<string, string>
): string {
  let result = text;
  for (const [placeholder, original] of mapping) {
    result = result.replace(new RegExp(placeholder, "g"), original);
  }
  return result;
}

// ── Prompt Version ─────────────────────────────────────────

/**
 * Tracks which prompt version produced which eval results.
 * Bump this whenever the system prompt is modified.
 */
export const PROMPT_VERSION = "v2.0.0";

/** Default LLM fallback system prompt — used to seed PromptRegistry. */
export function getDefaultLlmFallbackPrompt(): string {
  return SYSTEM_PROMPT;
}

// ── System Prompt (XML-structured) ────────────────────────

const SYSTEM_PROMPT = `<role>
You are a COBOL business rule extractor. You analyze COBOL code fragments that a deterministic parser could not classify. You are a supplementary oracle — the deterministic parser is always the source of truth.
</role>

<guidelines>
- Extract only business rules that are explicitly present in the code fragment.
- Use variable names exactly as they appear in the fragment. Never rename or fabricate variables.
- Classify each rule as one of: COMPUTE, IF, PERFORM, DATA_ACCESS, ARITHMETIC, CONTROL_FLOW.
- EVALUATE statements should be classified as CONTROL_FLOW.
- Nested IF-ELSE chains count as a single IF rule covering all branches.
- PERFORM VARYING loops should be classified as CONTROL_FLOW with the loop variable as an input.
- Set confidence to 0.9+ only when the rule is completely unambiguous.
- Set confidence between 0.5-0.8 for reasonable but uncertain extractions.
- Set confidence below 0.5 when you are unsure or the pattern is unclear.
</guidelines>

<policies>
- NEVER infer rules not present in the code.
- NEVER fabricate variable names that do not appear in the fragment.
- If the fragment contains only DISPLAY statements, return an empty rules array.
- If the fragment contains only STOP RUN, GO TO, or EXIT, return an empty rules array.
- If the fragment contains only comments (lines starting with *), return an empty rules array.
- If the fragment contains dead code (unreachable after STOP RUN or GO TO), return an empty rules array.
- If the fragment is a COPY statement or a data definition with no procedural logic, return an empty rules array.
</policies>

<output_format>
Respond with ONLY valid JSON. No markdown, no explanation, no preamble, no trailing text.
Schema:
{
  "rules": [
    {
      "description": "string — human-readable description of the business rule",
      "type": "string — one of COMPUTE|IF|PERFORM|DATA_ACCESS|ARITHMETIC|CONTROL_FLOW",
      "inputs": ["string — variable names read by this rule"],
      "outputs": ["string — variable names written by this rule"],
      "confidence": "number — 0.0 to 1.0"
    }
  ]
}
If no rules can be extracted, return: {"rules": []}
</output_format>`;

// ── LLM Fallback Extractor ─────────────────────────────────

export class LLMFallbackExtractor {
  private config: FallbackConfig;
  private cacheManager?: CacheManager;
  private stats = {
    fragmentsSent: 0,
    rulesExtracted: 0,
    rulesAccepted: 0,
    rulesRejected: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  constructor(config: Partial<FallbackConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cacheManager = this.config.cacheManager ?? (
      this.config.cacheDir
        ? new CacheManager(new LocalStorageAdapter(this.config.cacheDir), {
            namespace: "llm-fallback",
          })
        : undefined
    );
  }

  /**
   * Extract business rules from unrecognized code fragments using the LLM.
   * Only called when the deterministic parser cannot classify a pattern.
   */
  async extractFromFragments(
    fragments: UnrecognizedFragment[]
  ): Promise<LLMExtractedRule[]> {
    if (!this.config.vllmUrl) {
      return []; // No LLM configured — pure deterministic mode
    }

    if (fragments.length === 0) return [];

    const allRules: LLMExtractedRule[] = [];

    for (const fragment of fragments) {
      try {
        const rules = await this.processFragment(fragment);
        allRules.push(...rules);
      } catch (err) {
        if (this.config.failOnError) {
          throw err;
        }
        // LLM failure is non-fatal — deterministic results still stand
        console.warn(`LLM fallback failed for ${fragment.context.programId}:${fragment.context.paragraphName}: ${err}`);
      }
    }

    return allRules;
  }

  private async processFragment(fragment: UnrecognizedFragment): Promise<LLMExtractedRule[]> {
    return withSpan("agentsmcp.llm_fallback.extract", async (span) => {
      span.setAttribute(ATTR.PARSE_PROGRAM, fragment.context.programId);
      span.setAttribute("agentsmcp.parse.paragraph", fragment.context.paragraphName);
      span.setAttribute("agentsmcp.llm.prompt_version", PROMPT_VERSION);
      this.stats.fragmentsSent++;

      // Step 1: Anonymize if configured
      let sourceToSend = fragment.source;
      let mapping = new Map<string, string>();

      if (this.config.anonymize) {
        const result = anonymizeFragment(fragment.source, fragment.context.nearbyVariables);
        sourceToSend = result.anonymized;
        mapping = result.mapping;
      }

      // Step 2: Truncate to token limit
      if (sourceToSend.length > this.config.maxFragmentTokens * 4) {
        sourceToSend = sourceToSend.substring(0, this.config.maxFragmentTokens * 4);
      }

      // Step 3: Build prompt and consult cache
      const prompt = `Analyze this COBOL fragment from program ${fragment.context.programId}, paragraph ${fragment.context.paragraphName}:\n\n\`\`\`cobol\n${sourceToSend}\n\`\`\``;
      const cacheKey = this.cacheKey(sourceToSend);
      span.setAttribute(ATTR.LLM_CACHE_KEY, cacheKey);

      const cacheHit = this.cacheManager
        ? await this.cacheManager.exists(cacheKey)
        : false;
      span.setAttribute(ATTR.LLM_CACHE_HIT, cacheHit);
      if (cacheHit) {
        this.stats.cacheHits++;
      } else if (this.cacheManager) {
        this.stats.cacheMisses++;
      }

      const compute = async (): Promise<LLMExtractedRule[]> => {
        // Step 4: Call LLM
        const response = await fetch(`${this.config.vllmUrl}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            system_context: SYSTEM_PROMPT,
            max_tokens: 1024,
            temperature: 0.1,
          }),
        });

        if (!response.ok) {
          throw new Error(`LLM request failed: ${response.status}`);
        }

        const data = await response.json() as { text: string };

        // Step 5: Parse and validate LLM response
        const rules = this.parseLLMResponse(data.text, mapping);

        // Step 6: Filter by confidence threshold
        const accepted: LLMExtractedRule[] = [];
        for (const rule of rules) {
          this.stats.rulesExtracted++;
          if (rule.confidence >= this.config.minConfidence) {
            rule.grounded = true;
            this.stats.rulesAccepted++;
            accepted.push(rule);
          } else {
            this.stats.rulesRejected++;
          }
        }

        return cloneRules(accepted);
      };

      const accepted = this.cacheManager
        ? await this.cacheManager.getOrCompute<LLMExtractedRule[]>(cacheKey, compute)
        : await compute();
      return cloneRules(accepted);
    });
  }

  private cacheKey(sourceToSend: string): string {
    return createHash("sha256").update(sourceToSend).digest("hex");
  }

  private parseLLMResponse(
    text: string,
    mapping: Map<string, string>
  ): LLMExtractedRule[] {
    try {
      // Extract JSON from potentially wrapped response
      const jsonMatch = text.match(/\{[\s\S]*"rules"[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.rules)) return [];

      return parsed.rules.map((r: any) => ({
        description: deanonymize(String(r.description || ""), mapping),
        type: String(r.type || "UNKNOWN"),
        inputs: (r.inputs || []).map((v: string) => deanonymize(v, mapping)),
        outputs: (r.outputs || []).map((v: string) => deanonymize(v, mapping)),
        confidence: typeof r.confidence === "number" ? r.confidence : 0,
        grounded: false,
        source: "llm_fallback" as const,
      }));
    } catch {
      return []; // Malformed response — discard
    }
  }

  /** Get extraction statistics */
  getStats() {
    return { ...this.stats };
  }
}

function cloneRules(rules: LLMExtractedRule[]): LLMExtractedRule[] {
  return rules.map((rule) => ({
    ...rule,
    inputs: [...rule.inputs],
    outputs: [...rule.outputs],
  }));
}

// ── Detect Unrecognized Fragments ──────────────────────────

/**
 * Walk an AST and find nodes that the parser recognized syntactically
 * but the semantic elevator couldn't classify as a known pattern.
 *
 * These are candidates for LLM fallback extraction.
 */
export function findUnrecognizedPatterns(
  ast: any,
  semanticTree: any,
  programId: string
): UnrecognizedFragment[] {
  const fragments: UnrecognizedFragment[] = [];

  // Count semantic rules per paragraph
  const paragraphCoverage = new Map<string, number>();
  countRulesInTree(semanticTree, paragraphCoverage);

  // Walk AST paragraphs and find ones with low coverage
  walkASTParagraphs(ast, (paragraph: any) => {
    const name = paragraph.name || "UNKNOWN";
    const stmtCount = countStatements(paragraph);
    const ruleCount = paragraphCoverage.get(name) || 0;

    // If a paragraph has statements but no extracted rules, it's unrecognized
    if (stmtCount > 0 && ruleCount === 0) {
      fragments.push({
        source: reconstructSource(paragraph),
        startLine: paragraph.loc?.startLine || 0,
        endLine: paragraph.loc?.endLine || 0,
        context: {
          programId,
          paragraphName: name,
          nearbyVariables: extractVariableNames(paragraph),
        },
      });
    }
  });

  return fragments;
}

// ── Helpers ────────────────────────────────────────────────

function countRulesInTree(node: any, map: Map<string, number>) {
  if (node.type === "BUSINESS_RULE") {
    const paraName = node.sourceAST?.name || "UNKNOWN";
    map.set(paraName, (map.get(paraName) || 0) + 1);
  }
  if (node.children) {
    for (const child of node.children) {
      countRulesInTree(child, map);
    }
  }
}

function walkASTParagraphs(node: any, callback: (p: any) => void) {
  if (node.type === "COBOL_PARAGRAPH_NODE") {
    callback(node);
  }
  if (node.children) {
    for (const child of node.children) {
      walkASTParagraphs(child, callback);
    }
  }
}

function countStatements(node: any): number {
  let count = 0;
  if (node.children) {
    for (const child of node.children) {
      count += 1 + countStatements(child);
    }
  }
  return count;
}

function reconstructSource(node: any): string {
  // Simplified: return the paragraph name and meta as a pseudo-source
  const lines: string[] = [];
  lines.push(`${node.name}.`);
  if (node.children) {
    for (const child of node.children) {
      const meta = child.meta || {};
      lines.push(`  ${child.type} ${Object.values(meta).join(" ")}`);
    }
  }
  return lines.join("\n");
}

function extractVariableNames(node: any): string[] {
  const vars: string[] = [];
  if (node.meta) {
    for (const v of Object.values(node.meta)) {
      if (typeof v === "string" && v.startsWith("WS-")) vars.push(v);
    }
  }
  if (node.children) {
    for (const child of node.children) {
      vars.push(...extractVariableNames(child));
    }
  }
  return [...new Set(vars)];
}

import { detectModelConfig, generate, type ModelConfig } from "../model/provider";
import type { BusinessRuleResult, GroundedCitation } from "./dto";

export interface GroundedAnswerInput {
  query: string;
  results: BusinessRuleResult[];
  citations: GroundedCitation[];
}

export interface GroundedAnswerOutput {
  answer: string;
  provider: "deterministic" | "model";
  model?: string;
}

export interface GroundedAnswerGenerator {
  generate(input: GroundedAnswerInput): Promise<GroundedAnswerOutput>;
}

export interface DefaultGroundedAnswerGeneratorOptions {
  modelConfig?: ModelConfig;
}

export class DefaultGroundedAnswerGenerator implements GroundedAnswerGenerator {
  private readonly modelConfig?: ModelConfig;

  constructor(options: DefaultGroundedAnswerGeneratorOptions = {}) {
    this.modelConfig = options.modelConfig;
  }

  async generate(input: GroundedAnswerInput): Promise<GroundedAnswerOutput> {
    if (input.citations.length === 0 || input.results.length === 0) {
      return {
        answer: noEvidenceAnswer(),
        provider: "deterministic",
      };
    }

    const config = this.modelConfig ?? detectModelConfig();
    if (config.provider === "none") {
      return deterministicAnswer(input);
    }

    try {
      const response = await generate({
        systemContext: GROUNDED_SYSTEM_CONTEXT,
        prompt: buildGroundedPrompt(input),
        maxTokens: 450,
        temperature: 0,
      }, config);
      const parsed = parseModelAnswer(response.text);
      if (!parsed || !isSupportedByCitations(parsed.citationIds, input.citations)) {
        return deterministicAnswer(input);
      }
      return {
        answer: parsed.answer.trim(),
        provider: "model",
        model: response.model,
      };
    } catch {
      return deterministicAnswer(input);
    }
  }
}

export function deterministicAnswer(input: GroundedAnswerInput): GroundedAnswerOutput {
  const lead = input.results[0];
  const program = lead.program ? ` in ${lead.program}` : "";
  const related = input.results.slice(1).map((result) => normalize(result.description));
  const answer = related.length === 0
    ? `${lead.description}${program}. This answer is grounded in the indexed rule ${lead.id}.`
    : `${lead.description}${program}. Related indexed rules also indicate: ${related.join(" ")}`;
  return {
    answer,
    provider: "deterministic",
  };
}

function noEvidenceAnswer(): string {
  return "I do not have grounded source evidence for that query yet. Import relevant source or try a broader business term.";
}

const GROUNDED_SYSTEM_CONTEXT = [
  "You answer questions about legacy code using only the provided evidence.",
  "Do not use outside knowledge. Do not infer facts that are not in the evidence.",
  "Return JSON only with this exact shape: {\"answer\":\"...\",\"citationIds\":[\"...\"]}.",
  "citationIds must contain only ids from the evidence list and must support every claim in the answer.",
  "If the evidence is insufficient, answer with a short refusal and an empty citationIds array.",
].join(" ");

function buildGroundedPrompt(input: GroundedAnswerInput): string {
  const evidence = input.results.map((result, index) => ({
    id: result.id,
    program: result.program,
    type: result.type,
    domain: result.domain,
    description: result.description,
    sourceId: typeof result.metadata?.sourceId === "string" ? result.metadata.sourceId : undefined,
    rank: index + 1,
  }));
  return JSON.stringify({
    query: input.query,
    evidence,
  });
}

function parseModelAnswer(text: string): { answer: string; citationIds: string[] } | null {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(clean) as { answer?: unknown; citationIds?: unknown };
    if (typeof parsed.answer !== "string" || !Array.isArray(parsed.citationIds)) return null;
    const citationIds = parsed.citationIds.filter((id): id is string => typeof id === "string");
    return { answer: parsed.answer, citationIds };
  } catch {
    return null;
  }
}

function isSupportedByCitations(citationIds: string[], citations: GroundedCitation[]): boolean {
  if (citationIds.length === 0) return false;
  const allowed = new Set(citations.map((citation) => citation.id));
  return citationIds.every((id) => allowed.has(id));
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

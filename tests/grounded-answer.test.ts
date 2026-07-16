import { beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultGroundedAnswerGenerator } from "../src/api/grounded-answer";
import * as provider from "../src/model/provider";

vi.mock("../src/model/provider", () => ({
  detectModelConfig: vi.fn(),
  generate: vi.fn(),
}));

const MODEL_CONFIG: provider.ModelConfig = {
  provider: "vllm",
  baseUrl: "http://localhost:8000",
  model: "zai-org/GLM-5.2-FP8",
  openaiCompatible: true,
};

const INPUT = {
  query: "How is interest calculated?",
  results: [
    {
      id: "rule-interest",
      program: "LOAN-CALC",
      type: "BUSINESS_RULE",
      domain: "Risk",
      description: "Calculate monthly interest from principal and rate",
      metadata: { sourceId: "tenant-a/LOAN.CBL", tenantId: "tenant-a" },
    },
  ],
  citations: [
    {
      id: "rule-interest",
      label: "Calculate monthly interest from principal and rate",
      program: "LOAN-CALC",
      type: "BUSINESS_RULE",
      domain: "Risk",
      sourceId: "tenant-a/LOAN.CBL",
    },
  ],
};

describe("DefaultGroundedAnswerGenerator", () => {
  beforeEach(() => {
    vi.mocked(provider.detectModelConfig).mockReturnValue(MODEL_CONFIG);
    vi.mocked(provider.generate).mockReset();
  });

  it("uses configured models only with supplied grounded evidence", async () => {
    vi.mocked(provider.generate).mockResolvedValue({
      text: JSON.stringify({
        answer: "Interest is calculated monthly from principal and rate.",
        citationIds: ["rule-interest"],
      }),
      model: MODEL_CONFIG.model,
      provider: "vllm",
      tokensGenerated: 12,
      promptTokens: 80,
      latencyMs: 15,
    });

    const result = await new DefaultGroundedAnswerGenerator().generate(INPUT);

    expect(result).toMatchObject({
      answer: "Interest is calculated monthly from principal and rate.",
      provider: "model",
      model: MODEL_CONFIG.model,
    });
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 0,
      prompt: expect.stringContaining("tenant-a/LOAN.CBL"),
    }), MODEL_CONFIG);
    expect(vi.mocked(provider.generate).mock.calls[0][0].prompt).not.toContain("tenant-b");
  });

  it("does not call the model when evidence is empty", async () => {
    const result = await new DefaultGroundedAnswerGenerator().generate({
      query: "unknown",
      results: [],
      citations: [],
    });

    expect(provider.generate).not.toHaveBeenCalled();
    expect(result.provider).toBe("deterministic");
    expect(result.answer).toContain("I do not have grounded source evidence");
  });

  it("falls back when the model cites unsupported evidence", async () => {
    vi.mocked(provider.generate).mockResolvedValue({
      text: JSON.stringify({
        answer: "Unsupported answer using another file.",
        citationIds: ["other-tenant-rule"],
      }),
      model: MODEL_CONFIG.model,
      provider: "vllm",
      tokensGenerated: 8,
      promptTokens: 80,
      latencyMs: 10,
    });

    const result = await new DefaultGroundedAnswerGenerator().generate(INPUT);

    expect(result.provider).toBe("deterministic");
    expect(result.answer).toContain("Calculate monthly interest from principal and rate");
  });
});

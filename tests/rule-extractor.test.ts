import { describe, expect, it, vi } from "vitest";
import { extractLearnedRules } from "../src/agent/rule-extractor";
import * as provider from "../src/model/provider";

vi.mock("../src/model/provider", () => ({
  generate: vi.fn(),
}));

describe("Rule Extractor", () => {
  it("extracts and parses valid rules from LLM response", async () => {
    vi.mocked(provider.generate).mockResolvedValueOnce({
      text: JSON.stringify({
        rules: [
          {
            description: "Always use COMP-3 for financial amounts.",
            category: "business_logic",
          },
          {
            description: "Prefer snake_case for new variables.",
            category: "style",
          },
        ],
      }),
      model: "test-model",
      tokens: { prompt: 10, completion: 20 },
    });

    const transcript = "User: Make sure to use COMP-3 for money and snake_case for vars.";
    const rules = await extractLearnedRules(transcript, "ast-node-123");

    expect(rules).toHaveLength(2);
    expect(rules[0].description).toBe("Always use COMP-3 for financial amounts.");
    expect(rules[0].category).toBe("business_logic");
    expect(rules[0].astNodeId).toBe("ast-node-123");
    expect(rules[0].id).toBeDefined();
    
    expect(rules[1].description).toBe("Prefer snake_case for new variables.");
    expect(rules[1].category).toBe("style");
  });

  it("handles markdown code blocks in LLM response", async () => {
    vi.mocked(provider.generate).mockResolvedValueOnce({
      text: `\`\`\`json
{
  "rules": [
    {
      "description": "Dates must be YYYY-MM-DD",
      "category": "architecture"
    }
  ]
}
\`\`\``,
      model: "test-model",
      tokens: { prompt: 10, completion: 20 },
    });

    const rules = await extractLearnedRules("Use YYYY-MM-DD for dates");
    expect(rules).toHaveLength(1);
    expect(rules[0].category).toBe("architecture");
    expect(rules[0].astNodeId).toBeUndefined();
  });

  it("returns empty array on invalid JSON", async () => {
    vi.mocked(provider.generate).mockResolvedValueOnce({
      text: "Sorry, I cannot extract rules.",
      model: "test-model",
      tokens: { prompt: 10, completion: 20 },
    });

    const rules = await extractLearnedRules("Blah blah");
    expect(rules).toHaveLength(0);
  });
});

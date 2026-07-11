import { v4 as uuidv4 } from "uuid";
import { generate } from "../model/provider";
import { LearnedRule } from "../storage/interface";

export async function extractLearnedRules(
  chatTranscript: string,
  astNodeId?: string
): Promise<LearnedRule[]> {
  const systemContext = `
<role>
You are an expert AI agent designed to extract persistent Coding Rules from conversations between a developer and an AI assistant.
Your goal is to actively learn the user's specific coding habits, architectural decisions, and domain business logic from their corrections and instructions.
</role>

<guidelines>
- Extract explicit rules or conventions that the user wants the AI to follow in the future.
- Categorize each rule as one of: "style", "architecture", "business_logic", "migration".
- Focus on generalizable rules (e.g., "Use COMP-3 for financial amounts" or "Date formats must be YYYY-MM-DD").
- Ignore casual conversation, one-off bug fixes, or code snippets that don't represent a reusable rule.
- If the user correcting the agent says something like "In our codebase we always do X", that is a perfect rule.
</guidelines>

<output_format>
Respond with ONLY valid JSON. No markdown backticks, no explanations.
Schema:
{
  "rules": [
    {
      "description": "The extracted coding rule or convention",
      "category": "style|architecture|business_logic|migration"
    }
  ]
}
If no reusable rules can be extracted, return: {"rules": []}
</output_format>
`;

  const prompt = `Analyze the following chat transcript and extract any learned rules:\n\n${chatTranscript}`;

  try {
    const response = await generate({
      prompt,
      systemContext,
      temperature: 0.1, // Low temp for structured extraction
    });

    let text = response.text.trim();
    
    // Strip markdown code blocks if the model ignored instructions
    if (text.startsWith("\`\`\`json")) {
      text = text.substring(7);
      if (text.endsWith("\`\`\`")) {
        text = text.substring(0, text.length - 3);
      }
    } else if (text.startsWith("\`\`\`")) {
      text = text.substring(3);
      if (text.endsWith("\`\`\`")) {
        text = text.substring(0, text.length - 3);
      }
    }

    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.rules)) {
      return [];
    }

    const rules: LearnedRule[] = [];
    const now = Date.now();

    for (const rule of parsed.rules) {
      if (typeof rule.description === "string" && typeof rule.category === "string") {
        rules.push({
          id: uuidv4(),
          description: rule.description,
          category: rule.category as "style" | "architecture" | "business_logic" | "migration",
          astNodeId,
          createdAt: now,
        });
      }
    }

    return rules;
  } catch (err) {
    console.error("[RuleExtractor] Failed to extract rules:", err);
    return [];
  }
}

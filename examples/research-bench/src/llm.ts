/**
 * LLM wrapper used by both agents. Calls Anthropic if ANTHROPIC_API_KEY is
 * set; otherwise falls back to clearly-labeled stub responses so the demo
 * runs offline / in CI without an API key.
 */

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

if (!HAS_KEY) {
  process.stderr.write(
    "[demo] ANTHROPIC_API_KEY unset — using stub responses\n"
  );
}

export interface LlmReply {
  text: string;
  stub: boolean;
}

export async function complete(system: string, prompt: string): Promise<LlmReply> {
  if (!HAS_KEY) {
    return { text: stubReply(system, prompt), stub: true };
  }
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const parts = resp.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  return { text: parts.trim(), stub: false };
}

function stubReply(system: string, prompt: string): string {
  const role = system.toLowerCase();
  const topic = prompt.slice(0, 80).replace(/\n/g, " ");
  if (role.includes("explor")) {
    return [
      "[STUB] Three angles worth investigating:",
      "  1. Theoretical foundations — formalisms and convergence guarantees.",
      "  2. Empirical scaling — how performance changes with model size.",
      "  3. Failure modes — known limitations and adversarial cases.",
      `(stubbed; topic was: ${topic}...)`,
    ].join("\n");
  }
  return [
    "[STUB] Running summary updated:",
    "The thread covers three open angles (theory, scaling, failure modes).",
    "Latest finding adds detail to the second angle. No open contradictions.",
    `(stubbed; input was: ${topic}...)`,
  ].join("\n");
}

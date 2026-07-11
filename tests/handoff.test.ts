import { describe, expect, it } from "vitest";
import { buildHandoffContext } from "../src/handoff/context-builder";
import type { Message } from "../src/types";

const message = (payload: unknown, contextSnapshot: Record<string, unknown>): Message => ({
  id: "m1",
  threadId: "t1",
  from: "planner@test",
  to: "builder@test",
  payload,
  contextSnapshot,
  timestamp: 1,
});

describe("buildHandoffContext", () => {
  it("creates a compact task packet from selected context and summary", () => {
    const result = buildHandoffContext({
      sourceThreadId: "t1",
      messages: [message({ task: "Implement the parser" }, {
        relevantFile: "src/parser.ts",
        internalNote: "do not forward",
        unrelated: "omit me",
      })],
      summary: {
        text: "",
        decisions: ["Use the existing parser registry"],
        openQuestions: ["Which copybooks are required?"],
        artifacts: { issue: "AM-42" },
        coversMessageIds: ["m1"],
        generatedAt: 1,
      },
      options: { includeFields: ["relevantFile"] },
    });

    expect(result).toMatchObject({
      version: 1,
      goal: "Implement the parser",
      context: { relevantFile: "src/parser.ts" },
      decisions: ["Use the existing parser registry"],
      openQuestions: ["Which copybooks are required?"],
      artifacts: { issue: "AM-42" },
      sourceThreadId: "t1",
    });
    expect(result.context).not.toHaveProperty("internalNote");
    expect(result.context).not.toHaveProperty("unrelated");
  });
});
